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
import { buildExportPayload, exportFileName } from '../../../src/content/panel/diagnostics';
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
    { label: '播放账号凭据', value: '已配置', ok: true },
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
  it('payload 的顶层键恰好是 exportedAt / version / facts / logs / trace / echo', () => {
    /**
     * 多一个字段就可能多一条泄漏路径，少了也不会报错 —— 两边都得钉住。
     * 反例：往 `buildExportPayload` 里加 `credential: ...` → 本条必红。
     *
     * ⚠️ 两个调试字段是 2026-11-10 加的，理由：主日志是环形缓冲会被冲掉，
     * 定位信息必须有一条挤不掉的通道 —— `trace` 走 storage（可能写不进），
     * `echo` 走消息应答（没丢过）。**加字段就要改这里**，这正是本断言的作用。
     */
    const obj = JSON.parse(payload(realRows(), realLogs())) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual([
      'echo',
      'exportedAt',
      'facts',
      'logs',
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
     * 把它放进自检行 = 直接把播放账号凭据印在诊断页上、并随导出流传出去。
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
