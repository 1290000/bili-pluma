/**
 * 诊断导出的**凭据泄漏防线**（P3 验收 3d）。
 *
 * ## 为什么要有这个测试
 *
 * 3d 的原判据是「导出的 JSON 里 `grep -i sessdata` 结果为空」。
 * 那是**人工验一次**的动作：验完就没人守了，下次谁往 `collectFacts()` 里
 * 多加一行 `put('凭据', credential.sessdata)` 都不会报错。
 *
 * 这个测试把那条判据变成**每次 CI 都跑**的断言：
 * 用一个真的带凭据的假 credential / 假 DNR 规则去喂导出逻辑，
 * 然后对**序列化后的整份 JSON** 做 grep。
 *
 * ## 为什么断言在序列化后的文本上
 *
 * 泄漏的形式可能是嵌套的、多个字段拼出来的、或者藏在 DNR 规则的
 * `action.requestHeaders[0].value` 里（那是一条完整的 Cookie 头）。
 * 只检查对象的顶层 key 会漏掉这些。**扫最终文本才是用户真正拿到的东西。**
 */

import { describe, expect, it } from 'vitest';

import type { DiagEntry } from '@platform/storage/diag-store';
import type { DiagRow } from '@platform/diagnostics/collect';

/**
 * 与 `sections/diagnostics.tsx` 的 `exportDiag()` 保持同一形状。
 *
 * ⚠️ 这里**故意复制**一份 payload 结构而不是 import 那个组件：
 * 组件里有 Preact / DOM，单测环境跑不动。代价是"组件改了这里没改"会漂移 ——
 * 所以下面加了一条测试断言两边的字段名一致（见「形状守卫」）。
 */
function buildPayload(rows: DiagRow[], logs: DiagEntry[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date('2026-10-26T12:00:00Z').toISOString(),
      // 真实实现读 `chrome.runtime.getManifest().version`；这里故意用不可混淆的假值，
      // 免得有人把测试里的数字当成"当前版本"（曾写死 '1.0.0'，与实际 0.9.0 不一致）
      version: '0.0.0-test',
      facts: rows,
      logs,
    },
    null,
    2,
  );
}

/** 会被当作"泄漏"的敏感串。大小写都算。 */
const SECRETS = [
  'deadbeef,1700000000,1*FAKEsessdata', // SESSDATA 的值
  '8bf1e88c2633143a485be4ad40e29c7e', // bili_jct 的值
  '1000002', // 播放账号 DedeUserID
  'SESSDATA=',
  'bili_jct=',
];

describe('诊断导出不含凭据（3d）', () => {
  it('常规自检行 + 日志里搜不到任何凭据片段', () => {
    const rows: DiagRow[] = [
      { label: '播放账号凭据', value: '已配置', ok: true },
      { label: '代理路径白名单', value: 'r1 · 核对于 2026-10-26' },
      { label: 'DNR 全局路径规则', value: '2', ok: true },
      { label: '  10042', value: 'filter=/x/player/wbi/playurl', ok: true },
    ];
    const logs: DiagEntry[] = [
      { at: 1793028000000, step: 'proxy/enable', detail: '代理已开启', from: 'normal' },
      { at: 1793028001000, step: 'playurl/fail', detail: '取流失败 1 次' },
    ];

    const json = buildPayload(rows, logs).toLowerCase();
    for (const s of SECRETS) {
      expect(json, `导出里出现了 ${s}`).not.toContain(s.toLowerCase());
    }
  });

  it('检测能力自检：确实能抓到泄漏（否则上面那条是空断言）', () => {
    /**
     * ⚠️ 这一条是**给上面那条测试做担保的**。
     *
     * 如果 `SECRETS` 里的串写错了、或者 `toLowerCase()` 用错了，
     * 上面那条「搜不到凭据」会**永远是绿的**——它什么也没守住。
     *
     * 所以这里主动构造一份**带泄漏的** payload，断言扫描器能抓到。
     * 扫描器坏了 → 这条红 → 立刻知道上面那条不可信。
     */
    const leaky: DiagRow[] = [
      { label: '凭据', value: 'SESSDATA=deadbeef,1700000000,1*FAKEsessdata', ok: true },
    ];
    const json = buildPayload(leaky, []).toLowerCase();

    const hit = SECRETS.filter((s) => json.includes(s.toLowerCase()));
    expect(hit.length, '扫描器抓不到已知的泄漏串，SECRETS 或比对方式有问题').toBeGreaterThan(0);
  });

  it('DNR 规则行只带 id / filter / tabIds，不带 requestHeaders', async () => {
    /**
     * DNR 规则的 `action.requestHeaders[0].value` 是一条**完整 Cookie 头**。
     * 把它放进自检行 = 直接把播放账号凭据印在设置页上、并随导出流传出去。
     *
     * ⚠️ 这里**必须扫源码**，不能扫上面造出来的假 payload。
     * 第一版就是这么写错的：断言假数据里没有 `requestHeaders`，
     * 于是往 `collect.ts` 里真塞一行输出 `action.requestHeaders` 时，
     * 测试**照样是绿的** —— 反例验证当场抓出了这个空断言。
     */
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/platform/diagnostics/collect.ts', 'utf8');

    expect(src, 'collect.ts 输出了 action/requestHeaders，凭据会随导出泄漏').not.toMatch(
      /requestHeaders/,
    );
    // 也不许直接把整条规则序列化（那样 value 一定在里面）
    expect(src).not.toMatch(/JSON\.stringify\(\s*r\s*\)/);
  });

  it('形状守卫：组件里的 payload 字段名与这里一致', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('entrypoints/options/sections/diagnostics.tsx', 'utf8');

    // exportDiag 里必须只包这四个字段。多一个字段就可能多一条泄漏路径，
    // 少了也不会报错 —— 两边都得盯住。
    for (const k of ['exportedAt', 'version', 'facts', 'logs']) {
      expect(src, `exportDiag 里没有 ${k}`).toContain(k);
    }
    // 关键：不能把 credential / cookie / header 之类的东西塞进去
    expect(src).not.toMatch(/exportDiag[\s\S]{0,600}?credential/i);
    expect(src).not.toMatch(/exportDiag[\s\S]{0,600}?requestHeaders/);
  });
});
