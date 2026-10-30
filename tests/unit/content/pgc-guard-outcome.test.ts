/**
 * ADR 0030 方案 c：护栏从「记刷了几次」改成「记刷之后成了没有」（2026-10-30）
 *
 * ## 这个文件守什么
 *
 * `guardActionForOutcome()` 是一张**四态表**。它取代了原来
 * 「`attempts >= MAX_RELOAD_ATTEMPTS` 就不许刷」这个单一判据。
 *
 * 为什么必须逐态覆盖：方案 c 的全部价值在于「不同结果给不同处置」。
 * 只要有一个状态被并进另一态（例如把 `unknown` 并进 `still-truncated`），
 * 就会在**缺数据**的加载上白吃一次重试机会；反过来并进 `injected`
 * 则会放开无限刷新 —— 两个方向都是事故，而症状都不会立刻暴露。
 *
 * ## ⚠️ 反例验证（AGENTS.md §1.5）
 *
 * 把 `guardActionForOutcome` 里 `case 'unknown'` 从 `return 'keep'`
 * 改成 `return 'retry'` → 本文件「unknown 不消耗尝试」两条必红。
 * 把 `case 'injected'` 改成 `return 'keep'` → 「注入成功即清」两条必红。
 */
import { describe, expect, it } from 'vitest';

import {
  guardActionForOutcome,
  isRoundSatisfied,
  makeGuardAttempts,
  parseGuard,
  type PgcRoundOutcome,
} from '@/src/content/isolated/pgc-reload-plan';

/** 四态全集 —— 新增状态时这里会编译报错，强制补测试 */
const ALL_OUTCOMES: PgcRoundOutcome[] = [
  'injected',
  'native-complete',
  'still-truncated',
  'unknown',
];

describe('guardActionForOutcome：四态表', () => {
  it('★ 注入成功 → 清掉护栏（c 的核心：已达目标就不必再拦）', () => {
    expect(guardActionForOutcome('injected')).toBe('clear');
  });

  it('★ 本来就完整 → 清掉护栏（没有"达目标"的需求，护栏无意义）', () => {
    expect(guardActionForOutcome('native-complete')).toBe('clear');
  });

  it('★ 仍是试看 → 允许再刷一次（这才是护栏该拦的场景：同一原因反复刷）', () => {
    expect(guardActionForOutcome('still-truncated')).toBe('retry');
  });

  it('★ 判不了 → 维持原样，既不清也不消耗尝试', () => {
    /**
     * 两个方向都不能走：
     * - 清掉 = 判不了的情况下放开无限刷新（ADR 0020 的反面）
     * - +1   = 把"没观测到"当成"尝试过"，白吃一次重试机会
     */
    expect(guardActionForOutcome('unknown')).toBe('keep');
  });

  it('四种结果两两不同 —— 不许有任何一个状态被并进另一态', () => {
    const actions = ALL_OUTCOMES.map((o) => guardActionForOutcome(o));
    // clear / clear / retry / keep → 三组
    expect(actions).toEqual(['clear', 'clear', 'retry', 'keep']);
  });

  it('穷举四态都有返回值（没有 default 兜底也能过）', () => {
    for (const o of ALL_OUTCOMES) {
      expect(['clear', 'keep', 'retry']).toContain(guardActionForOutcome(o));
    }
  });
});

describe('isRoundSatisfied：达目标与"护栏怎么变"是两件事', () => {
  it('★ 注入成功 / 本来就完整 都算达目标', () => {
    expect(isRoundSatisfied('injected')).toBe(true);
    expect(isRoundSatisfied('native-complete')).toBe(true);
  });

  it('★ 仍是试看 / 判不了 都不算达目标', () => {
    expect(isRoundSatisfied('still-truncated')).toBe(false);
    expect(isRoundSatisfied('unknown')).toBe(false);
  });

  it('达目标与 clear 在这一版里恰好等价（但语义分开，将来可各自演化）', () => {
    for (const o of ALL_OUTCOMES) {
      expect(isRoundSatisfied(o)).toBe(guardActionForOutcome(o) === 'clear');
    }
  });
});

describe('makeGuardAttempts：TTL 从最后一次刷新算起', () => {
  it('★ `at` 必须随每次刷新更新（不是沿用首次的时刻）', () => {
    /**
     * 若不更新 `at`，连刷两次也可能在第三次前跨过 GUARD_TTL_MS，
     * 护栏自己就松手了 —— 那是「方案 b 但护栏其实不生效」的隐蔽形态。
     */
    const first = makeGuardAttempts(1, 1000);
    const second = makeGuardAttempts(2, 5000);
    expect(first.at).toBe(1000);
    expect(second.at).toBe(5000);
    expect(second.at).toBeGreaterThan(first.at);
  });

  it('attempts 按传入值记录（上限由调用方控制）', () => {
    expect(makeGuardAttempts(2, 0).attempts).toBe(2);
  });

  it('写出的标记能被 parseGuard 原样读回', () => {
    const g = makeGuardAttempts(2, 1_700_000_000_000);
    expect(parseGuard(JSON.stringify(g))).toEqual(g);
  });
});
