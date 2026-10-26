import { describe, expect, it } from 'vitest';

import {
  isExpireAtImplausible,
  isHealthFresh,
  judgeNav,
  HEALTH_TTL_MS,
  summarizeNav,
  toVipLabel,
} from '@core/auth/account-info';

/**
 * 这些用例守的是"用户会不会收到错误提示"。
 *
 * 最关键的一条：**网络失败不能被报成凭据失效**。
 * 报错了用户会去重新扫码，重扫也解决不了，然后他就不信这个提示了。
 */

const NOW = 1_760_000_000_000;

describe('toVipLabel', () => {
  it('vipStatus 不是 1 一律算非会员（即使 vipType 是 2）', () => {
    expect(toVipLabel(0, 2)).toBe('none');
    expect(toVipLabel(undefined, 1)).toBe('none');
  });

  it('vipType 2 → 年度，1 → 月度', () => {
    expect(toVipLabel(1, 2)).toBe('annual');
    expect(toVipLabel(1, 1)).toBe('monthly');
  });

  it('有效但类型未知按月度，不夸大成年度', () => {
    expect(toVipLabel(1, 0)).toBe('monthly');
    expect(toVipLabel(1, undefined)).toBe('monthly');
  });
});

describe('summarizeNav', () => {
  it('mid 缺失时返回 null（不是"资料缺失"，是没登录）', () => {
    expect(summarizeNav({ uname: 'x' }, NOW)).toBeNull();
    expect(summarizeNav(undefined, NOW)).toBeNull();
    expect(summarizeNav({ mid: 0 }, NOW)).toBeNull();
  });

  it('到期日从秒转毫秒', () => {
    const s = summarizeNav(
      { mid: 1, uname: 'a', vipStatus: 1, vipType: 2, vipDueDate: 1_800_000_000 },
      NOW,
    );
    expect(s?.expireAt).toBe(1_800_000_000_000);
  });

  it('非会员的 expireAt 必须为 null（不给 UI 假到期日）', () => {
    const s = summarizeNav({ mid: 1, uname: 'a', vipStatus: 0, vipDueDate: 1_800_000_000 }, NOW);
    expect(s?.vipLabel).toBe('none');
    expect(s?.expireAt).toBeNull();
  });

  it('uname / face 缺失时有兜底，不返回空字符串', () => {
    const s = summarizeNav({ mid: 1, uname: '', face: '' }, NOW);
    expect(s?.profile.uname).toBe('(未知)');
    expect(s?.profile.avatarUrl).toBeNull();
  });
});

describe('judgeNav —— 失败类型必须分清楚', () => {
  it('网络不可达 → unknown，绝不是 expired', () => {
    const v = judgeNav({ reachable: false, code: null }, NOW);
    expect(v.kind).toBe('unknown');
    // 这条最重要：断网时不能引导用户去重新扫码
    expect(v.kind).not.toBe('expired');
  });

  it('code=-101 → expired', () => {
    const v = judgeNav({ reachable: true, code: -101 }, NOW);
    expect(v.kind).toBe('expired');
  });

  it('-412 风控 / -352 限流都不算失效', () => {
    expect(judgeNav({ reachable: true, code: -412 }, NOW).kind).toBe('unknown');
    expect(judgeNav({ reachable: true, code: -352 }, NOW).kind).toBe('unknown');
  });

  it('code=0 + 会员 → healthy', () => {
    const v = judgeNav(
      { reachable: true, code: 0, data: { mid: 9, uname: 'u', vipStatus: 1, vipType: 2 } },
      NOW,
    );
    expect(v.kind).toBe('healthy');
  });

  it('code=0 + 非会员 → not-vip（要如实告知，不能装作成功）', () => {
    const v = judgeNav(
      { reachable: true, code: 0, data: { mid: 9, uname: 'u', vipStatus: 0 } },
      NOW,
    );
    expect(v.kind).toBe('not-vip');
  });

  it('code=0 但没有 mid → unknown（数据形态变了，不当失效）', () => {
    expect(judgeNav({ reachable: true, code: 0, data: {} }, NOW).kind).toBe('unknown');
  });
});

describe('isHealthFresh', () => {
  it('6 小时窗口内算新鲜', () => {
    expect(isHealthFresh({ healthy: true, checkedAt: NOW - 1000, reason: null }, NOW)).toBe(true);
  });

  it('超过 TTL 算过期', () => {
    expect(
      isHealthFresh({ healthy: true, checkedAt: NOW - HEALTH_TTL_MS - 1, reason: null }, NOW),
    ).toBe(false);
  });

  it('从未校验过（checkedAt=0）算不新鲜', () => {
    expect(isHealthFresh({ healthy: true, checkedAt: 0, reason: null }, NOW)).toBe(false);
    expect(isHealthFresh(null, NOW)).toBe(false);
  });
});

describe('summarizeNav：到期日单位（2026-10-26 修）', () => {
  /**
   * 真实事故：用户 popup 显示「698197 个月后到期」。
   * 反推 expireAt ≈ 1.81e15，即 nav 给的原始值 ≈ 1.81e12 ——
   * 按秒是 2084 年（不可能），按毫秒是 2027-05（合理）。
   * 旧代码固定 `* 1000`，于是把毫秒又乘了一次。
   */
  it('vipDueDate 已经是毫秒时不再乘 1000', () => {
    const s = summarizeNav(
      { mid: 1, uname: 'a', vipStatus: 1, vipType: 2, vipDueDate: 1_811_500_000_000 },
      NOW,
    );
    expect(s?.expireAt).toBe(1_811_500_000_000);
  });

  it('秒级时间戳仍然按秒换算（两种单位都吃得下）', () => {
    const s = summarizeNav(
      { mid: 1, uname: 'a', vipStatus: 1, vipType: 2, vipDueDate: 1_800_000_000 },
      NOW,
    );
    expect(s?.expireAt).toBe(1_800_000_000_000);
  });
});

describe('isExpireAtImplausible：缓存脏数据自愈', () => {
  /**
   * 真实事故链（2026-10-27 用户复报）：
   *
   *   1. 旧构建无条件 `dueDate * 1000` → 算出 expireAt = 1.81e15 存进缓存
   *   2. 修好算法后，新构建**仍读那份缓存** → 界面还是「57386 年后到期」
   *
   * 所以算法修对 ≠ 修好。存量数据必须能自己失效，否则每次改算法
   * 都要用户重扫一次码，而用户毫无线索。
   */
  const YEAR = 365 * 86_400_000;

  it('多乘 1000 产生的那类值必须被判为脏', () => {
    // 1.81e12（真实毫秒值）被乘 1000 → 5 万年后
    expect(isExpireAtImplausible(1_811_500_000_000_000, NOW)).toBe(true);
  });

  it('正常的年度大会员到期日不被误判', () => {
    // 主账号实测值 1773936000000 = 2026-03-19，距 NOW 不到半年
    expect(isExpireAtImplausible(1_773_936_000_000, NOW)).toBe(false);
    // 未来 10 年（B站最长有效期量级）也不该误判
    expect(isExpireAtImplausible(NOW + 10 * YEAR, NOW)).toBe(false);
  });

  it('已过期的时间戳不算"脏" —— 那是真实状态，UI 会显示「已过期」', () => {
    expect(isExpireAtImplausible(NOW - YEAR, NOW)).toBe(false);
    expect(isExpireAtImplausible(1_600_000_000_000, NOW)).toBe(false);
  });

  it('null / 非法值一律放过（没有到期日不是错误）', () => {
    expect(isExpireAtImplausible(null, NOW)).toBe(false);
    expect(isExpireAtImplausible(Number.NaN, NOW)).toBe(false);
    expect(isExpireAtImplausible(Number.POSITIVE_INFINITY, NOW)).toBe(false);
  });

  it('阈值边界：99 年放过、101 年拦下（留足余量，不会误伤真实数据）', () => {
    expect(isExpireAtImplausible(NOW + 99 * YEAR, NOW)).toBe(false);
    expect(isExpireAtImplausible(NOW + 101 * YEAR, NOW)).toBe(true);
  });
});
