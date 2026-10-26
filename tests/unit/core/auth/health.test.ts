import { describe, expect, it } from 'vitest';

import {
  applyVerdict,
  FAILURE_THRESHOLD,
  INITIAL_HEALTH,
  needsRecheck,
  toAccountHealth,
  type HealthRecord,
} from '@core/auth/health';
import { HEALTH_TTL_MS } from '@core/auth/account-info';

/**
 * 守的是"不要因为一次网络抖动就吓用户"。
 *
 * 累积状态的意义全在这里：单次失败不报警，`-101` 立即报警。
 */

const NOW = 1_760_000_000_000;

const ok = {
  kind: 'healthy' as const,
  summary: {
    profile: { mid: 1, uname: 'u', avatarUrl: null },
    vipLabel: 'annual' as const,
    expireAt: null,
    health: { healthy: true, checkedAt: NOW, reason: null },
  },
};

const expired = { kind: 'expired' as const, reason: '-101' };
const unknown = { kind: 'unknown' as const, reason: '网络不可达' };

describe('applyVerdict', () => {
  it('成功一次就清空所有失败计数', () => {
    const dirty: HealthRecord = {
      expired: true,
      checkedAt: 1,
      consecutiveFailures: 5,
      reason: '旧原因',
    };
    const next = applyVerdict(dirty, ok, NOW);
    expect(next).toEqual({
      expired: false,
      checkedAt: NOW,
      consecutiveFailures: 0,
      reason: null,
    });
  });

  it('明确 -101 立即失效，不等阈值', () => {
    const next = applyVerdict(INITIAL_HEALTH, expired, NOW);
    expect(next.expired).toBe(true);
    expect(next.reason).toBe('-101');
  });

  it('单次网络失败不置失效（阈值未到）', () => {
    const next = applyVerdict(INITIAL_HEALTH, unknown, NOW);
    expect(next.expired).toBe(false);
    expect(next.consecutiveFailures).toBe(1);
    // 不报警，但也不刷新 checkedAt —— 它记的是"最近一次成功"
    expect(next.checkedAt).toBe(0);
  });

  it(`连续 ${FAILURE_THRESHOLD} 次失败才置失效`, () => {
    let rec = INITIAL_HEALTH;
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i += 1) rec = applyVerdict(rec, unknown, NOW);
    expect(rec.expired).toBe(false);

    rec = applyVerdict(rec, unknown, NOW);
    expect(rec.expired).toBe(true);
  });

  it('已失效时再来一次成功要恢复正常', () => {
    let rec = applyVerdict(INITIAL_HEALTH, expired, NOW);
    expect(rec.expired).toBe(true);
    rec = applyVerdict(rec, ok, NOW);
    expect(rec.expired).toBe(false);
    expect(rec.consecutiveFailures).toBe(0);
  });
});

describe('needsRecheck', () => {
  it('从未校验过 → 要查', () => {
    expect(needsRecheck(INITIAL_HEALTH, NOW)).toBe(true);
  });

  it('刚校验过 → 不用查', () => {
    const rec = applyVerdict(INITIAL_HEALTH, ok, NOW);
    expect(needsRecheck(rec, NOW + 1000)).toBe(false);
  });

  it('超过 TTL → 要查', () => {
    const rec = applyVerdict(INITIAL_HEALTH, ok, NOW);
    expect(needsRecheck(rec, NOW + HEALTH_TTL_MS + 1)).toBe(true);
  });

  it('已失效 → 永远要查（用户可能已在别处重登）', () => {
    const rec = applyVerdict(INITIAL_HEALTH, expired, NOW);
    expect(needsRecheck(rec, NOW)).toBe(true);
  });
});

describe('toAccountHealth', () => {
  it('落盘格式与 UI 视图互不影响（改一个不会带坏另一个）', () => {
    const rec = applyVerdict(INITIAL_HEALTH, ok, NOW);
    expect(toAccountHealth(rec)).toEqual({ healthy: true, checkedAt: NOW, reason: null });
    // 原始记录里多出来的字段不该出现在视图里
    expect(Object.keys(toAccountHealth(rec)).sort()).toEqual(['checkedAt', 'healthy', 'reason']);
  });
});
