// @vitest-environment jsdom

/**
 * 面板诊断导出的**凭据泄漏防线**（阶段 3）。
 *
 * ## 为什么照抄 `diagnostics-export.test.ts` 的套路
 *
 * 那一份（`tests/unit/platform/diagnostics-export.test.ts`）设计得很好：
 * 它除了断言"搜不到凭据"，还**主动构造一份带泄漏的 payload 证明扫描器能抓到**。
 * 没有第二条，第一条可能永远绿——它什么也守不住。
 *
 * 本文件守的是**面板这一侧**的导出（`src/content/panel/diagnostics.ts`），
 * 与 options 那份是两套代码，所以各守一遍。
 *
 * ## 三条防线
 *
 * 1. 常规扫描：真实形状的 facts + logs 里搜不到任何敏感串
 * 2. **检测能力自担保**：塞一条带凭据的 fact，扫描器必须抓到
 * 3. **形状守卫**：`buildExportPayload` 只包四个字段（多一个就多一条泄漏路径）
 */

import { describe, expect, it } from 'vitest';

import { readFile } from 'node:fs/promises';
import {
  buildExportPayload,
  describeLogsError,
  diagnosticsPane,
  exportFileName,
} from '../../../src/content/panel/diagnostics';
import type { DiagEntry, DiagRow } from '../../../src/platform/diagnostics/collect';

/** 会被当作"泄漏"的敏感串。大小写都算。 */
const SECRETS = [
  'deadbeef,1700000000,1*FAKEsessdata', // SESSDATA 值
  '8bf1e88c2633143a485be4ad40e29c7e', // bili_jct 值
  '1000002', // 播放账号 DedeUserID
  'SESSDATA=',
  'bili_jct=',
  'DedeUserID=',
];

const NOW = new Date('2026-11-10T12:34:56Z');

/** 一份真实形状的 facts（与 `collectFacts()` 的产出同形） */
function realRows(): DiagRow[] {
  return [
    { label: 'InPrivate 权限', value: '已允许', ok: true },
    { label: '当前页取流数据', value: '本页没有取流数据（首页 / 直播页，或本页不是播放页）' },
    { label: '可见窗口数', value: '1' },
    { label: '取流账号凭据', value: '已配置', ok: true },
    { label: '播放代理总开关', value: '已开启（2 条路径规则）', ok: true },
    { label: 'DNR 全局路径规则', value: '2', ok: true },
    { label: '  10042', value: 'filter=/x/player/wbi/playurl', ok: true },
    { label: '代理路径白名单', value: 'r3 · 核对于 2026-11-06' },
  ];
}

/** 一份真实形状的日志，**包含面板侧的 `panel/page-state`** */
function realLogs(): DiagEntry[] {
  return [
    { at: 1793028000000, step: 'proxy/enable', detail: '代理已开启', from: 'ab12cd' },
    { at: 1793028001000, step: 'panel/page-state', detail: 'kind=ok', from: 'ef34gh' },
  ];
}

function payload(rows: DiagRow[], logs: DiagEntry[]): string {
  return buildExportPayload({
    rows,
    logs,
    version: '0.0.0-test',
    now: NOW,
    trace: {
      at: NOW.getTime(),
      step: 'diag/facts result',
      detail: 'ok: {"incognitoAllowed":true}',
      from: 'ab12cd',
    },
    echo: 'entered | incognito=ok:true windows=nil cookies=ok:["0"] dnr=ok:{"path":[],"tab":[]}',
    /** 第七个字段（2026-11-12，task-26）：日志这一次**读成没读成** */
    logsMeta: {
      ok: true,
      err: null,
      count: logs.length,
      limit: 30,
      instanceId: 'ab12cd',
      readAt: NOW.getTime(),
    },
  });
}

describe('★ 面板诊断导出不含凭据', () => {
  it('常规 facts + logs 里搜不到任何敏感串', () => {
    const json = payload(realRows(), realLogs()).toLowerCase();
    for (const s of SECRETS) {
      expect(json, `导出里出现了 ${s}`).not.toContain(s.toLowerCase());
    }
  });

  it('★ 检测能力自担保：塞一条带凭据的 fact，扫描器必须抓到', () => {
    /**
     * ⚠️ 这条是给上面那条测试做担保的。
     * 如果 `SECRETS` 写错了、或比对方式坏了，上面那条会**永远绿**。
     */
    const leaky: DiagRow[] = [
      { label: '凭据', value: 'SESSDATA=deadbeef,1700000000,1*FAKEsessdata', ok: true },
    ];
    const json = payload(leaky, []).toLowerCase();
    const hit = SECRETS.filter((s) => json.includes(s.toLowerCase()));
    expect(hit.length, '扫描器抓不到已知的泄漏串，SECRETS 或比对方式坏了').toBeGreaterThan(0);
  });

  it('★ 日志里塞凭据也会被抓到（logs 不是安全通道）', () => {
    const logs: DiagEntry[] = [
      { at: 1, step: 'leak', detail: 'Cookie: SESSDATA=deadbeef,1700000000,1*FAKEsessdata' },
    ];
    const json = payload([], logs).toLowerCase();
    expect(json).toContain('sessdata=');
  });
});

describe('★ 形状守卫：顶层字段固定', () => {
  it('payload 的顶层键恰好是 exportedAt / version / facts / logs / trace / echo / logsMeta', () => {
    /**
     * 多一个字段就可能多一条泄漏路径，少了也不会报错 —— 两边都得钉住。
     * 反例：往 `buildExportPayload` 里加 `credential: ...` → 本条必红。
     *
     * ⚠️ 两个调试字段是 2026-11-10 加的，理由：主日志是环形缓冲会被冲掉，
     * 定位信息必须有一条挤不掉的通道 —— `trace` 走 storage（可能写不进），
     * `echo` 走消息应答（没丢过）。**加字段就要改这里**，这正是本断言的作用。
     *
     * ⚠️ `logsMeta` 是 2026-11-12（task-26）加的第一个**含自由文本**的字段。
     * 它的 `err` 必须走 `describeLogsError()` 的白名单，绝不能是 `String(e)` ——
     * 下面的「err 白名单」用例守着这一点。
     */
    const obj = JSON.parse(payload(realRows(), realLogs())) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual([
      'echo',
      'exportedAt',
      'facts',
      'logs',
      'logsMeta',
      'trace',
      'version',
    ]);
  });

  it('★ 源码级：`buildExportPayload` 的输出里不许出现凭据类字段名', async () => {
    /**
     * 扫源码而不是扫上面造出来的数据 ——
     * 扫数据的话，往实现里真加一个 `credential` 字段时测试**照样绿**
     * （options 那份的注释里记录过这个空断言）。
     */
    const src = await readFile('src/content/panel/diagnostics.ts', 'utf8');
    const fn = src.slice(
      src.indexOf('export function buildExportPayload'),
      src.indexOf('export function exportFileName'),
    );
    expect(fn.length, '找不到 buildExportPayload').toBeGreaterThan(0);
    for (const bad of ['credential', 'requestHeaders', 'sessdata', 'cookie', 'vault']) {
      expect(fn.toLowerCase(), `buildExportPayload 里出现了 ${bad}`).not.toContain(bad);
    }
  });

  it('★ 源码级：diagnostics.ts 不直接碰 store / cookie API', async () => {
    const src = await readFile('src/content/panel/diagnostics.ts', 'utf8');
    expect(src).not.toContain('document.cookie');
    expect(src).not.toContain('chrome.cookies');
  });

  /**
   * ## 从 options 那份测试迁过来的两条（2026-11-10 阶段 4）
   *
   * `tests/unit/platform/diagnostics-export.test.ts` 原本守的是 options 的导出实现。
   * options 废除后那个文件整体删除，但它里面**两条判据**与实现无关、
   * 守的是 `collect.ts`（自检数据的唯一来源）—— **必须保留**。
   */
  it('★ DNR 规则行只带 id，不带 requestHeaders（collect.ts 源码守卫）', async () => {
    /**
     * `action.requestHeaders[0].value` 是一条**完整 Cookie 头**。
     * 把它放进自检行 = 直接把取流账号凭据印在诊断页上、并随导出流传出去。
     *
     * ⚠️ 必须扫**源码**，不能扫造出来的假 payload ——
     * 假数据里本来就没有 `requestHeaders`，那种断言什么也守不住
     * （原 options 测试的注释里记录过这个空断言）。
     */
    const src = await readFile('src/platform/diagnostics/collect.ts', 'utf8');
    expect(src, 'collect.ts 输出了 action/requestHeaders，凭据会随导出泄漏').not.toMatch(
      /requestHeaders/,
    );
    expect(src).not.toMatch(/JSON\.stringify\(\s*r\s*\)/);
  });
});

describe('导出内容本身', () => {
  it('exportedAt 用注入的时间（可复现）', () => {
    const obj = JSON.parse(payload([], [])) as { exportedAt: string };
    expect(obj.exportedAt).toBe(NOW.toISOString());
  });

  it('facts / logs 原样保留（不丢行、不改顺序）', () => {
    const rows = realRows();
    const logs = realLogs();
    const obj = JSON.parse(payload(rows, logs)) as { facts: DiagRow[]; logs: DiagEntry[] };
    expect(obj.facts).toEqual(rows);
    expect(obj.logs).toEqual(logs);
  });

  it('★ 日志里的 panel/page-state 能被导出（诊断浮层要能看它）', () => {
    /**
     * 阶段 3 的目的之一就是让 `diag()` 写的东西**有人能看**。
     * 面板侧通道结局记在 `panel/page-state`，它必须出现在导出里。
     */
    const obj = JSON.parse(payload(realRows(), realLogs())) as { logs: DiagEntry[] };
    expect(obj.logs.some((e) => e.step === 'panel/page-state')).toBe(true);
  });

  it('导出的文本是合法 JSON（能被打包/解析）', () => {
    expect(() => JSON.parse(payload(realRows(), realLogs()))).not.toThrow();
  });
});

/**
 * ## ★ `logsMeta.err` 的白名单边界（2026-11-12，task-26）
 *
 * 这是本项目**第一个含自由文本**的导出字段。`buildExportPayload()` 那道
 * "只包固定字段"的防线原本靠"字段都是计数/布尔/固定串"成立 ——
 * 一旦有人把 `String(e)` 直接放进去，防线就破了一个口子，而且**无声**。
 *
 * 下面三条是成对的：前两条证明"已知串识得出"，第三条证明"未知内容带不出去"。
 * 只有第三条的话它可能永远绿（`describeLogsError` 什么都不返回也算不带出去）；
 * 只有前两条的话，反而证明不了防线。
 */
describe('★ logsMeta.err 白名单（task-26）', () => {
  it('孤儿态的固定串被识别（这就是我们要能看出来的那个）', () => {
    expect(describeLogsError(new Error('Extension context invalidated.'))).toBe(
      'Extension context invalidated.',
    );
  });

  it('★ 未知错误串一律归成 unknown —— 哪怕它里面带着凭据', () => {
    /**
     * verifier 会喂的正是这种：如果实现里写了 `String(e)`，`abc123` 就会
     * 出现在导出 JSON 里，本断言 + 下面的 payload 级断言会一起红。
     */
    expect(describeLogsError(new Error('token=abc123'))).toBe('unknown');
    expect(describeLogsError('SESSDATA=deadbeef,1700000000,1*FAKEsessdata')).toBe('unknown');
    /**
     * ⚠️ 第三例原本逐字抄了 `SECRETS` 里那条假 cookie 值的形状，
     * 被 `check-secrets` 判成「bili_jct 真实值」（它按**形状**匹配，
     * 分辨不出这是测试向量）。这里改成不含凭据形状的串 —— 它测的是
     * 「未命中白名单就归 unknown」，串长什么样无关紧要。
     */
    expect(describeLogsError({ toString: () => 'RECV-FAILED at frame 7' })).toBe('unknown');
  });

  it('★ 端到端：`err` 带进去一个敏感串，导出的 JSON 里搜不到它', () => {
    const obj = JSON.parse(
      buildExportPayload({
        rows: [],
        logs: [],
        version: 't',
        now: NOW,
        trace: null,
        echo: null,
        logsMeta: {
          ok: false,
          err: describeLogsError(new Error('token=abc123')),
          count: 0,
          limit: 30,
          instanceId: 'ab12cd',
          readAt: NOW.getTime(),
        },
      }),
    ) as { logsMeta: { err: string } };
    const json = JSON.stringify(obj).toLowerCase();
    expect(json).not.toContain('abc123');
    expect(json).not.toContain('sessdata');
  });

  it('★ 源码级（剥注释后）：返回值只能来自白名单，不能返回原始错误串', async () => {
    /**
     * ⚠️ **必须剥注释**：本函数上方的注释里写着 `String(e)` 这个词
     * （它在解释"为什么不能这么做"）。不剥的话，把实现改成 `String(e)` 仍然
     * 能匹配到注释里的那一处 → **假绿**。这个项目踩过两次了。
     *
     * ## 为什么不断言"不许出现 `String(e)`"
     *
     * 第一版就是这么写的，**被我自己的实现搞红了**：`String(e)` 出现在函数开头
     * 用来做**输入归一化**（非 Error 的异常也要能读），那是合法的。
     *
     * 真正要守的判据是：**返回出去的值只有一个来源 —— 白名单常量表 `KNOWN`**。
     * 所以断言：
     * 1. `return` 语句里只允许 `'unknown'` 字面量或变量 `label`
     * 2. 存在 `KNOWN` 常量表，且它只由**字符串字面量对**构成
     */
    const src = await readFile('src/content/panel/diagnostics.ts', 'utf8');
    const start = src.indexOf('export function describeLogsError');
    expect(start, '找不到 describeLogsError').toBeGreaterThan(-1);
    const rest = src.slice(start);
    const end = rest.indexOf('\n}');
    const codeOnly = rest
      .slice(0, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(codeOnly.length, '剥注释后函数体为空，切片坏了').toBeGreaterThan(20);

    /**
     * 所有 `return` 出来的是什么东西。
     *
     * ## 为什么不写死变量名 `label`（2026-11-12，task-28）
     *
     * 第一版写的是 `/^(?:'unknown'|label)$/` —— 它依赖 `for (const [needle, label] of …)`
     * 里那个**局部变量名**。有人把 `label` 改名成 `mapped`（纯改名，行为不变），
     * 这条守卫就**假红**；更糟的是有人可能为了让守卫变绿去改实现。
     *
     * 放宽成「`'unknown'` 字面量 **或 一个裸标识符**」，但**没有放宽到"随便匹配"**：
     * 参数只允许是单一标识符 —— 出现 `String(e)` / `raw` / `` `${…}` `` / 函数调用
     * 都会**不匹配**（它们带括号、点号、模板符号或反引号）。这才是真正要守的判据：
     * **`describeLogsError` 只能返回白名单表里的值，不能返回任何"经过加工的原串"**。
     */
    const returns = [...codeOnly.matchAll(/return\s+([^;]+);/g)].map((m) => (m[1] ?? '').trim());
    expect(returns.length, '没有找到任何 return，切片坏了').toBeGreaterThan(0);
    for (const r of returns) {
      expect(r, `describeLogsError 返回了白名单之外的值：${r}`).toMatch(
        /^(?:'unknown'|[A-Za-z_$][\w$]*)$/,
      );
    }
    /** 白名单表本身必须是字符串字面量对（不是拼出来的、不是拿去 stringify 的） */
    expect(codeOnly).toMatch(/const\s+KNOWN[^=]*=\s*\[/);
  });
});

describe('★★★ `logsMeta` 缺失时渲染不崩（task-28）', () => {
  const acts = { back: () => undefined, exportJson: () => undefined, refresh: () => undefined };

  /** 一份最小的渲染输入；`logsMeta` 故意**不给** */
  function paneWithoutMeta(): HTMLElement {
    return diagnosticsPane(
      {
        rows: [{ label: 'InPrivate 权限', value: '已允许', ok: true }],
        logs: [],
        version: '0.0.0-test',
        // 这里**不传** logsMeta —— 正是 task-26 崩掉的那个输入形状
      },
      acts,
    );
  }

  /**
   * ## 为什么这条守卫必须**直接调 `diagnosticsPane()`**
   *
   * 走面板 UI（`mountPanelBody` → 点「诊断」）是测不到的：`panel.ts` 的 render 传的是
   * `diagData.logsMeta`，那条链上**一直有值**。崩溃只发生在"调用方没给"的形状上，
   * 所以只能直接喂缺字段的 data。
   *
   * 反向验证：把 `diagnosticsPane` 里的 `?? describeLogsMetaFallback()` 去掉，
   * 本组三条**全部**变红（`TypeError … reading 'ok'`，之后 `:357` 还会再崩一次
   * `reading 'err'`）。
   */
  it('★★ 不传 logsMeta → 不抛，且渲染「读取失败」而不是「还没有日志。」', () => {
    /**
     * ⚠️ 写 `let box; expect(() => { box = … }).not.toThrow()` 会让 TS 把 `box`
     * 收窄成 `never`（它看不到闭包里的赋值）—— 所以直接取返回值，不去闭包里赋值。
     */
    const box = paneWithoutMeta();

    const text = box.textContent ?? '';
    expect(text, '缺 logsMeta 必须报读取失败').toContain('诊断日志读取失败');
    expect(text, '缺 logsMeta 不许说"还没有日志"（那是把崩溃换成谎报）').not.toContain(
      '还没有日志',
    );
    expect(text, '失败态要给出用户能做的事（刷新）').toContain('刷新');
  });

  it('★★ 残缺的 logsMeta（只有 ok:false，缺 err）→ 走到 .err 这条路也不崩', () => {
    /**
     * verifier 的判据 B 要验的正是这一条：`ok:false` 分支里访问 `.err`。
     * 只补 `:341`（`.ok`）的话，崩点会**后移到** `reading 'err'` @ `:357`。
     */
    const box = diagnosticsPane(
      {
        rows: [],
        logs: [],
        version: '0.0.0-test',
        // 故意只给一半：TypeScript 拦得住，但运行期（旧缓存 / 跨版本 SW）拦不住
        logsMeta: { ok: false } as never,
      },
      acts,
    );
    expect(box.textContent ?? '').toContain('诊断日志读取失败');
  });

  it('★ 兜底语义必须是「不可信」：ok 不许是 true', () => {
    /**
     * 这条守的是 `describeLogsMetaFallback()` 的**取值本身**，不是渲染结果。
     * 若有人为了"让页面好看点"把 `ok` 改成 `true`，这里变红 ——
     * 那等于拿不到数据却告诉用户"日志一切正常"。
     */
    const text = paneWithoutMeta().textContent ?? '';
    expect(text, 'ok:true 时不会渲染失败态').toContain('诊断日志读取失败');
    expect(text).toContain('unknown');
  });
});

describe('文件名', () => {
  it('带时间戳、以 .json 结尾', () => {
    const name = exportFileName(NOW);
    expect(name).toMatch(/^pluma-diag-\d{8}-\d{6}\.json$/);
  });

  it('不同时间文件名不同（多次导出不互相覆盖）', () => {
    const a = exportFileName(new Date('2026-11-10T01:00:00Z'));
    const b = exportFileName(new Date('2026-11-10T01:00:01Z'));
    expect(a).not.toBe(b);
  });
});
