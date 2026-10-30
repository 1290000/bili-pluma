/**
 * 入口接线：方案 c 的两处关键接线（ADR 0030，2026-10-30）
 *
 * ## 为什么单独成文件（而不是并进 pgc-cache-entry-wiring.test.ts）
 *
 * 两者守的是**不同提交**的东西：
 * - `pgc-cache-entry-wiring.test.ts` 守读取侧 `expectedMs` 接线（修 bug）
 * - 本文件守方案 c 的判定点与次数累加（换语义）
 *
 * 拆开之后，若方案 c 被回滚，这一整个文件跟着删，而 expectedMs 的守卫不受牵连。
 * 合在一起的话，回滚时要么误留 c 的断言（红），要么误删 expectedMs 的守卫（失去覆盖）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONTENT = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

/**
 * 入口接线：`reloadWithGuard` 的护栏次数必须**累加**（ADR 0030 方案 c，2026-10-30）
 *
 * ## 为什么这条必须单独守
 *
 * 原实现是 `JSON.stringify(makeGuard(Date.now()))` —— 无条件写 `attempts: 1`。
 * 在 `MAX_RELOAD_ATTEMPTS = 1` 时代这是对的（写一次就满额）。但上限提到 **2** 之后，
 * 「永远写 1」= **永远不满额** = 护栏永不生效 = 退回无限刷新。
 *
 * 这个错误**不会让任何既有测试变红**：单测测的是 `makeGuardAttempts()` / `isAlreadyTried()`
 * 这些纯函数，它们都对；错的是**入口有没有把它们接对**。而入口没有单测能 import
 * （WXT 入口有副作用），所以只能钉结构。
 */
describe('reloadWithGuard：护栏次数累加（方案 c）', () => {
  it('★ 不再无条件写 makeGuard（那会让 attempts 永远停在 1）', () => {
    /**
     * 反例：把这里改回 `makeGuard(Date.now())` → 本条红。
     * 后果是护栏形同虚设，无限刷新复活 —— 而 UI 上完全看不出来。
     */
    expect(CONTENT).not.toMatch(/sessionStorage\.setItem\(\s*guardKey[\s\S]{0,60}?makeGuard\(/);
  });

  it('★ 写护栏用的是 makeGuardAttempts，且次数来自"读旧值 + 1"', () => {
    expect(CONTENT).toMatch(/makeGuardAttempts\(nextAttempts,\s*Date\.now\(\)\)/);
    expect(CONTENT).toMatch(/prevAttempts\s*\+\s*1/);
  });

  it('★ 次数封顶在 MAX_RELOAD_ATTEMPTS（不许无限增长）', () => {
    expect(CONTENT).toMatch(/Math\.min\(\s*prevAttempts\s*\+\s*1\s*,\s*MAX_RELOAD_ATTEMPTS\s*\)/);
  });

  it('上限来自模块常量，不是入口里硬编码的数字', () => {
    // 写死 2 的话，改常量时入口会跟着漂 —— 两处数字漂开比没有上限更糟
    expect(CONTENT).toMatch(/MAX_RELOAD_ATTEMPTS/);
    expect(CONTENT).not.toMatch(/nextAttempts\s*=\s*Math\.min\([^)]*,\s*2\s*\)/);
  });
});

/**
 * 入口接线：方案 c 的**判定点必须真的被调用**（ADR 0030，2026-10-30）
 *
 * ## 为什么这条是 c 最容易静默失效的地方
 *
 * c 的全部价值在 `guardActionForOutcome()`。但那个函数是纯函数 ——
 * **就算没人调用它，所有单测照样全绿**。护栏会静默退回「只认次数」的老行为，
 * 用户看到的现象（F5 后仍被挡）与改造前一模一样，而没有任何测试报警。
 *
 * 这一组钉的是「它确实被接在每轮加载的判定路径上」，且接在正确的位置。
 */
describe('方案 c：guardActionForOutcome 的判定点接线', () => {
  it('★ orchestratePgc 里确实调用了 applyGuardDecisionForRound', () => {
    // 反例：删掉这行调用 → 本条红（c 退化成纯函数摆设）
    expect(CONTENT).toMatch(/applyGuardDecisionForRound\(\s*cid\s*,\s*roundOutcome\s*\)/);
  });

  it('★ 判定点排在 canSkipPgcInjection **之前**', () => {
    /**
     * 顺序反了会有真实后果：「刷了且成功」的集数会走早退分支，
     * 永远轮不到清护栏 —— 下次 F5 又被一条本该消失的护栏挡住
     * （这正是 ADR 0030 表里第 2/3/4 条要修的场景）。
     */
    const callAt = CONTENT.indexOf('applyGuardDecisionForRound(cid, roundOutcome)');
    const skipAt = CONTENT.indexOf('canSkipPgcInjection({');
    expect(callAt).toBeGreaterThan(0);
    expect(skipAt).toBeGreaterThan(0);
    expect(callAt).toBeLessThan(skipAt);
  });

  it('★ 四态映射齐全：injected / native-complete / still-truncated / unknown', () => {
    expect(CONTENT).toMatch(/'injected'/);
    expect(CONTENT).toMatch(/'native-complete'/);
    expect(CONTENT).toMatch(/'still-truncated'/);
    expect(CONTENT).toMatch(/'unknown'/);
  });

  it('★ 判不了（ssrData 缺失）时映射到 unknown，不许当成 still-truncated', () => {
    /**
     * 错标成 `still-truncated` 的后果：每次缺数据的加载都白吃一次重试机会
     * （`guardActionForOutcome('still-truncated')` = `retry`）。
     */
    expect(CONTENT).toMatch(/ssrData === undefined[\s\S]{0,40}?'unknown'/);
  });

  it('`retry` 不在判定点里累加次数（次数只在真的要刷时增长）', () => {
    /**
     * 观测次数 ≠ 尝试次数。判定点在这里 +1 会把"发现还没成"记成"又刷了一次"，
     * 两次观测就吃光上限 —— 用户一次都没比别人多看到刷新，护栏却满了。
     */
    const fn = /function applyGuardDecisionForRound[\s\S]*?^}/m.exec(CONTENT)?.[0] ?? '';
    expect(fn).not.toMatch(/makeGuardAttempts/);
    expect(fn).not.toMatch(/attempts\s*\+/);
  });
});
