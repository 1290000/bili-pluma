// @vitest-environment jsdom

/**
 * ## 步骤 3：`same-identity` 不许遮蔽其他诊断（`tipFor()` 的优先级）
 *
 * ### 修的是什么 bug
 *
 * 单账号模式（取流号 == 页面身份号）下 `primary.usable` 恒为 `false`。
 * 若那一行照旧带 `ok: false`，`tipFor()` 的**第一个 `return`** 就是
 * 「主账号基线不可用」（`collect.ts` 里 `primaryRow` 排在最前），于是：
 *
 *   - 「代理已关闭，所有请求以主账号身份发出」
 *   - 「代理开了但全局规则没装上」
 *   - 「标签页规则为 0」（正常）
 *
 * ……**全部不可能被用户看到**。而用户此刻最需要看的恰恰是这些。
 *
 * 更严重的是：它把一个**正常状态**报成异常。他的号本来就只有这一个，
 * 什么都不缺，却在诊断台顶部看到红字说基线坏了。
 *
 * ### 修法（采用 `collect.ts` 已有的三态设计，不扩 `DiagRow` 类型）
 *
 * | `ok` | 含义 | `tipFor` 行为 |
 * | --- | --- | --- |
 * | `undefined` | 中性（不需要关注） | **不报警**，往下走到别的行 |
 * | `false` | 确实坏了 | 报警 |
 * | `true` | 正常 | 往下走 |
 *
 * `same-identity` 就是第三态。所以修复是**不给那一行设 `ok`**，
 * 而不是改 `tipFor()` 的排序 —— 改排序要扩公共类型，收益只有一个枚举值。
 *
 * ### 反例（改回去必须变红）
 *
 * 1. 把 `...(neutral ? {} : { ok: primary.usable })` 改回 `ok: primary.usable`
 *    → 「不遮蔽」那几条全红
 * 2. 把 `neutral` 判据写成 `ok: primary.usable || neutral`（标成"正常 ✓"）
 *    → 「中性 ≠ 正常」那条红
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryPageState: vi.fn(),
}));

vi.mock('@platform/page/page-state-client', () => ({
  queryPageState: (...a: unknown[]) => mocks.queryPageState(...a),
}));

import { collectFacts, tipFor } from '@platform/diagnostics/collect';
import type { Capability, PageTracksView, PrimaryBaselineReason } from '@shared/types/playinfo';

const CAP: Capability = {
  maxHeight: 1080,
  maxFrameRate: 60,
  maxFrameRateAtTopHeight: 60,
  hasHiRes: false,
  hasDolbyAudio: false,
  providesDolbyVision: false,
  topTrack: null,
  videoCount: 3,
  audioCount: 2,
  topQualityIds: [80],
};

function view(
  reason: PrimaryBaselineReason,
  usable: boolean,
  cap: Capability | null,
): PageTracksView {
  return {
    pageKey: 'BV1jt421t7XH',
    p: 1,
    updatedAt: 0,
    // 假 mid：本文件只关心 reason 对 `ok` 三态的影响，mid 值无意义
    primary: { usable, reason, capability: cap, user: null, mid: '12345', loggedIn: 'yes' },
    playback: { capability: CAP },
    diff: {
      heightGain: 0,
      frameRateGain: 0,
      hiResGained: false,
      dolbyAudioGained: false,
      dolbyVisionGained: false,
      improved: false,
    },
  };
}

/** 装一套 chrome：总开关**开着**、规则齐全 —— 这样除基线外没有别的报警源 */
function installChrome(): void {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (m: { type?: string }) => {
        if (m.type === 'proxy/status')
          return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
        if (m.type === 'diag/facts') {
          return {
            type: 'diag/facts:ok',
            facts: {
              incognitoAllowed: true,
              windows: { total: 1, incognito: 0 },
              cookieStores: ['0'],
              // 全局路径规则有、标签页规则有 = 视频页正在被代理
              dnrRuleIds: { path: [10001], tab: [20001] },
            },
          };
        }
        return { type: 'stats/recent:ok', buckets: [] };
      },
      getManifest: () => ({ version: '0.0.0-test', incognito: 'split' }),
    },
    storage: { local: { get: async () => ({}) } },
  });
}

beforeEach(() => {
  mocks.queryPageState.mockReset();
  mocks.queryPageState.mockResolvedValue({ kind: 'no-tab' });
  installChrome();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rowsFor(v: PageTracksView) {
  return collectFacts({ pageView: v });
}

function baselineRow(rows: { label: string; value: string; ok?: boolean }[]) {
  return rows.find((r) => r.label.startsWith('主账号基线'));
}

describe('same-identity：基线那一行是**中性**，不是失败', () => {
  it('不设 ok 字段（三态里的"不需要关注"）', async () => {
    const rows = await rowsFor(view('same-identity', false, null));
    const row = baselineRow(rows);

    expect(row).toBeDefined();
    // 关键断言：既不是 true 也不是 false，是 undefined
    expect(row?.ok).toBeUndefined();
    expect(Object.hasOwn(row ?? {}, 'ok')).toBe(false);
  });

  it('文案是「同一身份，无需基线」，**不带**警示符号', async () => {
    const rows = await rowsFor(view('same-identity', false, null));
    const row = baselineRow(rows);

    expect(row?.value).toContain('同一身份');
    // ⚠️ 不许有 ⚠️ —— 那是异常标记，这里是正常状态
    expect(row?.value).not.toContain('⚠️');
    // 也不许说"不可用"（读起来像故障）
    expect(row?.value).not.toContain('不可用');
  });
});

describe('same-identity：不许遮蔽其他诊断（本步的核心修复）', () => {
  it('tipFor() **不再**先报「主账号基线不可用」', async () => {
    const rows = await rowsFor(view('same-identity', false, null));
    const tip = tipFor(rows);

    expect(tip).not.toContain('主账号基线不可用');
  });

  it('tipFor() 会走到 DNR 那几条，如实报"规则齐全"', async () => {
    const rows = await rowsFor(view('same-identity', false, null));
    const tip = tipFor(rows);

    /**
     * 这是"遮蔽被解开"的直接证据：说明判据顺利穿过了
     * `primaryRow` → `proxyRow` → `pathRow` → `tabRow` 一路走到最后。
     */
    expect(tip).toContain('规则齐全');
  });

  /**
   * ## 反面：真正的失败**仍然**要报警
   *
   * 若为了修遮蔽而把 `primaryRow.ok === false` 整个删掉，
   * 那"主账号未登录 / SSR 缺失"这类**真该报**的场景就会静默。
   * 这条守的就是那个边界。
   */
  it('对照：真的失败（client-written）→ tipFor 仍然先报基线', async () => {
    const rows = await rowsFor(view('client-written', false, null));
    const tip = tipFor(rows);

    expect(tip).toContain('主账号基线不可用');
  });

  it('对照：absent（没有 SSR 数据）也是真失败 → 仍然先报', async () => {
    const rows = await rowsFor(view('absent', false, null));
    expect(tipFor(rows)).toContain('主账号基线不可用');
  });

  it('对照：正常可用基线（ssr）→ ok:true，且不报警', async () => {
    const rows = await rowsFor(view('ssr', true, CAP));
    const row = baselineRow(rows);

    expect(row?.ok).toBe(true);
    expect(tipFor(rows)).not.toContain('主账号基线不可用');
  });
});

describe('same-identity：中性 ≠ 正常', () => {
  /**
   * 一条容易犯的错：为了让 `tipFor` 不报警，把 `ok` 设成 `true`。
   * 那样这行会被渲染成"正常 ✓"，而它其实只是"不适用" ——
   * 用户会以为基线是好的，去看画质对比时才发现没有对比。
   *
   * 所以必须**不设** `ok`，让三态如实表达"不需要关注"。
   */
  it('不许标成 ok:true（那会把"不适用"说成"正常"）', async () => {
    const rows = await rowsFor(view('same-identity', false, null));
    expect(baselineRow(rows)?.ok).not.toBe(true);
  });
});
