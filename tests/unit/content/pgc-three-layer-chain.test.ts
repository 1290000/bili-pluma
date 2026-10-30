// @vitest-environment jsdom

/**
 * ADR 0028 三层 + ADR 0030 方案 c 的**串联**行为（2026-10-30）
 *
 * ## 为什么需要这个文件
 *
 * 三层各自都有测试：
 * - 第一层 `writeProxyOffMark` / `readProxyOffMarkSync` → `pgc-proxy-off-sync-read.test.ts`
 * - 第二层 `clearPgcSessionCache` → `pgc-proxy-off.test.ts`
 * - 第三层 `clearPgcReloadGuards` / `isProxyReenabled` → `pgc-proxy-off.test.ts`
 * - 方案 c `guardActionForOutcome` → `pgc-guard-outcome.test.ts`
 *
 * **但没有一条测试把"开关关着刷新 → 第二层清缓存 → 这一轮 still-truncated →
 * 重开开关 → 第三层清护栏 → 下一轮 injected"串起来。**
 *
 * 真机可以验这个链路（`poc/probe/` 下的脚本），但真机是一次快照；
 * 而"三层的触发条件是否仍然互补"这件事，只要有人改了其中一个的判据就会变。
 * 所以把它钉成单测，作为**永久守卫**。
 *
 * ## 真机与单测的分工
 *
 * | 层次 | 能验什么 | 不能验什么 |
 * | --- | --- | --- |
 * | 本文件 | 三层的**触发条件**是否互补、顺序是否成立 | `page/activate` 回包真的会带 `disabled` 吗 |
 * | `poc/probe/` | 后者（跨进程、依赖 background 判定） | 每周改代码都跑一遍 |
 *
 * ⚠️ **反例验证**：把 `isProxyReenabled` 改成"任意变化都算重开"，
 * 本文件「第三层只在 false→true 触发」一条必红。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  GUARD_KEY_PREFIX,
  MAX_RELOAD_ATTEMPTS,
  guardActionForOutcome,
  isAlreadyTried,
  makeGuardAttempts,
} from '@/src/content/isolated/pgc-reload-plan';
import {
  PROXY_OFF_KEY,
  clearPgcReloadGuards,
  clearPgcSessionCache,
  isProxyReenabled,
  writeProxyOffMark,
} from '@/src/content/isolated/pgc-proxy-off';

// 需要 sessionStorage / localStorage 的真实行为
const SS_PREFIX = 'pluma:pgc-vi:';
const NOW = 1_793_277_792_545;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

/** 造一份"同步缓存"（第二层要清的就是它） */
function seedSyncCache(cid: string, bytes = 1000): void {
  sessionStorage.setItem(SS_PREFIX + cid, 'x'.repeat(bytes));
}

/** 造一条"满额"刷新护栏（第三层要清的就是它） */
function seedFullGuard(cid: string): string {
  const key = GUARD_KEY_PREFIX + cid;
  sessionStorage.setItem(key, JSON.stringify(makeGuardAttempts(MAX_RELOAD_ATTEMPTS, NOW)));
  return key;
}

describe('三层串联：开关关着刷新 → 第二层；重开开关 → 第三层', () => {
  it('★ 第一层：关开关写出标记，主世界据此拦截', () => {
    writeProxyOffMark(true);
    expect(localStorage.getItem(PROXY_OFF_KEY)).not.toBeNull();
    // 开回来时删掉标记 —— 第一层是"有标记 = 关"，不是"有值 = 状态"
    writeProxyOffMark(false);
    expect(localStorage.getItem(PROXY_OFF_KEY)).toBeNull();
  });

  it('★ 第二层：清掉的是 `pluma:pgc-vi:*`，**不**清护栏', () => {
    seedSyncCache('100');
    seedSyncCache('200');
    const guardKey = seedFullGuard('100');

    const purged = clearPgcSessionCache();

    expect(purged).toBe(2);
    expect(sessionStorage.getItem(SS_PREFIX + '100')).toBeNull();
    /**
     * ⚠️ 护栏**必须**留着 —— 这是第二层与第三层的分工，
     * 也是本文件存在的理由。如果第二层顺手清了护栏，
     * 第三层那条"只在 false→true 清"的精确设计就没意义了。
     */
    expect(sessionStorage.getItem(guardKey)).not.toBeNull();
  });

  it('★ 第三层：只在开关 false→true 那一刻清护栏', () => {
    expect(isProxyReenabled(false, true)).toBe(true);
    // 其它所有组合都不是"重开"
    expect(isProxyReenabled(true, true)).toBe(false);
    expect(isProxyReenabled(false, false)).toBe(false);
    expect(isProxyReenabled(undefined, true)).toBe(false);
    expect(isProxyReenabled(true, false)).toBe(false);
  });

  it('★ 第三层清护栏时，缓存已经被第二层清过了（顺序链成立）', () => {
    seedSyncCache('300');
    const guardKey = seedFullGuard('300');

    // 关开关 → 刷新（第二层跑）
    clearPgcSessionCache();
    // 重开开关 → 第三层跑
    expect(isProxyReenabled(false, true)).toBe(true);
    const cleared = clearPgcReloadGuards();

    expect(cleared).toBe(1);
    expect(sessionStorage.getItem(guardKey)).toBeNull();
    // 两边都空了，下一轮该正常取流
    expect(sessionStorage.getItem(SS_PREFIX + '300')).toBeNull();
    expect(isAlreadyTried(null, NOW)).toBe(false);
  });

  it('★ 第二层没跑时（拨开关但不刷新），护栏由第三层兜住', () => {
    /**
     * 这是真机实测发现的真实情形（2026-10-30）：
     * 拨开关**不刷新页面** → `page/activate` 回包不发生 → 第二层不执行
     * → 缓存还在 → 重开后命中缓存 → outcome 是 `injected` 而不是 `still-truncated`。
     *
     * 所以"第二层没清缓存"本身不是 bug，是时序决定的。
     * 但护栏仍必须由第三层清 —— 否则下一轮会被挡住。
     */
    seedSyncCache('400'); // 缓存"不该"被清，因为第二层没机会跑
    const guardKey = seedFullGuard('400');

    expect(sessionStorage.getItem(SS_PREFIX + '400')).not.toBeNull();

    // 重开开关 → 第三层照清
    expect(isProxyReenabled(false, true)).toBe(true);
    clearPgcReloadGuards();

    expect(sessionStorage.getItem(guardKey)).toBeNull();
    // 缓存还在 → 这一轮会是 injected（命中缓存），依然正常
    expect(sessionStorage.getItem(SS_PREFIX + '400')).not.toBeNull();
  });
});

describe('第二层与方案 c 的关系：谁清都不影响"该不该拦"', () => {
  it('★ 缓存被清后那一轮是 still-truncated → c 判 retry（不清护栏）', () => {
    // 第二层清了缓存 → 主世界没东西可注入 → patchedByUs=false，SSR 仍截断
    expect(guardActionForOutcome('still-truncated')).toBe('retry');
  });

  it('★ 因此"第二层清了缓存"这一轮，护栏只能靠第三层清', () => {
    /**
     * 判据链：
     *   第二层清了缓存 ⟹ 这一轮 patchedByUs=false 且 truncated=true
     *   ⟹ outcome = still-truncated ⟹ c 不清护栏
     * ⟹ **只有第三层能接住**
     *
     * 这就是「c 不能取代第三层」在单测层的完整论证。
     */
    const afterLayer2 = 'still-truncated' as const;
    expect(guardActionForOutcome(afterLayer2)).not.toBe('clear');
    // 而第三层确实能清
    seedFullGuard('500');
    expect(clearPgcReloadGuards()).toBe(1);
  });

  it('★ 缓存没被清（拨开关不刷）那一轮是 injected → c 自己会清', () => {
    // 与上一条构成对照：同样"重开开关"，但 outcome 不同、清的机制不同
    expect(guardActionForOutcome('injected')).toBe('clear');
  });
});

/**
 * background 侧的 `page/activate` 必须在检查 `enabled` **之后**才可能返回 `ok`。
 *
 * ## 为什么用源码断言
 *
 * 第二层的触发条件是 `res.reason === 'disabled'`。而 `reason` 由
 * `src/background/handlers/page.handler.ts` 决定 —— 那是 background（另一个进程上下文），
 * 单测 import 不了（它依赖 `chrome.*`）。
 *
 * 但有一条**结构性事实**可以钉：如果把 `isProxyEnabled()` 那段挪到其它判定之后，
 * 或者删掉它，"关着开关刷新"就不再返回 `disabled`，第二层静默失效。
 */
describe('background：关着开关时 page/activate 必须报 disabled', () => {
  const HANDLER = readFileSync(
    resolve(process.cwd(), 'src/background/handlers/page.handler.ts'),
    'utf8',
  );

  it('★ handler 里有 `isProxyEnabled()` 判定并返回 `disabled`', () => {
    expect(HANDLER).toMatch(/!\(await isProxyEnabled\(\)\)/);
    expect(HANDLER).toMatch(/reason:\s*'disabled'/);
  });

  it('★ 这个判定排在 `same-account` 之前（否则关着开关会被误报成别的 reason）', () => {
    /**
     * 顺序反了会让第二层收不到 `disabled`：`same-account` / `not-configured`
     * 那几条分支在 `clearPgcSessionCache()` 的判据里都是"不清"。
     * 于是关着开关刷新也不清缓存 —— 第二层静默失效。
     */
    const disabledAt = HANDLER.indexOf("reason: 'disabled'");
    const sameAccountAt = HANDLER.indexOf("reason: 'same-account'");
    expect(disabledAt).toBeGreaterThan(0);
    expect(sameAccountAt).toBeGreaterThan(0);
    expect(disabledAt).toBeLessThan(sameAccountAt);
  });
});

/**
 * ⚠️ 判据陷阱：**不能用 sessionStorage 空没空判断"第二层执行了没有"**
 *
 * ## 为什么这条必须钉住
 *
 * 2026-10-30 真机实测踩到（`poc/probe/probe-pgc-layer2-chain.mjs`）：
 *
 * ```
 * ③ 关着开关 reload 后：{"pluma:pgc-vi:262765010": 92568}   ← 看起来"没清"
 * 但同一轮日志：已清 1 条同步缓存                            ← 第二层执行了
 *              命中缓存并下发（同步缓存原有=false）            ← 又写回来了
 * ```
 *
 * 原因是 `orchestratePgc` 的缓存分支里有 `writePgcSessionCache(cid, cached, epId)`
 * —— 它会把 `chrome.storage.local` 的 LRU 缓存**重新写进** sessionStorage。
 *
 * 所以「第二层有没有执行」的权威证据是产品的 `pluma:diag` 日志，
 * 「这一轮 outcome 是什么」看 `pgcReloadTrace` 的字段，**都不看 sessionStorage 内容**。
 *
 * 这个陷阱已经造成过一次**错误的 FAIL 结论**（误报"第二层没执行"）。
 */
describe('判据陷阱：sessionStorage 内容不能当"第二层执行了没有"的证据', () => {
  const CONTENT = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

  it('★ 缓存分支里确实有"写回 sessionStorage"这一步（这就是陷阱的来源）', () => {
    // 如果哪天这一步被删了，本陷阱自动消失 —— 那条测试会红，提醒人回来看这段注释
    expect(CONTENT).toMatch(/writePgcSessionCache\(\s*cid\s*,\s*cached\s*,\s*epId\s*\)/);
  });

  it('★ `hadSync` 是**读**当时的值，发生在写回**之前**', () => {
    /**
     * 顺序很重要：先读 `hadSync`（这一轮真实有没有同步缓存），再写回。
     * 反过来的话 `hadSync` 会读到刚写进去的那份，永远为 true ——
     * 「同步缓存原有=false」这条关键诊断就永远不会出现。
     */
    const readAt = CONTENT.indexOf('isSyncCacheUsable(sessionStorage.getItem');
    const writeAt = CONTENT.indexOf('writePgcSessionCache(cid, cached, epId)');
    expect(readAt).toBeGreaterThan(0);
    expect(writeAt).toBeGreaterThan(0);
    expect(readAt).toBeLessThan(writeAt);
  });

  it('清 `sessionStorage` 之后它又能被写回 —— 所以清空不是稳定证据', () => {
    /**
     * 行为层的对照实验（对应真机那条"脚本删空 → reload → 92568B 又出现"）。
     *
     * 这里只演示机制：第二层的 `clearPgcSessionCache()` 能清掉，
     * 但**任何持有 `cached` 的代码都能再写回去**。因此单看最终状态无法反推
     * 中间是否清过。
     */
    seedSyncCache('600');
    expect(clearPgcSessionCache()).toBe(1);
    expect(sessionStorage.getItem(SS_PREFIX + '600')).toBeNull();

    // 模拟 writePgcSessionCache 的重写（真实实现在 entrypoints 里，不可 import）
    seedSyncCache('600');
    expect(sessionStorage.getItem(SS_PREFIX + '600')).not.toBeNull();
  });
});
