/**
 * `describePopup()` 的**未知 reason 不许静默落到「已接管」**（2026-11-11，🟡-2）。
 *
 * ## 为什么这条必须用 `as never` 而不是列出现有值
 *
 * `describePopup()` 里有两对**显式 `if`**：
 *
 * ```ts
 * // 第一对（!account 分支内，:427/:429）
 * if (snap.lastActivateReason === 'self') return selfIdentity();
 * if (snap.lastActivateReason === 'page-identity') return pageIdentity();
 * return { state: 'active', pill: '已接管', ... };   // ← 默认落到这里
 *
 * // 第二对（!account.healthy 之前，:476/:477）
 * if (snap.lastActivateReason === 'self') return selfIdentity();
 * if (snap.lastActivateReason === 'page-identity') return pageIdentity();
 * ```
 *
 * **列出现有 7 个 reason 的测试，挡不住"下次加一个新 reason 却忘在这儿表态"**：
 * 新值不匹配任何 `if` → 直接落到 `return 已接管` → **界面谎报扩展在工作**。
 * 而 `tsc` **不会报错**（这里不是封闭联合的 `switch`）。
 *
 * 这是 7 个 reason 值里**唯一"新增值会静默落到「已接管」"**的地方 ——
 * 其余消费方（`switch` / `Record<ProxyActivateReason, ...>`）加新值都会让 `tsc` 报错。
 *
 * ## 手法与 T7 相同
 *
 * `tests/unit/content/rewrite-gate.test.ts` 的 T7 用 `as never` 构造不存在的 reason，
 * 断言 `rewriteGate` 是 `false`（fail-closed）。这里同理：
 * **构造一个不存在的 reason，断言它不落进「已接管」。**
 *
 * ## ⚠️ 这条测试守的是什么、不守什么
 *
 * **守**：将来有人加 reason 时，如果不在这两对 `if` 里表态，
 * 新值会掉进「已接管」→ 本测试红。
 *
 * **不守**：它不保证"新 reason 该显示什么" —— 那是加 reason 的人要决定的。
 * 它只保证**"未知值不会被说成已接管"** 这个下限。
 */

import { describe, expect, it } from 'vitest';

import { describePopup, type PopupAccount, type PopupSnapshot } from '@core/ui/popup-state';
import type { ProxyActivateReason } from '@shared/types/messages';

const NOW = 1_760_000_000_000;

const healthy: PopupAccount = {
  uname: '播',
  mid: 2,
  vipLabel: 'annual',
  expireAt: null,
  healthy: true,
  checkedAt: NOW,
  reason: null,
};

function snap(over: Partial<PopupSnapshot> = {}): PopupSnapshot {
  return {
    proxy: { enabled: true, hasCredential: true, ruleCount: 3 },
    configured: true,
    account: healthy,
    buckets: [],
    page: { kind: 'play' },
    ...over,
  };
}

/** 构造一个**不存在**的 reason（与 T7 同款） */
function futureReason(v = 'some-future-reason'): ProxyActivateReason {
  return v as never as ProxyActivateReason;
}

describe('🟡-2 未知 reason 不许落到「已接管」（两对 if、四个分支点）', () => {
  /**
   * ## 四个分支点的覆盖方式
   *
   * | 分支点 | 行 | 进入条件 | 本文件的用例 |
   * | --- | --- | --- | --- |
   * | 第一对 | `:427` / `:429` | `!account && proxy.hasCredential` | `account: null` + `hasCredential: true` |
   * | 第二对 | `:476` / `:477` | `account 存在` 且到了播放页 | 默认 `snap()` |
   */

  it('★ 第一对 if（!account + hasCredential）：未知 reason 不落进「已接管」', () => {
    const v = describePopup(
      snap({
        account: null,
        proxy: { enabled: true, hasCredential: true, ruleCount: 3 },
        lastActivateReason: futureReason(),
      }),
    );
    expect(v.pill, '未知 reason 被说成「已接管」= 谎报扩展在工作').not.toBe('已接管');
  });

  it('★ 第二对 if（account 健康 + 播放页）：未知 reason 不落进「已接管」', () => {
    const v = describePopup(snap({ lastActivateReason: futureReason() }));
    expect(v.pill).not.toBe('已接管');
  });

  it('★ 多个未知形态都不许漏（列全常见形态，与 T7b 同款）', () => {
    /**
     * 只测一个假值不够：有人可能写出
     * `if (reason === 'self' || reason === 'page-identity' || reason === '')` 这种补丁。
     */
    const unknowns = [
      'some-future-reason',
      '',
      'OK',
      'ok ',
      'Self',
      'PAGE-IDENTITY',
      'page_identity',
    ] as unknown as ProxyActivateReason[];

    for (const r of unknowns) {
      // 第一对
      const a = describePopup(
        snap({ account: null, lastActivateReason: r as ProxyActivateReason }),
      );
      expect(a.pill, `第一对：${String(r)} 落进了「已接管」`).not.toBe('已接管');

      // 第二对
      const b = describePopup(snap({ lastActivateReason: r as ProxyActivateReason }));
      expect(b.pill, `第二对：${String(r)} 落进了「已接管」`).not.toBe('已接管');
    }
  });

  it('★ 第二对里：未知 reason 也不许落进「凭据失效」（那是另一种谎报）', () => {
    /**
     * 未知值如果掉进 `credential-missing`，会让用户去重扫一个本来好用的号。
     * 那是本轮反复强调的另一类假警报。
     */
    const v = describePopup(snap({ lastActivateReason: futureReason(), account: healthy }));
    expect(v.state).not.toBe('credential-missing');
  });
});

describe('对照：已知值仍然各自正确（防止为了修未知值而改坏已知值）', () => {
  const knownCases: ReadonlyArray<[ProxyActivateReason, string, string]> = [
    ['self', '无需代理', '两号相同 → 不需要代理'],
    ['page-identity', '无需代理', '用户选了浏览器账号 → 不需要代理'],
    ['ok', '已接管', '扩展确实换了 Cookie'],
  ];

  it.each(knownCases)('reason=%s → pill「%s」（%s）', (reason, expectedPill) => {
    /**
     * ⚠️ 这里必须**两个分支都测**：第一对（`!account`）和第二对（`account` 存在）
     * 都有这四个 `if`，只测一处会让另一处的回归静默通过。
     */
    const first = describePopup(
      snap({
        account: null,
        lastActivateReason: reason,
        proxy: { enabled: true, hasCredential: true, ruleCount: 3 },
      }),
    );
    expect(first.pill, `第一对（!account）reason=${reason}`).toBe(expectedPill);

    const second = describePopup(snap({ lastActivateReason: reason }));
    expect(second.pill, `第二对（account 存在）reason=${reason}`).toBe(expectedPill);
  });
});
