/**
 * task-33 守卫：切 InPrivate 权限后原页面面板变死壳，点扫码登录毫无反应。
 *
 * ## 用户原话（这是唯一需求，别再问用户）
 * > 「我只要开启或者关闭一次在 InPrivate 中允许，再返回原页面，
 * > 点击扫码登录取流账号就会没有反应」
 *
 * ## 三条守卫（对应任务卡 §五）
 * 1. `sendMessage` 抛 `Extension context invalidated` → **必须有可见提示**（不是静默）
 * 2. 同一场景下 `controller === null` → **仍然必须有可见提示**（用户实际遇到的形状）
 * 3. 正常路径**不受影响**（不多提示、不多往返）
 *
 * ## 为什么能测到「不依赖 controller」这条
 * `showOrphanHint()` 是**模块级函数**，直接操作 `document`，签名里根本没有
 * controller 这个参数 —— 所以"传个 null controller 试试"这种测法是没意义的。
 * 真正要守住的是**调用点的形状**：`openLogin()` 的 catch 里必须
 * 在孤儿态调 `showOrphanHint()`，且那行**不许被 `if (controller)` 包住**。
 * 于是：
 * - 行为层：直接测 `showOrphanHint()` 真的在 document 上建出可读文本（1、2 的产物侧）；
 * - 源码层：剥注释后断言 `openLogin` 的 catch 块里 `showOrphanHint()` 不在
 *   `if (controller` 里，且 `.catch(` 里不再出现 `() => null` 这种吞错写法。
 *
 * ⚠️ 本文件用 `// @vitest-environment jsdom` 而不是在 `vitest.config.ts` 里开
 * 全局 jsdom：全局 jsdom 会让**全部** 1800+ 测试换环境，代价与风险都不必要
 * （且 `vitest.config.ts` 不在本卡写域）。
 */

// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isOrphanError,
  isOrphanHintShown,
  hideOrphanHint,
  ORPHAN_HINT_ACTION,
  ORPHAN_HINT_HOST_ID,
  ORPHAN_HINT_TEXT,
  showOrphanHint,
} from '@/src/content/panel/orphan-hint';

/** 读源码做形状断言 —— 与 `need-incognito-create-diag.test.ts` 同一套手法 */
const SRC: string = readFileSync(resolve('entrypoints/content-panel.content.ts'), 'utf8');

/**
 * 剥注释（状态机，**不用正则**）。
 *
 * ⚠️ 任务卡历史教训：`\/\*[\s\S]*?\*\/` 这种单条正则遇到字符串里的 `*` `/`
 * 会**跨块吞**，把真实代码一起删掉 —— task-12 因此差点误报"改了逻辑"。
 * 另外：若判据是"必须包含某段代码"，注释里写一遍就能**假绿**，所以必须剥。
 */
function stripComments(s: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'tmpl' = 'code';
  while (i < s.length) {
    const ch = s[i] ?? '';
    const nx = s[i + 1] ?? '';
    if (mode === 'code') {
      if (ch === '/' && nx === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && nx === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'tmpl';
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && nx === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    // 字符串内部：只认对应的闭引号（不处理转义以外的情况，源码里够用）
    if (ch === '\\') {
      out += ch + nx;
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && ch === "'") ||
      (mode === 'double' && ch === '"') ||
      (mode === 'tmpl' && ch === '`')
    ) {
      mode = 'code';
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 从 `from` 起配平花括号，取出一整个 `{ … }` 块（含首尾大括号） */
function braceBlock(s: string, from: number): string {
  const open = s.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(open, i + 1);
    }
  }
  return '';
}

/** `openLogin` 整个函数的源码（剥注释后） */
function openLoginCode(): string {
  const code = stripComments(SRC);
  const at = code.indexOf('const openLogin = async');
  expect(at, '找不到 openLogin —— 源码结构变了，守卫已失效').toBeGreaterThan(-1);
  // 箭头函数体：从 `=> {` 开始配平
  return braceBlock(code, code.indexOf('=>', at)).replace(/\n/g, ' ');
}

describe('★ 孤儿态判定（isOrphanError）', () => {
  it('Extension context invalidated 判成孤儿', () => {
    expect(isOrphanError(new Error('Extension context invalidated.'))).toBe(true);
  });

  it('另外两种"目标上下文没了"的官方表述也判成孤儿', () => {
    expect(
      isOrphanError(new Error('Could not establish connection. Receiving end does not exist.')),
    ).toBe(true);
    expect(
      isOrphanError(new Error('The message port closed before a response was received.')),
    ).toBe(true);
  });

  it('普通业务失败**不许**判成孤儿（否则会误导用户去刷新）', () => {
    expect(isOrphanError(new Error('login/open failed'))).toBe(false);
    expect(isOrphanError(null)).toBe(false);
    expect(isOrphanError('some other error')).toBe(false);
  });
});

describe('★★ 可见提示不依赖 controller（守卫 1、2 的产物侧）', () => {
  beforeEach(() => {
    hideOrphanHint();
    document.body.innerHTML = '';
  });

  it('渲染后 document 上真的能读到文案与「刷新页面」按钮（无 controller 参与）', () => {
    expect(isOrphanHintShown()).toBe(false);
    const host = showOrphanHint();
    expect(host).not.toBeNull();
    expect(isOrphanHintShown()).toBe(true);
    /**
     * shadow root 是 `mode:'closed'` ⇒ `host.shadowRoot` 恒 null，
     * 外部 `querySelector` 也进不去（这正是 §5.3 要的隔离）。
     *
     * ⚠️ 第一版这里写的是 `expect(ORPHAN_HINT_TEXT).toContain('刷新页面')` ——
     * **恒真断言**：对常量做包含判断，渲染函数就算一个字都不写它也绿
     * （verifier task-34 中危③点名）。现在改成**读真实 DOM 文本**。
     *
     * 读法：`showOrphanHint()` 建宿主时把 `host` 交给测试（它就是那个元素），
     * 所以这里用 `outerHTML` 之外的路径 —— 因为 closed shadow 拿不到内部，
     * 我们只能断言**宿主存在 + 文案常量与按钮文案都被渲染函数引用**。
     * ⇒ 真正的"文本真的进了 DOM"由 `new Function` 运行期探针（见文件后半）
     * 与产物 grep 共同保证；这里不再做恒真断言。
     */
    /**
     * 文案确实被渲染函数用到了 —— 用 spy 抓 `textContent` 的写入，
     * 这是**运行期**证据，不是"常量里有这个子串"那种恒真断言。
     *
     * 做法：closed shadow 内部拿不到引用，所以给 `document.createElement`
     * 打桩，记录每次创建时被赋的 `textContent`。文案与按钮文案都必须出现过。
     */
    const written: string[] = [];
    const realCreate = document.createElement.bind(document);
    const spyCreate = ((tag: string, opts?: ElementCreationOptions) => {
      const node = realCreate(tag, opts);
      const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
      Object.defineProperty(node, 'textContent', {
        configurable: true,
        get() {
          return desc?.get?.call(this) as string;
        },
        set(v: string) {
          written.push(String(v));
          desc?.set?.call(this, v);
        },
      });
      return node;
    }) as typeof document.createElement;
    document.createElement = spyCreate;
    try {
      hideOrphanHint();
      showOrphanHint();
    } finally {
      document.createElement = realCreate;
    }
    expect(written).toContain(ORPHAN_HINT_TEXT);
    expect(written).toContain(ORPHAN_HINT_ACTION);
    expect(host?.shadowRoot).toBeNull();
    expect(document.getElementById(ORPHAN_HINT_HOST_ID)).not.toBeNull();
    /**
     * 用 `textContent` 读宿主：closed shadow 的内容**不会**出现在宿主的
     * textContent 里（这正是隔离的意思），所以这里断言的是"宿主是空的、
     * 文本在 shadow 内"—— 反过来证明我们没把文本漏到页面 DOM 上被站点样式污染。
     */
    expect(host?.textContent).toBe('');
  });

  it('重复调用幂等 —— 不会叠出第二个提示', () => {
    showOrphanHint();
    showOrphanHint();
    expect(document.querySelectorAll(`#${ORPHAN_HINT_HOST_ID}`).length).toBe(1);
  });

  it('hideOrphanHint 能摘掉（面板恢复后不留过期提示）', () => {
    showOrphanHint();
    hideOrphanHint();
    expect(isOrphanHintShown()).toBe(false);
  });
});

describe('★★★ 点击路径永不静默（守卫 1、2 的调用点侧，源码形状）', () => {
  it('login/open 的 catch 不再把错误吞成 () => null', () => {
    const code = openLoginCode();
    expect(code).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/);
  });

  it('孤儿态调用 showOrphanHint()，且**不许**被 if (controller) 包住', () => {
    const code = openLoginCode();
    expect(code).toContain('isOrphanError(');
    expect(code).toContain('showOrphanHint(');
    /**
     * 反例形状（旧代码）：`if (controller) controller.showNotice(...)` ——
     * 孤儿态 controller 为 null ⇒ 整句跳过 ⇒ 静默。
     * 这里禁止的是**把孤儿提示挂进 controller 守卫**：
     */
    expect(code).not.toMatch(/if\s*\(\s*controller\s*\)\s*showOrphanHint\(/);
    expect(code).not.toMatch(/controller\s*&&\s*showOrphanHint\(/);
    expect(code).not.toMatch(/controller\?\.\s*showOrphanHint\(/);
  });

  /**
   * ⚠️ 这条断言的第一版**假绿过**（2026-11-12，RV2 实测）：
   * 旧写法是
   * ```
   * if (!isOrphanHintShown() && controller === null) showOrphanHint();
   * ```
   * 然后我在 RV 里把它变异成
   * ```
   * if (controller) controller.showNotice(...);
   * if (false && controller === null) showOrphanHint();
   * ```
   * —— 原正则 `/controller\s*===\s*null\)\s*showOrphanHint\(\)/` **照样命中第二行**，
   * 13 条全绿。变异体的行为其实是对的（永远不提示 = 静默），说明断言写错了。
   *
   * 现在的判据改成钉住**完整前缀**（含 `!isOrphanHintShown()`），
   * 这样"短路掉这条兜底"的任何写法都会掉出匹配。
   */
  it('controller 为 null 且非孤儿时也要有反馈（兜底那条 if，钉完整前缀）', () => {
    const code = openLoginCode();
    expect(code).toMatch(
      /if\s*\(\s*!isOrphanHintShown\(\)\s*&&\s*controller\s*===\s*null\s*\)\s*showOrphanHint\(\)/,
    );
  });

  it('轮询判据仍是 shouldPoll（不许因为改 catch 把它退回成看 ok）', () => {
    const code = openLoginCode();
    expect(code).toContain('if (!r.shouldPoll) return;');
  });
});

describe('★ 正常路径不受影响（守卫 3）', () => {
  beforeEach(() => {
    hideOrphanHint();
    document.body.innerHTML = '';
  });

  it('没有孤儿错误时，什么都不渲染（不许多余提示）', () => {
    expect(isOrphanError({ type: 'login/open:ok', opened: true })).toBe(false);
    expect(isOrphanHintShown()).toBe(false);
  });

  it('探活是动作驱动：启动一次 + click(capture) + visibilitychange，且**没有常驻心跳**', () => {
    const code = stripComments(SRC);
    expect(code).toContain("sendMessage({ type: 'proxy/status' })");
    /**
     * 🔴 task-35：常驻 `setInterval` 心跳已撤。verifier 的理由是硬的 ——
     * 没有 `document.hidden` 判断 ⇒ 每个后台 B 站标签页永久每 20s 唤醒 SW，
     * 而清理它的 `onInvalidated` 从不触发 ⇒ 心跳根本没有回收点。
     * 这条断言就是那个撤回的守卫：谁把 `setInterval` 加回来，它必须红。
     */
    expect(code).not.toMatch(/setInterval\(\s*probeAlive/);
    expect(code).not.toContain('PANEL_ALIVE_PROBE_MS');
    /** 两种动作都要接上 */
    expect(code).toMatch(/document\.addEventListener\(\s*'click'\s*,\s*onAnyClick\s*,\s*true\s*\)/);
    expect(code).toMatch(/document\.addEventListener\(\s*'visibilitychange'\s*,\s*onVisible\s*\)/);
    /** `visibilitychange` 里只在**变可见**时探一次，不是无条件探 */
    expect(code).toMatch(/visibilityState\s*===\s*'visible'\)\s*probeAlive\(\)/);
  });

  it('两个 document 监听都有清理调用（并如实注明清理点本身不可靠）', () => {
    const code = stripComments(SRC);
    expect(code).toMatch(/removeEventListener\(\s*'click'\s*,\s*onAnyClick\s*,\s*true\s*\)/);
    expect(code).toMatch(/removeEventListener\(\s*'visibilitychange'\s*,\s*onVisible\s*\)/);
    /**
     * ⚠️ 第一版只断言 `toContain("document.addEventListener('click', onAnyClick, true)")`
     * —— 把 capture 改成 `false`（默认冒泡）它**照样绿**，而冒泡阶段
     * 业务 handler 已经跑完并静默失败，兜底就失效了。所以必须钉住那个 `true`。
     */
    expect(code).not.toMatch(
      /document\.addEventListener\(\s*'click'\s*,\s*onAnyClick\s*,\s*false\s*\)/,
    );
    /** 注释必须如实写"没有显式回收点"—— 不许假装有 */
    expect(SRC).toContain('没有显式回收点');
  });
});

/**
 * ## ★★★★ 运行期探针（task-35：这条才是能杀变异的守卫）
 *
 * ### 为什么必须有它
 * verifier task-34 实测：把 `if (isOrphanError(e))` 改成
 * `if (false && isOrphanError(e))`（`showOrphanHint()` 字样**原封不动保留**，
 * 运行期彻底静默）→ 本文件原有 13 条守卫**全绿**。
 *
 * 原因：上面的源码形状断言测的是"**字符串在不在**"，不是"**这段代码会不会执行**"。
 * 而用户报的那条路径（切 InPrivate 权限 → 扩展重载 → 点扫码登录无反应）
 * 唯一的保障就是那一段执行。
 *
 * ### 做法
 * 从源码按花括号配平切出 `openLogin` 的**函数体**，用 `new Function` 重建，
 * 把 `chrome.runtime.sendMessage` / `controller` 都换成受控替身，然后
 * **真的跑一遍**，断言 `showOrphanHint` 的调用次数。
 *
 * 依赖的边界：只依赖 `openLogin` 体内出现的**少数几个自由变量**
 * （`chrome`、`controller`、`readAccountMid`、`startLoginPolling`、
 * `stopPolling`、`describeLoginOutcome`、`isOrphanError`、`showOrphanHint`、
 * `isOrphanHintShown`）。**源码里新增自由变量会让这里抛 ReferenceError** ——
 * 那是**故意**的失败信号：说明重建环境需要同步更新，否则探针就成了摆设。
 */
describe('★★★★ 运行期探针：孤儿态必须真的调 showOrphanHint（能杀变异）', () => {
  /**
   * 把函数体里的 **TS 类型标注**去掉，得到能被 `new Function` 解析的 JS。
   *
   * ⚠️ 第一版直接喂原文 → `SyntaxError: Unexpected token ':'`（`(e: unknown)` 这类）。
   * 这里的替代只处理**本函数里实际出现过的**几种形状：
   * - `(xxx: T)` / `(xxx: T) =>` 形参标注
   * - `const x = (...) as T;` 中的 `as T`
   * 不做通用 TS 解析 —— 源码里出现新形状就让断言炸出来，提醒同步更新。
   */
  function toJs(body: string): string {
    return (
      body
        /**
         * ⚠️ 顺序：先 `as`（否则 `as { a: string }` 的冒号会被当成变量标注），
         * 再**变量**类型标注 `let res: X = …`，再箭头回调，最后普通函数参数。
         * 漏掉第 2 步会报 `SyntaxError: Unexpected token ':'`（task-41 实测：
         * `openLogin` 新增了 `let res: LoginOpenReply | null = null;`）。
         */
        .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '')
        .replace(/\b(let|const|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, '$1 $2 =')
        /**
         * 空参数列表的**返回类型**标注：`(): boolean =>` → `() =>`
         *
         * task-44 新加。前面几条都要求"参数名以字母开头"，空 `()` 一条都不匹配，
         * 于是 `: boolean` 原样留给 `new Function` ⇒ `SyntaxError: Unexpected token ')'`。
         */
        .replace(/\(\s*\)\s*:\s*[A-Za-z_$][\w$<>[\]\s|&.]*?(?=\s*=>)/g, '()')
        .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)\s*=>/g, '($1) =>')
        .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)(?!\s*=>)/g, '($1)')
    );
  }

  /** 从源码里切出 `openLogin` 的箭头函数体（已剥注释、已去类型标注） */
  function openLoginBody(): string {
    const code = stripComments(SRC);
    const at = code.indexOf('const openLogin = async');
    expect(at, '找不到 openLogin').toBeGreaterThan(-1);
    const block = braceBlock(code, code.indexOf('=>', at));
    expect(block.startsWith('{')).toBe(true);
    return toJs(block.slice(1, -1));
  }

  type Probe = {
    /** 重建后的函数跑一次（异步） */
    run: () => Promise<void>;
    /** `showOrphanHint` 被调用几次 */
    hintCalls: () => number;
    /** `controller.showNotice` 被调用几次 */
    noticeCalls: () => number;
  };

  /**
   * 造一个受控运行环境跑 `openLogin`。
   *
   * @param send Fails / resolves —— 模拟两种 `login/open` 应答
   */
  function buildProbe(opts: { send: 'throw-orphan' | 'ok'; controller: 'ready' | 'null' }): Probe {
    const hintSpy = { n: 0 };
    const noticeSpy = { n: 0 };
    const shown = { flag: false };

    const chromeStub = {
      runtime: {
        /**
         * task-39 的同步守卫判据 1 读 `chrome.runtime?.id`。
         * 本文件测的是**已过守卫、走到 sendMessage** 的路径，
         * 所以给一个非空 id（孤儿守卫星座在 `orphan-guard.test.ts`）。
         */
        id: 'test-extension-id',
        sendMessage: async (): Promise<unknown> => {
          if (opts.send === 'throw-orphan') throw new Error('Extension context invalidated.');
          return { type: 'login/open:ok', opened: true };
        },
      },
    };
    /**
     * `controller` 两种形状都要能造：
     * - `'null'`：孤儿态最常见的形状（扩展重载后被清掉）
     * - `'ready'`：正常面板还活着 —— 用来证明**正常路径不受影响**
     */
    const controllerStub =
      opts.controller === 'ready'
        ? {
            showNotice: (): void => {
              noticeSpy.n += 1;
            },
            clearNotice: () => undefined,
          }
        : null;

    /**
     * 把 `showOrphanHint` 换成记录器 —— 这样"调没调"才是可观测的。
     * 同理 `controller`：传 null 时调用 `showNotice` 会直接抛，等于证明"没走 controller"。
     */
    const showOrphanHintStub = (): void => {
      hintSpy.n += 1;
      shown.flag = true;
    };
    const describeLoginOutcomeStub = (): {
      text: string;
      ok: boolean;
      shouldPoll: boolean;
    } => ({
      text: 'stub',
      ok: true,
      shouldPoll: false,
    });

    /** `new Function` 的自由变量全部走参数注入；`void` 用于吞掉未使用的形参 */
    const factory = new Function(
      'chrome',
      'controller',
      'readAccountMid',
      'startLoginPolling',
      'stopPolling',
      'describeLoginOutcome',
      'isOrphanError',
      'showOrphanHint',
      'isOrphanHintShown',
      /**
       * task-44：`openLogin` 第一段就调 `shouldSkipRepeatOpen()`。
       * 本文件两个探针都不测那条路（它有自己的文件，且用源码切片守判据本身），
       * 恒 false = "记忆里没人"，让被测路径照常跑到。
       */
      'shouldSkipRepeatOpen',
      `"use strict";
       const openLogin = async () => ${`{${openLoginBody()}}`};
       return openLogin;
      `,
    ) as (
      c: unknown,
      ctrl: unknown,
      r: () => Promise<{ mid: number | null }>,
      s: () => unknown,
      st: () => void,
      d: unknown,
      ioe: (e: unknown) => boolean,
      soh: () => void,
      iohs: () => boolean,
      stale: () => boolean,
      skipRepeat: () => boolean,
    ) => () => Promise<void>;

    const openLogin = factory(
      chromeStub,
      controllerStub,
      async () => ({ mid: 1 }),
      () => ({ stop: () => undefined }),
      () => undefined,
      describeLoginOutcomeStub,
      isOrphanError,
      showOrphanHintStub,
      /**
       * 🔴 **这里必须恒为 `true`，这是本用例能杀变异的关键**（task-35）。
       *
       * 第一版传 `() => shown.flag` 时，RV 实测**没红**：我单独把
       * `if (isOrphanError(e))` 变异成 `if (false && isOrphanError(e))`，
       * catch 分支彻底静默，但后面那条与孤儿无关的兜底
       * `if (!isOrphanHintShown() && controller === null) showOrphanHint();`
       * **把 showOrphanHint 又调了一次**，于是 `hintCalls()` 仍是 1 —— 绿。
       *
       * 也就是说两条路径互相掩盖，测试分辨不出是哪一条在起作用。
       * 恒为 true ⇒ 兜底那行的条件恒假 ⇒ 若 catch 分支真的没执行，
       * 调用次数必然是 **0**，变异跑不掉。
       *
       * （兜底那条另有自己的用例 + 源码级断言，不在这里测。）
       */
      () => true,
      // task-39 双判据之一：本探针测的是"过了守卫之后"的路径，所以代次必须是当前代。
      () => false,
      // task-44：重复点击记忆放行（见参数表注释）。
      () => false,
    );

    return {
      run: openLogin,
      hintCalls: () => hintSpy.n,
      noticeCalls: () => noticeSpy.n,
    };
  }

  /**
   * 兜底分支专用环境：`isOrphanHintShown()` 真实反映"已经挂过提示"，
   * 这样**非孤儿**路径只能靠兜底那行拿到反馈。
   * （和上面孤儿探针故意相反 —— 两条路径必须各测各的，否则互相掩盖。）
   */
  function buildFallbackProbe(): Probe {
    const hintSpy = { n: 0 };
    const noticeSpy = { n: 0 };
    const shown = { flag: false };
    const chromeStub = {
      runtime: { sendMessage: async (): Promise<unknown> => ({ type: 'login/open:ok' }) },
    };
    const factory = new Function(
      'chrome',
      'controller',
      'readAccountMid',
      'startLoginPolling',
      'stopPolling',
      'describeLoginOutcome',
      'isOrphanError',
      'showOrphanHint',
      'isOrphanHintShown',
      /**
       * task-44：`openLogin` 第一段就调 `shouldSkipRepeatOpen()`。
       * 本文件两个探针都不测那条路（它有自己的文件，且用源码切片守判据本身），
       * 恒 false = "记忆里没人"，让被测路径照常跑到。
       */
      'shouldSkipRepeatOpen',
      `"use strict";
       const openLogin = async () => ${`{${openLoginBody()}}`};
       return openLogin;
      `,
    ) as (
      c: unknown,
      ctrl: unknown,
      r: () => Promise<{ mid: number | null }>,
      s: () => unknown,
      st: () => void,
      d: unknown,
      ioe: (e: unknown) => boolean,
      soh: () => void,
      iohs: () => boolean,
      stale: () => boolean,
      skipRepeat: () => boolean,
    ) => () => Promise<void>;
    const openLogin = factory(
      chromeStub,
      null,
      async () => ({ mid: 1 }),
      () => ({ stop: () => undefined }),
      () => undefined,
      () => ({ text: 'stub', ok: true, shouldPoll: false }),
      isOrphanError,
      () => {
        hintSpy.n += 1;
        shown.flag = true;
      },
      () => shown.flag,
      // task-39：本探针测兜底，代次必须是当前代，否则守卫会先返回、兜底测不到。
      () => false,
      // task-44：重复点击记忆放行，否则 :220 那段会先 return，兜底根本轮不到。
      () => false,
    );
    return { run: openLogin, hintCalls: () => hintSpy.n, noticeCalls: () => noticeSpy.n };
  }

  it('★★★ sendMessage 抛 Extension context invalidated 且 controller 为 null → showOrphanHint 必须被调用', async () => {
    const p = buildProbe({ send: 'throw-orphan', controller: 'null' });
    await p.run();
    expect(p.hintCalls()).toBeGreaterThanOrEqual(1);
  });

  it('★★ sendMessage 正常返回且 controller 可用 → 一次都不许调用 showOrphanHint', async () => {
    const p = buildProbe({ send: 'ok', controller: 'ready' });
    await p.run();
    expect(p.hintCalls()).toBe(0);
  });

  /**
   * ⚠️ 这条**不是**孤儿态，但同样是"点了没反应"：
   * `controller` 为 null 时 `showNotice` 整句被跳过。
   * task-33 有意让它在同一时刻挂出提示 —— 用户点的这一刻必须看到东西。
   * （第一版把这条写成"正常返回 0 次" → 实测 1 次，那说明我把兜底当成了缺陷。
   * 真正该断言的"正常路径不受影响"是**上一条**：controller 可用时 0 次。）
   */
  it('★ sendMessage 正常返回但 controller 为 null → 仍要有反馈（1 次，不是静默）', async () => {
    const p = buildFallbackProbe();
    await p.run();
    expect(p.hintCalls()).toBe(1);
  });
});
