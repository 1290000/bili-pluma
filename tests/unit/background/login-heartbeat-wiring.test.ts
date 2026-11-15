// @vitest-environment node

/**
 * 心跳的**写入端**：扫码窗口页面必须真的周期写心跳（task-24）。
 *
 * ## 为什么这条要单独测
 *
 * `login-heartbeat-probe.test.ts` 测的是**读取端**（探测判据、过期、分区分流）。
 * 但整套机制有一条致命的不对称：
 *
 * > 读取端写对了、写入端没写 ⇒ 探测**永远读不到**心跳 ⇒ 退回原来的 bug
 * > （第二次点扫码毫无反应）。
 *
 * 而这条缺失**不会让任何读取端测试变红** —— 它只在真机上表现为"功能没恢复"。
 * 所以必须有一条直接盯住 `entrypoints/login-window/main.tsx` 的断言。
 *
 * ## 为什么是"读源码"而不是"跑组件"
 *
 * `main.tsx` 末尾直接 `render(<App />, root)`，并有 `document.getElementById` ——
 * 在 node 环境下无法安全加载。且本卡禁止重构（把 App 抽成可测模块属于重构）。
 * 这里的判据是纯结构性的（"有没有这段代码"），静态断言能唯一确定它。
 *
 * ⚠️ 同样必须**先剥注释**：注释里提到了这些函数名，
 * 直接在原始文本上 `toContain` 会**假绿**（本卡在别处实测踩过）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RAW_SRC = readFileSync(
  fileURLToPath(new URL('../../../entrypoints/login-window/main.tsx', import.meta.url)),
  'utf8',
);

/** 状态机剥注释（不用单条正则 —— 遇到字符串里的闭合符会跨块吞） */
function stripComments(s: string): string {
  const out: string[] = [];
  let i = 0;
  let inBlock = false;
  while (i < s.length) {
    if (!inBlock && s[i] === '/' && s[i + 1] === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (inBlock && s[i] === '*' && s[i + 1] === '/') {
      inBlock = false;
      i += 2;
      continue;
    }
    if (inBlock) {
      i++;
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    out.push(s[i] ?? '');
    i++;
  }
  return out.join('');
}

const SRC = stripComments(RAW_SRC);

/**
 * 取出心跳那个 effect 的源码（含整个 cleanup 块）。
 *
 * ⚠️ **不许用 `clearLoginHeartbeat` 当结束边界**：在 effect 里
 * `window.clearInterval(timer)` 写在 `void clearLoginHeartbeat()` **之前**，
 * 用前者当边界会把后者切在切片外面 → 明明是产品代码正确、
 * 测试却报「找不到」。（本文件第一版就是这样，自己踩过。）
 *
 * ⚠️ **也不许从 `writeLoginHeartbeat(instance)` 往后配平**：那个调用后面
 * 紧跟 `if (cancelled) return;` 的 `}`，配平会立刻停在 `beat()` 函数体的闭合处，
 * 拿到一个只有一行的切片（第二次踩）。
 *
 * ⚠️ **更不许从锚点往回"回溯到未闭合的 `{`"**：向后看是配平的，回溯会先撞到
 * `beat` 函数体那个已闭合的 `{`，切片只剩 `{ if (cancelled) return; …`（第三次踩）。
 *
 * ⇒ 正确做法：锚定**effect 本身的起点**（`const instance =`），
 * 它前面最近的那个 `useEffect(` 就是我们要的 effect；再往后配平到它的闭合花括号。
 */
function heartbeatEffect(): string {
  const anchor = SRC.indexOf('writeLoginHeartbeat(instance)');
  expect(anchor, '找不到心跳写入 —— 扫码窗口不再写心跳，探测会永远读不到').toBeGreaterThan(-1);

  const open = SRC.lastIndexOf('useEffect(', anchor);
  expect(open, '找不到包裹心跳的 useEffect —— 文件结构变了').toBeGreaterThan(-1);

  let depth = 0;
  let close = -1;
  for (let i = open; i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  expect(close, 'heartbeatEffect() 找不到闭合花括号 —— 文件结构变了').toBeGreaterThan(open);
  return SRC.slice(open, close + 1);
}

describe('★★★ 扫码窗口必须周期写心跳（读取端的前提）', () => {
  it('★★★ 必须调用 `writeLoginHeartbeat`', () => {
    expect(SRC).toContain('writeLoginHeartbeat');
  });

  it('★★★ 必须用 `setInterval` 周期写，**不能只写一次**', () => {
    // 只写一次 = 一次性标记：窗口关掉后标记还在 → 普通实例永远以为"还开着"
    // → 再点扫码永远没反应。这正是 `pluma:login-ready` 不能当心跳的原因。
    const effect = heartbeatEffect();
    expect(effect).toContain('setInterval');
  });
  it('★★★ 间隔必须取自 `LOGIN_HEARTBEAT_INTERVAL_MS`，不许在这里硬编码数字', () => {
    // 硬编码会和 `LOGIN_HEARTBEAT_TTL_MS` 失配（例如写 5 分钟、TTL 90 秒
    // ⇒ 窗口明明开着却被判死；或写 1 秒、TTL 90 秒 ⇒ 白写一堆存储）。
    // 两者的比例关系另有单测（`login-heartbeat-probe.test.ts`）守住。
    const effect = heartbeatEffect();
    expect(effect).toContain('LOGIN_HEARTBEAT_INTERVAL_MS');
  });

  it('★★★ cleanup 必须 `clearInterval`，否则窗口卸载后定时器还在写', () => {
    const cleanupStart = SRC.indexOf('clearLoginHeartbeat()');
    expect(cleanupStart).toBeGreaterThan(-1);
    // cleanup 段里应当同时清定时器
    const tail = SRC.slice(Math.max(0, cleanupStart - 200), cleanupStart + 40);
    expect(tail).toContain('clearInterval');
  });

  it('★★ 卸载时必须 `clearLoginHeartbeat()`', () => {
    const effect = heartbeatEffect();
    expect(effect).toContain('clearLoginHeartbeat');
  });

  /**
   * ## ⚠️ 上面那条（以及本来这条）**证明不了"关窗会清心跳"**
   *
   * 2026-11-15（task-47）实测的失败形态恰恰是：**"卸载时清心跳"这句话是真的
   * 代码、却永远不执行** —— 用户关掉浏览器窗口时文档被直接销毁，
   * React 根本不会卸载组件 ⇒ `useEffect` cleanup 不跑 ⇒ 心跳冻结 ⇒
   * 90 秒内所有点击都报 `already-open` 而屏幕上没有窗口。
   *
   * 所以「源码里有这么一行」是**结构性断言，不是行为断言**。行为在哪守：
   * - **"页面不在 ⇒ 必须建新窗"** → `login-heartbeat-probe.test.ts` 的
   *   「★★★ 冻结的心跳不许再当闸门」那一组（跑真实 `openLoginWindow()`）。
   * - **"页面在 ⇒ 必须应答"** → `login-window-pong.test.ts`。
   *
   * 下面这一组只守一件更弱的事：**兜底事件还被挂着**。删掉它们不会让
   * 行为测试变红（pong 仍然兜得住），但会让下一次点击多等一次 600ms 超时，
   * 且存储里留下垃圾 —— 所以值得钉住，但**别把它当成安全感的来源**。
   */
  it('★★ 清理必须挂在文档销毁事件上（`pagehide` + `beforeunload`），不能只靠 React cleanup', () => {
    /**
     * 🔁 反向验证：删掉这两个 `addEventListener` ⇒ 本条变红。
     *
     * 判据是"两个事件都在**心跳那个 effect** 里"—— 挂到别处（比如另一个
     * effect）会因为拿不到 `timer` 而无法 `clearInterval`，定时器在文档销毁前
     * 还会继续写心跳。
     */
    const effect = heartbeatEffect();
    expect(effect, '没有 pagehide —— 关窗时心跳不会被清').toContain("'pagehide'");
    expect(effect, '没有 beforeunload —— 旧内核下关窗不清心跳').toContain("'beforeunload'");
    // 两个都必须 `addEventListener` 挂上（只写字符串不算）
    expect(effect).toContain('addEventListener');
    // 关闭时必须先停定时器，否则停不下来
    expect(effect).toContain('clearInterval');
  });
});

/**
 * ## 扫码窗口必须应答存活探测（task-47）
 *
 * 普通实例的判据是"页面当场回 pong"。**页面侧不实现这个监听 = pong 永远是空**
 * ⇒ 探测永远判"窗口不在" ⇒ 每次点击都建一个新窗口（用户看到一堆二维码）。
 *
 * ⚠️ 这同样是**结构性断言**（"监听被注册了"），行为侧由
 * `login-window-pong.test.ts` 与 `login-heartbeat-probe.test.ts` 守。
 * 但它值得单列：`main.tsx` 在 node 环境里加载不了（顶层 `render()`），
 * 删掉这个 effect **不会让任何行为测试变红**。
 */
describe('★★★ 扫码窗口必须应答 ping（写入端的另一半）', () => {
  it('★★★ 必须监听 `chrome.storage.onChanged` 并写 pong', () => {
    expect(SRC, '没有监听 storage.onChanged —— 页面永远不会应答存活探测').toContain(
      'chrome.storage.onChanged.addListener',
    );
    expect(SRC, '没有写 pong —— 探测永远判"窗口不在"，每次点击都会多开一个窗口').toContain(
      'writeLoginPong',
    );
  });

  it('★★★ 必须用 `parseLoginPing` 过滤脏载荷（不能把任意值直接当 nonce 用）', () => {
    // 脏数据下若直接 `writeLoginPong(value.nonce)`，会写出一条伪造的 pong
    // —— 而 pong 恰恰是"窗口还活着"的**唯一**证据。
    expect(SRC).toContain('parseLoginPing');
  });

  it('★★★ 监听必须挂在 `LOGIN_PING_KEY` 上（不许硬编码键名，改键会静默失联）', () => {
    expect(SRC).toContain('LOGIN_PING_KEY');
  });

  it('★★ 监听必须能摘掉（否则热更新/重载后叠出多个 listener）', () => {
    expect(SRC).toContain('removeListener');
  });
});

describe('★★ 探测链路接进了 openLoginWindow（不是只定义了函数）', () => {
  const LOGIN_WINDOW_SRC = stripComments(
    readFileSync(
      fileURLToPath(new URL('../../../src/background/login-window.ts', import.meta.url)),
      'utf8',
    ),
  );

  it('★★ 判定体（`openLoginWindowOnce`）里必须调用 `probeExistingLoginWindow()`', () => {
    /**
     * ⚠️ 2026-11-15：判定体从 `openLoginWindow()` 挪到了 `openLoginWindowOnce()`
     * （外层 `openLoginWindow()` 现在只做 in-flight 去重，见 P0 并发修复）。
     * 切外层会把这条断言变成空壳 —— 所以锚点跟到判定体。
     */
    const start = LOGIN_WINDOW_SRC.indexOf('async function openLoginWindowOnce');
    expect(start, '找不到 openLoginWindowOnce（判定体）').toBeGreaterThan(-1);
    const body = LOGIN_WINDOW_SRC.slice(start);
    expect(body).toContain('await probeExistingLoginWindow()');
  });

  it('★★ 导出的 `openLoginWindow` 必须**委派**给判定体（不许留第二份实现）', () => {
    /**
     * in-flight 去重那一层是薄的：只做"复用 / 释放"，不参与任何判定。
     * 若有人把建窗逻辑复制回外层，就会绕过去重 ⇒ 并发点击又开两个窗口。
     */
    const wrapperStart = LOGIN_WINDOW_SRC.indexOf('export function openLoginWindow');
    const onceStart = LOGIN_WINDOW_SRC.indexOf('async function openLoginWindowOnce');
    expect(wrapperStart, '找不到导出的 openLoginWindow').toBeGreaterThan(-1);
    expect(onceStart, '找不到 openLoginWindowOnce').toBeGreaterThan(wrapperStart);
    const wrapper = LOGIN_WINDOW_SRC.slice(wrapperStart, onceStart);
    expect(wrapper, '外层没有委派给判定体').toContain('openLoginWindowOnce()');
    expect(wrapper, '外层不许自己调 windows.create（会绕开 in-flight 去重）').not.toContain(
      'windows.create',
    );
  });

  it('★★ 探测到心跳必须返回 `already-open`，且**在 create 之前**', () => {
    const start = LOGIN_WINDOW_SRC.indexOf('await probeExistingLoginWindow()');
    const alreadyOpen = LOGIN_WINDOW_SRC.indexOf("reason: 'already-open'", start);
    const create = LOGIN_WINDOW_SRC.indexOf('windows.create', start);
    expect(alreadyOpen, '探测没用 already-open 回报，文案分支永远不会命中').toBeGreaterThan(start);
    expect(create, '找不到 windows.create').toBeGreaterThan(-1);
    // 顺序：探测 → already-open 返回 → 才轮到 create
    expect(alreadyOpen).toBeLessThan(create);
  });

  it('★★ 权限闸门必须存在，且必须排在探测之前（2026-11-15 task-46 口径）', () => {
    /**
     * ## ⚠️ 口径反转了（第二次），请勿按旧注释改回去
     *
     * - 2026-11-12（task-32）：本条断言 ``if (!allowed)`` **不许存在**，权限值只写 diag。
     *   依据是 22 次**跨实例**读取 true 10 / false 12、翻转 15 次、21 个 SW 实例。
     * - 2026-11-15（task-46）：按 **SW 实例分组**重看同一批日志，实例 `wo1xrs`
     *   连续 `isAllowedIncognitoAccess=false` **90/90** 条、
     *   `probe/instance incognito=false` **90/90** 条，一条 true 都没有；
     *   用户本人确认权限当时**是关着的**。所谓"翻转"是「权限真没开」与
     *   「不同实例读数」被混成了一条时间序列。
     *
     * 不拦的代价：权限关着仍 `create({incognito:true, url:'chrome-extension://…/login-window.html'})`
     * ⇒ 无痕分区里没有本扩展 ⇒ 该 URL 无主体可加载 ⇒ `ERR_BLOCKED_BY_CLIENT` 废页
     * ⇒ `create()` 跨分区返回 undefined ⇒ 落 `assumed` 报"成功"。
     * **用户看到废页，代码说打开了。**
     *
     * 本条守两件事：
     * 1. `if (!allowed)` **必须存在**（闸门别再一次被删掉）
     * 2. 它必须排在 `probeExistingLoginWindow()` **之前** —— 否则窗口没建，
     *    却可能因为别处残留的心跳被改判 `already-open`
     */
    const gate = LOGIN_WINDOW_SRC.indexOf('if (!allowed)');
    expect(
      gate,
      '`if (!allowed)` 不见了 —— 权限关着又会去 create 无痕窗（ERR_BLOCKED_BY_CLIENT 那张废页的来源）',
    ).toBeGreaterThan(-1);

    const probe = LOGIN_WINDOW_SRC.indexOf('await probeExistingLoginWindow()');
    expect(probe, '探测不见了').toBeGreaterThan(-1);
    expect(
      gate,
      '权限闸门排在了探测之后 —— 残留心跳会把没建的窗口谎报成 already-open',
    ).toBeLessThan(probe);
  });
});
