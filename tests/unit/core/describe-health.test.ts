// @vitest-environment node

/**
 * 凭据健康状态 → 卡片第三行（2026-11-10）。
 *
 * ## 为什么加这个
 *
 * `account/summary` 一直返回 `healthy` / `checkedAt` / `reason`，
 * 但面板从没渲染过（原 options 的账号页有，随它一起删了）。
 * 没有这一行，用户看不出凭据是否还有效 —— 只能等它失效、画质掉下来才发现。
 *
 * ## 本文件守的核心纪律（`02-ui-spec.md` §2.4）
 *
 * > 过期是内部卫生，不该变成 UI 上的疑虑
 *
 * 所以：**只显示相对时间，绝不加"可能已过期""建议重新登录"这类猜测**。
 * 唯一的例外是 `healthy: false` —— 那是**事实**，不是猜。
 */

import { describe, expect, it } from 'vitest';

import { describeHealth } from '../../../src/core/ui/popup-state';

const NOW = 1_800_000_000_000;

function h(over: Partial<{ healthy: boolean; checkedAt: number; reason: string | null }> = {}) {
  return { healthy: true, checkedAt: NOW, reason: null, ...over };
}

describe('★★ 只显示相对时间，不加猜测性文案', () => {
  it('刚刚校验过 → 「刚刚校验」', () => {
    expect(describeHealth(h({ checkedAt: NOW - 10_000 }), NOW)).toBe('刚刚校验');
  });

  it('5 分钟前 → 「5 分钟前校验」', () => {
    expect(describeHealth(h({ checkedAt: NOW - 5 * 60_000 }), NOW)).toBe('5 分钟前校验');
  });

  it('3 小时前 → 「3 小时前校验」', () => {
    expect(describeHealth(h({ checkedAt: NOW - 3 * 3_600_000 }), NOW)).toBe('3 小时前校验');
  });

  it('3 天前 → 「3 天前校验」', () => {
    expect(describeHealth(h({ checkedAt: NOW - 3 * 86_400_000 }), NOW)).toBe('3 天前校验');
  });

  it('★★ 绝不出现"可能过期""建议重新登录"这类猜测', () => {
    /**
     * 反例：往 describeHealth 里加一句「可能已过期，建议重新登录」→ 本条必红。
     *
     * `02-ui-spec.md` §2.4 明确写过：「过期是内部卫生，不该变成 UI 上的疑虑」。
     * 用户看到"可能过期"会去重扫一次码，而他**完全没必要**。
     */
    for (const mins of [0, 5, 120, 60 * 24 * 3, 60 * 24 * 30]) {
      const text = describeHealth(h({ checkedAt: NOW - mins * 60_000 }), NOW);
      expect(text, `${String(mins)} 分钟时出现了猜测性文案`).not.toMatch(/可能|建议|或许|疑似/);
    }
  });
});

describe('★★ 凭据异常是事实，必须说', () => {
  it('healthy:false + reason → 「凭据异常：<reason>」', () => {
    const text = describeHealth(h({ healthy: false, reason: '-101 未登录' }), NOW);
    expect(text).toContain('凭据异常');
    expect(text).toContain('-101');
  });

  it('healthy:false 没有 reason → 只说「凭据异常」', () => {
    expect(describeHealth(h({ healthy: false, reason: null }), NOW)).toBe('凭据异常');
  });
});

describe('★★ 没有信息量时整行不渲染', () => {
  it('account 为 null → 空串（不写「未知」）', () => {
    /**
     * 写「未知」会让用户以为出了问题。没有数据就没有这一行。
     */
    expect(describeHealth(null, NOW)).toBe('');
  });

  it('从未校验过（checkedAt=0）→ 空串', () => {
    expect(describeHealth(h({ checkedAt: 0 }), NOW)).toBe('');
  });
});

describe('★★★ 真机假警报回归：healthy 为 undefined 时**不许**报异常（2026-11-10）', () => {
  /**
   * ## 真机事故
   *
   * 账号 Tab 显示「凭据异常」，而底层数据完全健康：
   * `{"hasCredential":true,"healthy":true,"ruleCount":3}` —— 代理正常工作。
   *
   * ## 根因
   *
   * 面板把 `AccountSummary`（健康状态**嵌套在 `health` 对象里**）
   * 直接当成 `PopupAccount`（**扁平**字段）传进来。
   * 于是 `account.healthy === undefined`。
   *
   * 旧实现写的是 `if (!account.healthy)` —— `!undefined === true` → 报「凭据异常」。
   *
   * ## 为什么类型系统没拦住
   *
   * 入参是 `Pick<PopupAccount, 'healthy' | ...>`，字段在类型上可缺省；
   * 而面板侧用的是 `as` 断言（**编译器不校验 `as` 的字段**）。
   * 两头都不报错，于是这个 bug 一路到了真机。
   */

  it('★★★ healthy 为 undefined → **空串**，绝不报「凭据异常」', () => {
    /**
     * 反例：把判据改回 `!account.healthy` → 本条必红（会返回「凭据异常」）。
     *
     * 这是本轮最重要的一条：它守的是"**没有原因、没有动作的假警报**"。
     */
    const shapeMismatch = { healthy: undefined, checkedAt: 0, reason: null } as unknown as {
      healthy: boolean;
      checkedAt: number;
      reason: string | null;
    };
    const text = describeHealth(shapeMismatch, NOW);
    expect(text, '形状不对时不许报异常').not.toContain('凭据异常');
    expect(text).toBe('');
  });

  it('★★ healthy 为 null → 也不报异常', () => {
    const broken = { healthy: null, checkedAt: 0, reason: null } as unknown as {
      healthy: boolean;
      checkedAt: number;
      reason: string | null;
    };
    expect(describeHealth(broken, NOW)).toBe('');
  });

  it('★★ healthy 为 undefined 但 reason 有值 → **仍然**不报（reason 是健康的从属字段）', () => {
    /**
     * 形状不对时 `reason` 也可能是别的意思。不许拿它拼一条"看起来很有理由"的假警报
     * —— 那比纯粹的「凭据异常」更有欺骗性。
     */
    const broken = { healthy: undefined, checkedAt: 0, reason: 'some old reason' } as unknown as {
      healthy: boolean;
      checkedAt: number;
      reason: string | null;
    };
    expect(describeHealth(broken, NOW)).toBe('');
  });

  it('★★ 明确的 healthy:false + reason → 必须报「凭据异常：x」', () => {
    /**
     * 这条与前几条方向相反，防止修假警报时把**真异常**也一起压掉。
     */
    const text = describeHealth(h({ healthy: false, reason: 'x' }), NOW);
    expect(text).toBe('凭据异常：x');
  });

  it('★ 明确的 healthy:true → 正常显示相对时间', () => {
    expect(describeHealth(h({ checkedAt: NOW - 60_000 }), NOW)).toBe('1 分钟前校验');
  });
});
