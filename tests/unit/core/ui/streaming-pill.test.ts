/**
 * 取流身份胶囊判据（步骤 4，2026-11-11）。
 *
 * 纯函数，`tabs.ts` 只负责接线 —— 这样 DOM 层没被覆盖时，判据仍是钉住的。
 */

import { describe, expect, it } from 'vitest';

import { describeStreamingIdentity, needsReloadHint } from '@core/ui/streaming-pill';
import type { ProxyActivateReason } from '@shared/types/messages';

describe('describeStreamingIdentity —— 两个状态都是正常态', () => {
  it('extension → 「取流：取流账号」+ 强调色', () => {
    const p = describeStreamingIdentity('extension');
    expect(p.label).toBe('取流：扩展账号');
    expect(p.accent).toBe(true);
  });

  it('page → 「取流：浏览器账号」+ 中性色', () => {
    const p = describeStreamingIdentity('page');
    expect(p.label).toBe('取流：浏览器账号');
    /**
     * ⚠️ **不许用强调色**。
     *
     * `page` 是用户合法选的另一种身份，不是"降级"。用强调色（信息色）
     * 会暗示"扩展在工作"更高级，而实际上两者都是正常配置。
     * 这正是 `AGENTS.md` 里"界面不许暗示不存在的能力/问题"的同一条纪律。
     */
    expect(p.accent).toBe(false);
  });

  it('⚠️ 任何状态下都不许出现「停用」字样', () => {
    /**
     * `page` ≠ 停用。总开关在 `page` 模式下仍然是开着的。
     * 说成"停用"会让用户以为要重新开启，而他从没关过任何东西。
     */
    for (const id of ['extension', 'page'] as const) {
      expect(describeStreamingIdentity(id).label).not.toContain('停用');
      expect(describeStreamingIdentity(id).label).not.toContain('关闭');
    }
  });

  it('两个 label 必须不同（否则胶囊没有信息量）', () => {
    expect(describeStreamingIdentity('extension').label).not.toBe(
      describeStreamingIdentity('page').label,
    );
  });
});

describe('needsReloadHint —— 只在"当前页行为与选择不一致"时提示', () => {
  /**
   * 依据：`playurl` **只在页面加载和切 P 时调一次**（`docs/03` Q3 实测）。
   * 切身份不会改变已打开页面的画质，所以必须提示刷新 —— 但**只在真的不一致时**。
   */

  const ALL_REASONS: ReadonlyArray<ProxyActivateReason | 'unknown'> = [
    'ok',
    'not-configured',
    'self',
    'page-identity',
    'disabled',
    'error',
    'unknown',
  ];

  it('extension + 本页 ok → 已一致，不提示', () => {
    expect(needsReloadHint('extension', 'ok')).toBe(false);
  });

  it('extension + 本页没在代理 → 提示刷新', () => {
    // 只测**已知**的 reason：`unknown` 属"不知道"，见下面单独那条
    const known = ALL_REASONS.filter((x) => x !== 'ok' && x !== 'unknown');
    for (const r of known) {
      expect(needsReloadHint('extension', r), `reason=${r} 时应提示`).toBe(true);
    }
  });

  it('page + 本页还在换身份(ok) → 提示刷新（老页面）', () => {
    expect(needsReloadHint('page', 'ok')).toBe(true);
  });

  it('page + 本页没在换身份 → 已一致，不提示', () => {
    const known = ALL_REASONS.filter((x) => x !== 'ok' && x !== 'unknown');
    for (const r of known) {
      expect(needsReloadHint('page', r), `reason=${r} 时不该提示`).toBe(false);
    }
  });

  it('⚠️ 拿不到回包（undefined / unknown）→ 一律不提示', () => {
    /**
     * "不知道本页用什么身份"时提示"刷新后生效"是在**编造结论**。
     * 用户刷新后发现本来就对，会认为这个提示是噪音。
     */
    for (const id of ['extension', 'page'] as const) {
      expect(needsReloadHint(id, undefined), `${id} + undefined`).toBe(false);
      expect(needsReloadHint(id, 'unknown'), `${id} + unknown`).toBe(false);
    }
  });
});
