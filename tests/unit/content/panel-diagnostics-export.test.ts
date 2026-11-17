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
  type LoadingExport,
} from '../../../src/content/panel/diagnostics';
import type { DiagEntry, DiagRow } from '../../../src/platform/diagnostics/collect';
import type { LoadingOutcome } from '../../../src/content/panel/loading-pane';
import type { LoadingSnapshotLite } from '../../../src/content/isolated/loading-trace';

/** 会被当作"泄漏"的敏感串。大小写都算。 */
const SECRETS = [
  'deadbeef,1700000000,1*FAKEsessdata', // SESSDATA 值
  '8bf1e88c2633143a485be4ad40e29c7e', // bili_jct 值
  '1000002', // 播放账号 DedeUserID
  'SESSDATA=',
  'bili_jct=',
  'DedeUserID=',
];

/**
 * 取流 URL 里那几个"看着不像凭据、其实是凭据"的参数名（2026-11-17，T8）。
 *
 * ## 为什么它们必须进词表
 *
 * 加载快照里只有 hostname（采集侧把 query 全丢了），理论上扫不到这些词。
 * 但"理论上有防线"与"有检查"是两件事 —— 这个项目已经踩过多次
 * 「实现看着对、没有任何东西在验」。所以词表里放的是**如果哪天有人
 * 把 `hostFromUrl` 换成 `url`，第一个会露出来的那些词**。
 *
 * `https?://` 同理：一旦哪条路径带进来一个完整 URL，它一定出现。
 * ⚠️ `sign` 用词边界：`/sign/` 会误伤 `design`，而误报会逼人删掉这条检查。
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /upsig/i,
  /uparams/i,
  /w_rid/i,
  /\bsign\b/i,
  /\btoken\b/i,
  /https?:\/\//i,
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
    /**
     * 第八个字段（2026-11-17，T8）：本次加载。
     *
     * ⚠️ 默认给的是一份**真实形状**的快照（含一条带 `note` 的事件）——
     * 一份"干净的假数据"证明不了 `note` 被剥掉，而 `note` 正是本轮
     * 唯一一条"少写一行就泄漏"的地方。
     */
    loading: { kind: 'ok', snapshot: loadingSnapshot() },
  });
}

/**
 * 一份实测快照（与 `poc/probe/pcdn-diag` 同源）。
 *
 * ⚠️ 第 3 条事件带着 `note: 'MediaError.code=3'` —— 真实的 `error` 事件就是
 * 长这样（`loading-trace.ts` 把 `MediaError.code` 塞进 `note`）。
 * 它是本文件的**主要假想泄漏源**：导出必须把它剥掉。
 */
function loadingSnapshot(overrides: Partial<LoadingSnapshotLite> = {}): LoadingSnapshotLite {
  return {
    present: true,
    confidence: 'measured',
    actual: { host: 'cn-jsnt-ct-01-07.bilivideo.com', cls: 'official', flavor: 'self-built' },
    hosts: [
      { host: 'cn-jsnt-ct-01-07.bilivideo.com', cls: 'official', flavor: 'self-built', count: 12 },
      { host: 'cn-jsnt-ct-01-06.bilivideo.com', cls: 'official', flavor: 'self-built', count: 11 },
      { host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null, count: 1 },
    ],
    events: [
      { t: 1772, stage: 'stall' },
      { t: 2525.9, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
      // 开局耗时取这一条（`playing.t` = 2525.9ms → 2.53s）
      { t: 2525.9, stage: 'playing' },
      { t: 3737.1, stage: 'error', note: 'MediaError.code=3' },
    ],
    truncated: false,
    video: { readyState: 4, durationSec: 213, height: 360, errorCode: 0 },
    ...overrides,
  };
}

describe('★ 面板诊断导出不含凭据', () => {
  it('常规 facts + logs 里搜不到任何敏感串', () => {
    const json = payload(realRows(), realLogs()).toLowerCase();
    for (const s of SECRETS) {
      expect(json, `导出里出现了 ${s}`).not.toContain(s.toLowerCase());
    }
  });

  it('★ 整包里搜不到取流 URL 的参数名 / 完整 URL（T8 扩的词表）', () => {
    const json = payload(realRows(), realLogs());
    for (const re of FORBIDDEN_PATTERNS) {
      expect(re.test(json), `导出里命中了 ${String(re)}`).toBe(false);
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
  it('payload 的顶层键恰好是 exportedAt / version / facts / logs / trace / echo / logsMeta / loading', () => {
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
     *
     * ⚠️ `loading` 是 2026-11-17（T8，第八个），由 `buildLoadingExport()` 产出。
     * 它也是白名单式的（四个键 + 三个枚举），**不许**把快照整个摊平进来。
     */
    const obj = JSON.parse(payload(realRows(), realLogs())) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual([
      'echo',
      'exportedAt',
      'facts',
      'loading',
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
        // 第八个字段也要给（必填）—— 这一条测的是 err 白名单，给它最空的一态
        loading: { kind: 'absent' },
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
        // （`loading` 是必填项，与本条要验的 logsMeta 无关，给 absent 即可）
        loading: { kind: 'absent' },
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
        loading: { kind: 'absent' },
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

// ─────────────────────── 第八个字段：本次加载（T8，2026-11-17）───────────────────────

/** 只取导出里那一块 —— 隔离检查，不受 `facts` 里既有路径串的干扰 */
function loadingOf(outcome: LoadingOutcome): LoadingExport {
  const json = buildExportPayload({
    rows: [],
    logs: [],
    version: '0.0.0-test',
    now: NOW,
    trace: null,
    echo: null,
    logsMeta: {
      ok: true,
      err: null,
      count: 0,
      limit: 30,
      instanceId: 'ab12cd',
      readAt: NOW.getTime(),
    },
    loading: outcome,
  });
  return (JSON.parse(json) as { loading: LoadingExport }).loading;
}

describe('★ loading：四条硬裁剪（每条一个用例）', () => {
  it('★★ 剥 note：带 `MediaError.code=3` 的事件导出后，note 与 MediaError 都不见了', () => {
    /**
     * ## 这条是本轮**唯一一条"少写一行就泄漏"**的守卫
     *
     * `LoadEvent.note` 是自由文本（`error` 事件写的正是 `MediaError.code`）。
     * 实现里只要图省事写成 `{ ...e }`，它就会跟着出去 ——
     * 而且导出包看起来"结构完全正常"，没有任何东西会报错。
     *
     * 反例：把 `buildLoadingExport` 里的逐个挑字段改成 `{ ...e }` → 本条必红。
     *
     * ## 2026-11-17（T13，P1-6）：`code` 是**解析后的数字**，不是 `note` 透传
     *
     * `"code":3` 是白名单解析的产物（`parseErrorCode()` 只认 `code=数字`），
     * 所以 `code=3` 这个**文本**仍然不许出现 —— 出现了就说明有人把 note 透传了。
     */
    const out = loadingOf({ kind: 'ok', snapshot: loadingSnapshot() });
    const text = JSON.stringify(out);
    expect(text).not.toContain('MediaError');
    expect(text).not.toContain('note');
    expect(text).not.toContain('code=3');
    // 但数字形态的 code 必须在（否则 MediaError.code 又被扔了）
    expect(text).toContain('"code":3');

    // 键集合也钉死：`note` 永远不在里面；`code` 只出现在 error 那条上
    const allowed = new Set(['t', 'stage', 'host', 'kind', 'code']);
    for (const e of out.events) {
      for (const k of Object.keys(e)) expect(allowed.has(k), `导出了多余的键 ${k}`).toBe(true);
    }
    expect(Object.keys(out.events[1] ?? {})).toEqual(['t', 'stage', 'host', 'kind']);
    // error 那条：t / stage / code（没有 host / kind，也不带 note）
    expect(Object.keys(out.events[3] ?? {})).toEqual(['t', 'stage', 'code']);
  });

  it('★ host 白名单化：带 query / 端口 / 路径的一律写成 invalid', () => {
    const dirty = loadingSnapshot({
      actual: { host: 'evil.example/?upsig=abc', cls: 'official', flavor: null },
      hosts: [{ host: 'Evil.Example:8080', cls: 'official', flavor: null, count: 3 }],
    });
    const out = loadingOf({ kind: 'ok', snapshot: dirty });
    expect(out.actual?.host).toBe('invalid');
    expect(out.hosts[0]?.host).toBe('invalid');
    // 原文一个字节都不许留
    const text = JSON.stringify(out);
    expect(text).not.toContain('upsig');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('8080');
  });

  it('★ 枚举化：不认识的 stage / kind / cls / flavor 只落固定值，原串不外泄', () => {
    const junk = loadingSnapshot({
      actual: { host: 'a.bilivideo.com', cls: 'wat' as never, flavor: 'weird' as never },
      events: [
        { t: 10, stage: 'bogus' as never },
        { t: 20, stage: 'seg-req', kind: 'wat' as never },
      ],
      hosts: [{ host: 'a.bilivideo.com', cls: 'wat' as never, flavor: 'weird' as never, count: 1 }],
    });
    const out = loadingOf({ kind: 'ok', snapshot: junk });

    expect(out.actual?.cls).toBe('unknown');
    expect(out.actual?.flavor).toBe('partner'); // 兜底值，但仍是**允许集合**里的值
    expect(out.events.map((e) => e.stage)).toEqual(['unknown', 'seg-req']);
    expect(out.events[1]?.kind).toBe('unknown');

    const text = JSON.stringify(out);
    expect(text).not.toContain('bogus');
    expect(text).not.toContain('wat');
    expect(text).not.toContain('weird');
  });

  it('★ 无 query / 无 path：loading 子树里一个 ? 一个 / 都没有', () => {
    /**
     * ⚠️ 只扫 `loading` 这一块，**不扫整包**：`facts` 里有一行真实的自检值
     * `filter=/x/player/wbi/playurl`（见 `realRows()`），那是既有的、正当的内容。
     * 整包断言"没有 `/`"会把它判成违规，而为了让那条变绿只能删掉自检信息 ——
     * 那是拿"检查好看"换掉"排查有用"。
     */
    const text = JSON.stringify(loadingOf({ kind: 'ok', snapshot: loadingSnapshot() }));
    expect(text).not.toContain('?');
    expect(text).not.toContain('/');
  });

  it('★ loading 里没有任何时间戳字段（`capturedAt` 已被裁决删除）', () => {
    /**
     * 第一版有一个 `capturedAt`，值是"组装导出的时刻"—— 名字在说谎（读的人会
     * 以为"快照是那一刻抓的"），而且与顶层 `exportedAt` 是同一份数据写两遍。
     *
     * 反例：把 `capturedAt` 加回 `buildLoadingExport` → 本条必红。
     */
    const out = loadingOf({ kind: 'ok', snapshot: loadingSnapshot() });
    expect(Object.keys(out)).toEqual([
      'status',
      'present',
      'confidence',
      'actual',
      'hosts',
      'hostCount',
      'hostsTruncated',
      'events',
      'eventsTruncated',
      /**
       * 2026-11-17（T13/P1-7）：`snapshot.truncated`（采集侧环形缓冲丢过东西）
       * 的出口。它**不是**时间戳字段，所以留在这里 —— 这一条守的是"没有
       * `capturedAt` 这类会说谎的时刻字段"。
       */
      'eventsLostBeforeWindow',
      // 2026-11-17：候选过滤（ADR 0038）这一次做了什么
      'filter',
      'video',
    ]);
    expect(JSON.stringify(out)).not.toContain('capturedAt');
  });
});

describe('★ loading：三态不许合并', () => {
  it('ok → status=ok，其余字段是真数据', () => {
    const out = loadingOf({ kind: 'ok', snapshot: loadingSnapshot() });
    expect(out.status).toBe('ok');
    expect(out.present).toBe(true);
    expect(out.confidence).toBe('measured');
    expect(out.hostCount).toBe(3);
    expect(out.events).toHaveLength(4);
    expect(out.video?.durationSec).toBe(213);
  });

  it('★ absent → status=absent，其余一律空（不给看起来像数据的默认值）', () => {
    const out = loadingOf({ kind: 'absent' });
    expect(out.status).toBe('absent');
    expect(out.present).toBe(false);
    expect(out.actual).toBeNull();
    expect(out.hosts).toEqual([]);
    expect(out.hostCount).toBe(0);
    expect(out.events).toEqual([]);
    expect(out.video).toBeNull();
  });

  it('★★ unanswered 不会被写成 absent（读失败不许伪装成没有）', () => {
    /**
     * 这是 `logsMeta.ok` 那次事故的同一条纪律：读失败与"真的没有"
     * 在**导出里**也必须分得开 —— 导出恰恰是最需要它诚实的那一刻。
     */
    const out = loadingOf({ kind: 'unanswered' });
    expect(out.status).toBe('unanswered');
    expect(out.status).not.toBe('absent');
    expect(out.status).not.toBe('ok');
  });
});

describe('★ loading：截断上限', () => {
  it('hosts 最多 20 条，但 hostCount 仍是总数', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      host: `cn-node-${String(i)}.bilivideo.com`,
      cls: 'official' as const,
      flavor: 'self-built' as const,
      count: 100 - i,
    }));
    const out = loadingOf({ kind: 'ok', snapshot: loadingSnapshot({ hosts: many }) });
    expect(out.hosts).toHaveLength(20);
    expect(out.hostCount).toBe(25);
    expect(out.hostsTruncated).toBe(true);
  });

  it('events 最多 40 条，并置 eventsTruncated', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ t: i * 10, stage: 'stall' as const }));
    const out = loadingOf({ kind: 'ok', snapshot: loadingSnapshot({ events: many }) });
    expect(out.events).toHaveLength(40);
    expect(out.eventsTruncated).toBe(true);
  });

  it('没超上限时两个 truncated 都是 false', () => {
    const out = loadingOf({ kind: 'ok', snapshot: loadingSnapshot() });
    expect(out.hostsTruncated).toBe(false);
    expect(out.eventsTruncated).toBe(false);
  });
});

// ─────────────────────── 诊断页「本次加载」区块（T7，2026-11-17）───────────────────────

describe('★★ 诊断页「本次加载」（T7）', () => {
  const acts = { back: () => undefined, exportJson: () => undefined, refresh: () => undefined };

  function pane(outcome?: LoadingOutcome): HTMLElement {
    return diagnosticsPane(
      {
        rows: [],
        logs: [],
        version: '0.0.0-test',
        /**
         * ⚠️ `logsMeta` 必须给一个**正常**值。
         *
         * 不给的话 `describeLogsMetaFallback()` 会渲染出「诊断日志读取失败」那一行 ——
         * 它也是一个 `.diag-row`，会混进本组对 `.diag-label` / `textContent` 的断言里
         * （第一版就是这么红的：多出一个"诊断日志读取失败"标签）。本组要测的是
         * **本次加载那一块**，所以把日志那一段固定在"没有日志"的正常态。
         */
        logsMeta: {
          ok: true,
          err: null,
          count: 0,
          limit: 30,
          instanceId: 'ab12cd',
          readAt: NOW.getTime(),
        },
        /**
         * 2026-11-17（审计收尾）：这个字段在 `diagnosticsPane()` 里改成**必填** ——
         * "还没读到"那条路（会渲染成「不是播放页」的因果断言）被类型去掉了。
         * 本组要测的是"本次加载"那一块，缺省给 `absent` 是**测试自己的形状要求**，
         * 与产品里 `buildPanelModel()` 恒填 `loading` 无关。
         */
        loading: outcome ?? { kind: 'absent' },
      },
      acts,
    );
  }

  it('ok：技术摘要 + 原始事件入口', () => {
    const box = pane({ kind: 'ok', snapshot: loadingSnapshot() });
    const labels = [...box.querySelectorAll('.diag-label')].map((n) => n.textContent);
    /**
     * 2026-11-17（T13）：
     * - 主要线路与当前线路是**同一条**时只显示一行「当前线路」（P0-2）
     * - 新增「采集窗口」（P1-7）
     */
    expect(labels).toEqual([
      '当前线路',
      '本次线路',
      '开局耗时',
      '换线次数',
      '快照状态',
      '采集窗口',
    ]);

    const values = [...box.querySelectorAll('.diag-value')].map((n) => n.textContent);
    // 技术名，不是「B站官方线路」那套用户文案
    expect(values[0]).toBe('official · self-built · cn-jsnt-ct-01-07.bilivideo.com');
    // 括号里给按类别的条数
    expect(values[1]).toBe('3 条（官方 2 · PCDN 1）');
    // playing.t = 2525.9ms
    expect(values[2]).toBe('2.53s');
    // 采集窗口：没有丢过东西
    expect(values[5]).toBe('完整');
  });

  it('★ P0-2：主要线路 ≠ 当前线路时，两行都显示（别二选一）', () => {
    /**
     * 反例（旧实现）：只有一行「当前线路」，值取自 argmax ——
     * 中途被切到 PCDN 之后，它会指着一条**已经不再用**的线路说"当前"。
     */
    const switched = loadingSnapshot({
      hosts: [
        {
          host: 'cn-jsnt-ct-01-07.bilivideo.com',
          cls: 'official',
          flavor: 'self-built',
          count: 12,
        },
        { host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', cls: 'pcdn', flavor: null, count: 1 },
      ],
      events: [
        { t: 1000, stage: 'seg-req', host: 'cn-jsnt-ct-01-07.bilivideo.com', kind: 'official' },
        { t: 2000, stage: 'seg-req', host: 'xy220x180x77x45xy.mcdn.bilivideo.cn', kind: 'pcdn' },
      ],
    });
    const box = pane({ kind: 'ok', snapshot: switched });
    const labels = [...box.querySelectorAll('.diag-label')].map((n) => n.textContent);

    expect(labels).toContain('主要线路（按请求数）');
    expect(labels).toContain('当前线路（最后一次请求）');
    // 两行并存时不再出现那个含糊的旧标签
    expect(labels).not.toContain('当前线路');

    const values = [...box.querySelectorAll('.diag-value')].map((n) => n.textContent);
    // 主要线路 = argmax（12 > 1）
    expect(values[0]).toBe('official · self-built · cn-jsnt-ct-01-07.bilivideo.com');
    // 当前线路 = 最后一条 seg-req；`flavor === null` 显示破折号（不是字面 null）
    expect(values[1]).toBe('pcdn · — · xy220x180x77x45xy.mcdn.bilivideo.cn');

    // 当前线路是 P2P → 那一行必须黄（用户此刻正在被切走）
    const warns = [...box.querySelectorAll('.diag-row.warn')].map(
      (n) => n.querySelector('.diag-label')?.textContent,
    );
    expect(warns).toContain('当前线路（最后一次请求）');
  });

  it('两者是同一条时只显示一行「当前线路」（不啰嗦）', () => {
    const box = pane({ kind: 'ok', snapshot: loadingSnapshot() });
    const labels = [...box.querySelectorAll('.diag-label')].map((n) => n.textContent);
    expect(labels).toContain('当前线路');
    expect(labels).not.toContain('主要线路（按请求数）');
    expect(labels).not.toContain('当前线路（最后一次请求）');
  });

  it('★ P1-7：采集窗口 —— 截断时明说「早期事件被丢弃」', () => {
    const full = pane({ kind: 'ok', snapshot: loadingSnapshot() });
    expect(
      [...full.querySelectorAll('.diag-label')].some((n) => n.textContent === '采集窗口'),
    ).toBe(true);

    const cut = pane({ kind: 'ok', snapshot: loadingSnapshot({ truncated: true }) });
    const values = [...cut.querySelectorAll('.diag-value')].map((n) => n.textContent);
    expect(values).toContain('已截断（早期事件被丢弃）');
    // 截断的行要显眼（红点），因为"时间轴开头不是页面开始"
    const bad = [...cut.querySelectorAll('.diag-row.bad')].map(
      (n) => n.querySelector('.diag-label')?.textContent,
    );
    expect(bad).toContain('采集窗口');
  });

  it('★ P1-7：导出里两个 truncated 互相独立（不是同一件事）', () => {
    /**
     * | 字段 | 谁丢的 |
     * | --- | --- |
     * | `eventsTruncated` | 导出这一层只装 40 条 |
     * | `eventsLostBeforeWindow` | 采集器的环形缓冲 |
     *
     * 反例：让 `eventsLostBeforeWindow` 读 `eventsTruncated`（或反过来）→ 下面
     * 两个组合里必有一个红。
     */
    const few = loadingSnapshot({ truncated: true });
    const outA = loadingOf({ kind: 'ok', snapshot: few });
    expect(outA.eventsTruncated).toBe(false);
    expect(outA.eventsLostBeforeWindow).toBe(true);

    // 60 条事件、但采集侧没丢过
    const many = loadingSnapshot({
      truncated: false,
      events: Array.from({ length: 60 }, (_, i) => ({ t: i, stage: 'stall' as const })),
    });
    const outB = loadingOf({ kind: 'ok', snapshot: many });
    expect(outB.eventsTruncated).toBe(true);
    expect(outB.eventsLostBeforeWindow).toBe(false);
  });

  it('★ P1-6：导出里 error 带 code；解析不到就**不加这个键**', () => {
    const withCode = loadingOf({
      kind: 'ok',
      snapshot: loadingSnapshot({
        events: [{ t: 100, stage: 'error', note: 'code=3' }],
      }),
    });
    expect(withCode.events[0]).toEqual({ t: 100, stage: 'error', code: 3 });

    const noCode = loadingOf({
      kind: 'ok',
      snapshot: loadingSnapshot({ events: [{ t: 100, stage: 'error' }] }),
    });
    // 不许写 0：0 是 MEDIA_ERR_ABORTED 的合法码，写下去等于陈述"用户主动中止了"
    expect(Object.keys(noCode.events[0] ?? {})).toEqual(['t', 'stage']);
  });

  it('ok：观测到 PCDN 时那两行变警告色（.diag-row.warn）', () => {
    const box = pane({ kind: 'ok', snapshot: loadingSnapshot() });
    const warns = [...box.querySelectorAll('.diag-row.warn')].map(
      (n) => n.querySelector('.diag-label')?.textContent,
    );
    // 本次线路里有 PCDN 1 条 → 至少那行要黄
    expect(warns).toContain('本次线路');
  });

  it('★ absent：一行中性色，且**不出现**「读取失败」', () => {
    const box = pane({ kind: 'absent' });
    const text = box.textContent ?? '';
    expect(text).toContain('本页没有加载记录（不是播放页）');
    expect(text).not.toContain('读取失败');
    // 没有可展开的原始事件（导出按钮仍在，所以按文案找）
    const raw = [...box.querySelectorAll('.sub-entry')].filter((n) =>
      (n.textContent ?? '').includes('原始事件'),
    );
    expect(raw).toHaveLength(0);
  });

  it('★★ unanswered：危险色，且**不是**「没有记录」', () => {
    /**
     * 反例：把 `loadingSectionNodes` 的 `unanswered` 分支改成和 `absent` 一样
     * → 本条必红（它会显示"本页没有加载记录"，把人送去查错方向）。
     */
    const box = pane({ kind: 'unanswered' });
    const text = box.textContent ?? '';
    expect(text).toContain('加载快照读取失败（无应答）');
    expect(text).toContain('刷新页面后重试');
    expect(text).not.toContain('本页没有加载记录');
    expect(box.querySelector('.diag-row.bad')).not.toBeNull();
  });

  it('★ 审计收尾：`loading` 必填，`undefined` 那条路已被**类型**去掉', async () => {
    /**
     * ## 修的是什么
     *
     * 旧签名 `loading?: LoadingOutcome | undefined` 让"还没读到"复用 `absent`
     * 的文案 ——「本页没有加载记录（**不是播放页**）」。而"不是播放页"是一句
     * **因果断言**，只有真正的 `absent`（`pageKind` 由 `parsePlayPage()` 判定）
     * 才有观测支撑。
     *
     * 生产侧 `panel.ts` 在 `!model` 时早退成「正在读取…」，那条路本来就不可达；
     * 所以这里把分支**用类型删掉**，而不是给它配一句新文案。
     *
     * 反例：把签名改回可选 / 恢复 `outcome === undefined` 分支 → 本条必红。
     */
    const src = await readFile('src/content/panel/diagnostics.ts', 'utf8');
    expect(src).toContain('loading: LoadingOutcome;');
    expect(src).not.toContain('loading?: LoadingOutcome');
    // `loadingSectionNodes` 的入参也跟着收窄，`undefined` 分支不存在了
    expect(src).not.toContain('outcome === undefined');
    expect(src).not.toContain('outcome?.kind');
  });

  it('absent：那句话是**观测过的**因果（页面判据说这页没有播放器）', () => {
    const text = pane({ kind: 'absent' }).textContent ?? '';
    expect(text).toContain('本页没有加载记录（不是播放页）');
  });

  it('原始事件表：默认折叠，点一下展开（箭头同时转向）', () => {
    const box = pane({ kind: 'ok', snapshot: loadingSnapshot() });
    const button = box.querySelector<HTMLButtonElement>('.sub-entry');
    const list = box.querySelector<HTMLElement>('.diag-logs');
    expect(button?.textContent).toContain('原始事件（4 条）');
    expect(list?.hidden).toBe(true);

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(list?.hidden).toBe(false);
    expect(box.querySelector('.sub-entry-chevron')?.className).toContain('open');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(list?.hidden).toBe(true);
  });

  it('原始事件的每行给技术名（`seg-req` 而不是「开始下载分片」）', () => {
    const box = pane({ kind: 'ok', snapshot: loadingSnapshot() });
    const rows = [...box.querySelectorAll('.diag-log')];
    // 事件只有 4 条，所以按钮外只有这 4 行
    expect(rows).toHaveLength(4);
    expect(rows[1]?.textContent).toContain('2525.9ms');
    expect(rows[1]?.textContent).toContain('seg-req');
    expect(rows[1]?.textContent).toContain('cn-jsnt-ct-01-07.bilivideo.com');
    expect(rows[1]?.textContent).toContain('official');
    // 阶段名不许出现中文
    expect(box.textContent ?? '').not.toContain('开始下载分片');
  });

  it('★ 超过 40 条时只渲染 40 行，并在末尾说明总数（不许静默）', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      t: i * 10,
      stage: 'stall' as const,
    }));
    const box = pane({ kind: 'ok', snapshot: loadingSnapshot({ events: many }) });
    expect(box.querySelectorAll('.diag-log')).toHaveLength(40 + 1); // +1 是那行说明
    expect(box.textContent ?? '').toContain('只显示前 40 条（共 45 条）');
  });

  it('位置：在「自检信息」之前（它是最常见的排查起点）', () => {
    const box = pane({ kind: 'ok', snapshot: loadingSnapshot() });
    const sections = [...box.querySelectorAll('.diag-section')].map((n) => n.textContent);
    expect(sections[0]).toBe('本次加载');
    expect(sections).toContain('自检信息');
    expect(sections.indexOf('本次加载')).toBeLessThan(sections.indexOf('自检信息'));
  });
});
