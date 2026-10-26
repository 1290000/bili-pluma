import { describe, expect, it } from 'vitest';

import {
  repairExpireAt,
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

describe('repairExpireAt：缓存脏数据自愈', () => {
  /**
   * 真实事故链（两天连着踩）：
   *
   *   1. 旧构建无条件 `dueDate * 1000` → 算出 expireAt = 1.81e15 存进缓存
   *   2. 修好算法后，新构建**仍读那份缓存** → 界面还是「57386 年后到期」
   *   3. 第一版修复把它清成 null → 界面变成「仅取流」，到期日**彻底消失**
   *
   * 第 3 步是本文件最重要的教训：播放账号的 cookie 只在扫码时的无痕分区里，
   * 窗口一关就没了，所以**普通分区再也探测不到它** —— 清成 null 就永远补不回来。
   * 脏值是可逆的（只多乘了一次 1000），必须**还原**而不是丢弃。
   */
  const YEAR = 365 * 86_400_000;

  it('多乘 1000 的值必须被还原成真实毫秒值（不是清掉）', () => {
    // 1.81e12 是真实毫秒值（≈2027-05-28），被旧代码乘 1000 后 = 1.81e15
    const repaired = repairExpireAt(1_811_500_000_000_000, NOW);
    expect(repaired).toBe(1_811_500_000_000);
    // 还原后走 describeExpiry 应该是个正常量级，而不是 5 万年
    expect(repaired! - NOW).toBeLessThan(20 * YEAR);
  });

  it('合理的值必须原样返回（最常见路径，一个字节都不改）', () => {
    // 主账号实测值 1773936000000 = 2026-03-19
    expect(repairExpireAt(1_773_936_000_000, NOW)).toBe(1_773_936_000_000);
    expect(repairExpireAt(NOW + 10 * YEAR, NOW)).toBe(NOW + 10 * YEAR);
  });

  it('已过期的时间戳原样返回 —— 那是真实状态，UI 会显示「已过期」', () => {
    expect(repairExpireAt(NOW - YEAR, NOW)).toBe(NOW - YEAR);
    expect(repairExpireAt(1_600_000_000_000, NOW)).toBe(1_600_000_000_000);
  });

  it('无法还原时返回 null（宁可没有，不能显示错）', () => {
    // 除以 1000 之后仍然是"过去"的值 → 还原不成立
    expect(repairExpireAt(NOW * 1000 * 1000, NOW)).toBeNull();
  });

  it('null / NaN / Infinity / 负数一律返回 null', () => {
    expect(repairExpireAt(null, NOW)).toBeNull();
    expect(repairExpireAt(Number.NaN, NOW)).toBeNull();
    expect(repairExpireAt(Number.POSITIVE_INFINITY, NOW)).toBeNull();
    expect(repairExpireAt(-1, NOW)).toBeNull();
    expect(repairExpireAt(0, NOW)).toBeNull();
  });

  it('阈值边界：99 年原样放过', () => {
    const at99 = NOW + 99 * YEAR;
    expect(repairExpireAt(at99, NOW)).toBe(at99);
  });

  it('除 1000 后不像真实到期日的，不许"还原"，必须返回 null', () => {
    /**
     * 测试抓到的真实缺陷：最初写成"除以 1000 只要不是未来 100 年就接受"，
     * 于是 `now + 101年` 被"还原"成「36 天后」——
     * 数字上不离谱，但它显然不是"多乘了 1000"造成的。
     * **凭空造一个到期日比显示 null 更糟**：用户会以为那是真的。
     */
    const at101 = NOW + 101 * YEAR;
    expect(repairExpireAt(at101, NOW)).toBeNull();
  });
});
