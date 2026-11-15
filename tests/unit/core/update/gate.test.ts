import { describe, expect, it } from 'vitest';

import { canManualCheck, nextCheckAt, normalizeIntervalDays, shouldCheck } from '@core/update/gate';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

describe('shouldCheck：开关优先级', () => {
  it('autoEnabled=false 时，即使间隔早就过了也不许查', () => {
    // ⚠️ 这条是"开关成摆设"的护栏：把闸门里的开关判断挪到间隔判断之后，它会红
    expect(
      shouldCheck({ now: T0, lastCheckAt: T0 - 30 * DAY, intervalDays: 1, autoEnabled: false }),
    ).toBe(false);
  });

  it('autoEnabled=false 时，从未查过也不许查', () => {
    expect(shouldCheck({ now: T0, lastCheckAt: null, intervalDays: 1, autoEnabled: false })).toBe(
      false,
    );
  });
});

describe('shouldCheck：间隔判据', () => {
  it('从未检查过 ⇒ 该查', () => {
    expect(shouldCheck({ now: T0, lastCheckAt: null, intervalDays: 1, autoEnabled: true })).toBe(
      true,
    );
  });

  it('刚好到 1 天 ⇒ 该查（边界是 >=，不是 >）', () => {
    expect(
      shouldCheck({ now: T0, lastCheckAt: T0 - DAY, intervalDays: 1, autoEnabled: true }),
    ).toBe(true);
  });

  it('差 1 毫秒 ⇒ 不该查', () => {
    expect(
      shouldCheck({ now: T0, lastCheckAt: T0 - DAY + 1, intervalDays: 1, autoEnabled: true }),
    ).toBe(false);
  });

  it('间隔 3 天时，2 天内不查、3 天后查', () => {
    expect(
      shouldCheck({ now: T0, lastCheckAt: T0 - 2 * DAY, intervalDays: 3, autoEnabled: true }),
    ).toBe(false);
    expect(
      shouldCheck({ now: T0, lastCheckAt: T0 - 3 * DAY, intervalDays: 3, autoEnabled: true }),
    ).toBe(true);
  });

  it('时钟回拨（lastCheckAt 在未来）⇒ 该查，不能把闸门永久锁死', () => {
    expect(
      shouldCheck({ now: T0, lastCheckAt: T0 + 5 * DAY, intervalDays: 1, autoEnabled: true }),
    ).toBe(true);
  });
});

describe('normalizeIntervalDays', () => {
  it('非法值抛错，不静默钳制', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeIntervalDays(bad)).toThrow(/检查间隔/);
    }
  });

  it('小数向下取整', () => {
    expect(normalizeIntervalDays(2.9)).toBe(2);
  });
});

describe('nextCheckAt', () => {
  it('从未检查过 ⇒ 就是现在', () => {
    expect(nextCheckAt(null, 1, T0)).toBe(T0);
  });

  it('上次检查在 10 天前、间隔 1 天 ⇒ 也是现在（已经过点了）', () => {
    expect(nextCheckAt(T0 - 10 * DAY, 1, T0)).toBe(T0);
  });

  it('刚查过 ⇒ 一天后', () => {
    expect(nextCheckAt(T0, 1, T0)).toBe(T0 + DAY);
  });
});

describe('canManualCheck：只受冷却限制，与自动开关无关', () => {
  it('从没手动查过 ⇒ 可以', () => {
    expect(canManualCheck(null, T0, 60_000)).toBe(true);
  });

  it('冷却中 ⇒ 不可以', () => {
    expect(canManualCheck(T0 - 30_000, T0, 60_000)).toBe(false);
  });

  it('冷却过完 ⇒ 可以', () => {
    expect(canManualCheck(T0 - 60_000, T0, 60_000)).toBe(true);
  });
});
