/**
 * 方案 c 下的「关开关 → 重开」场景：`clearPgcReloadGuards()` 到底还需不需要？
 *
 * ## 为什么要单独验这件事
 *
 * 用户拍板「允许删掉 ADR 0028 第三层」。但 ADR 0030 只论证了
 * 「c 观测到已达目标就清护栏」，**没有逐字回答**这个具体场景。
 *
 * ## ⚠️ 2026-10-30 真机更正：初稿的因果链说错了一环
 *
 * 初稿写的是「关开关 → **第二层清掉缓存** → 重开后无缓存 → `still-truncated`」。
 * 真机实测推翻了这个因果：**第二层清缓存挂在 `page/activate` 回包上，
 * 而拨开关本身不刷新页面、那次回包不会发生**，所以缓存原封不动（实测 92,568B 仍在），
 * 重开后仍命中缓存 → `injected`。
 *
 * 真正读到 `still-truncated` 的是**「关着开关的时候整页 reload」**那一轮
 * （那次 `page/activate` 回包会来且 `reason === 'disabled'`，第二层才清）。
 *
 * ## 所以这个文件守的是
 *
 * 「`still-truncated` 态下 c 判 `retry`（不清护栏）」这条**判据本身**，
 * 它是第三层必须保留的依据 —— 而**不是**初稿那个错误的因果链。
 * 真机四条路径回归见 `poc/probe/probe-pgc-guard-paths.mjs`（exit 0）。
 */
import { describe, expect, it } from 'vitest';

import {
  GUARD_KEY_PREFIX,
  GUARD_TTL_MS,
  MAX_RELOAD_ATTEMPTS,
  guardActionForOutcome,
  isAlreadyTried,
  makeGuardAttempts,
  shouldReload,
  shouldResetGuardForBadCache,
} from '@/src/content/isolated/pgc-reload-plan';

const NOW = 1_793_277_792_545;

describe('still-truncated 态下方案 c 的行为（第三层必须保留的判据）', () => {
  /**
   * `still-truncated` 是怎么来的（与 `content.ts` 的映射规则一致）：
   *
   * `ssrData` 存在（SSR 一直在）、`ssrWasPatchedByUs = false`（没注入成功）、
   * `ssrTruncated = true`（SSR 仍是试看流）→ `'still-truncated'`
   *
   * ⚠️ 真机上这一态出现在「**关着开关的时候整页 reload**」那一轮
   * （第二层此时才会经 `page/activate` 回包清掉缓存），**不是**"拨开关"那一刻。
   */
  const outcome = 'still-truncated' as const;

  it('★ 这一态的护栏动作是 retry（**不清**）', () => {
    expect(guardActionForOutcome(outcome)).toBe('retry');
  });

  it('★ 因此方案 c 本身**不能**覆盖"第二层清了缓存之后"的那一轮', () => {
    /**
     * 这条断言就是"删不删 ADR 0028 第三层"的判据。
     *
     * 它成立 ⟹ c 在这一态不清护栏 ⟹ `clearPgcReloadGuards()` **仍然必需**，
     * 不能按 ADR 0030 §「对 ADR 0028 第三层的影响」里那句"可以删除"照做。
     */
    expect(guardActionForOutcome(outcome)).not.toBe('clear');
  });

  it('★ 旧护栏满额时，这一轮确实会被挡住（这就是用户看到的"卡试看"）', () => {
    const guard = makeGuardAttempts(MAX_RELOAD_ATTEMPTS, NOW);
    const alreadyTried = isAlreadyTried(guard, NOW);

    expect(alreadyTried).toBe(true);
    // shouldReload 被护栏挡住 —— 即使有流也不刷
    expect(shouldReload({ alreadyTried, hasStream: true })).toBe(false);
  });

  it('清掉护栏之后同一套判据就放行（这就是 clearPgcReloadGuards 的价值）', () => {
    const cleared = null; // 模拟 removeItem 之后
    const alreadyTried = isAlreadyTried(cleared, NOW);

    expect(alreadyTried).toBe(false);
    expect(shouldReload({ alreadyTried, hasStream: true })).toBe(true);
  });

  it('TTL 过期后也能自救（所以它不是永久卡死，只是最长 10 分钟）', () => {
    const guard = makeGuardAttempts(MAX_RELOAD_ATTEMPTS, NOW);
    const later = NOW + GUARD_TTL_MS + 1;
    expect(isAlreadyTried(guard, later)).toBe(false);
  });

  it('护栏键名与 content.ts 用的一致（防止这条推演挂在错误的键上）', () => {
    expect(GUARD_KEY_PREFIX).toBe('pluma:pgc-reload:');
  });
});

/**
 * 两个清护栏点的分工（ADR 0030 方案 c 与 `shouldResetGuardForBadCache` 的交互）
 *
 * `orchestratePgc` 里有**两处**会清护栏：
 *
 * | 位置 | 触发 | 依据 |
 * | --- | --- | --- |
 * | `applyGuardDecisionForRound()`（c） | 本轮**已达目标** | 观测到结果 |
 * | `shouldResetGuardForBadCache(true)` | **丢弃了一份坏缓存** | 观测到原因被处理 |
 *
 * 两者是**互补**而不是重复：一个看"成了没有"，一个看"旧原因还在不在"。
 * 但互补关系必须验，否则将来有人"合并去重"就会削掉一半覆盖。
 */
describe('两个清护栏点的分工', () => {
  it('★ c 在"仍截断"时不清 —— 否则坏缓存分支就没机会做它该做的事', () => {
    expect(guardActionForOutcome('still-truncated')).not.toBe('clear');
  });

  it('★ 坏缓存分支独立成立：它不依赖 outcome 是什么', () => {
    // 即使本轮 outcome 是 still-truncated（c 不清），丢弃坏缓存仍应清
    expect(shouldResetGuardForBadCache(true)).toBe(true);
    // 而没丢弃坏缓存时不许清（正常首访第二趟的护栏是对的）
    expect(shouldResetGuardForBadCache(false)).toBe(false);
  });

  it('两处都清时结果一致（都是 removeItem，幂等，不会互相破坏）', () => {
    // 都清 → 最终状态都是"没有护栏"；没有任何一方会把它重新写出来
    expect(guardActionForOutcome('injected')).toBe('clear');
    expect(shouldResetGuardForBadCache(true)).toBe(true);
  });

  it('★ 清护栏的两处覆盖不同场景，缺一不可', () => {
    /**
     * - 只有 c：关开关→重开 那一轮 outcome 是 still-truncated，不清 → 卡试看
     * - 只有坏缓存分支：刷了且成功 的集数下一轮没坏缓存可丢 → 不清 → F5 被旧护栏挡
     */
    const cCovers = guardActionForOutcome('injected') === 'clear';
    const badCacheCovers = shouldResetGuardForBadCache(true) === true;
    expect(cCovers && badCacheCovers).toBe(true);
    // 且 c 在坏缓存分支对应的那轮（still-truncated）**不**清
    expect(guardActionForOutcome('still-truncated')).toBe('retry');
  });
});
