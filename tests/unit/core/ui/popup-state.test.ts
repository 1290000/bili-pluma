import { describe, expect, it } from 'vitest';

import type { StatBucket } from '@shared/types/stats';
import {
  DEGRADED_RATE,
  MIN_SAMPLES,
  countSamples,
  describeExpiry,
  describePopup,
  describeVip,
  sampleRate,
  type PopupAccount,
  type PopupSnapshot,
} from '@core/ui/popup-state';

/**
 * 这些用例守的是"popup 会不会骗人"。
 *
 * popup 唯一的职责是回答"现在生效了吗"。判错顺序的后果不是难看，
 * 而是**用户以为在生效、实际没有**，或者反过来被吓去重扫码。
 */

const NOW = 1_760_000_000_000;

const healthyAccount: PopupAccount = {
  uname: '测试号',
  mid: 123,
  vipLabel: 'annual',
  expireAt: NOW + 200 * 86_400_000,
  healthy: true,
  checkedAt: NOW,
  reason: null,
};

function snap(over: Partial<PopupSnapshot> = {}): PopupSnapshot {
  return {
    proxy: { enabled: true, hasCredential: true, ruleCount: 2 },
    configured: true,
    account: healthyAccount,
    buckets: [],
    page: { kind: 'play' },
    ...over,
  };
}

function buckets(ok: number, fail: number): StatBucket[] {
  return [{ start: 0, ok, fail }];
}

describe('sampleRate —— null 与 0 是两个意思', () => {
  it('没有样本 → null（不是 0）', () => {
    expect(sampleRate([])).toBeNull();
    expect(sampleRate(buckets(0, 0))).toBeNull();
  });

  it('样本不足 → null，不下结论', () => {
    expect(sampleRate(buckets(1, 0))).toBeNull();
    expect(sampleRate(buckets(1, 1))).toBeNull();
  });

  it('样本够了才给数', () => {
    expect(sampleRate(buckets(3, 0))).toBe(1);
    expect(sampleRate(buckets(0, 3))).toBe(0);
  });

  it('全部失败是 0，不是 null', () => {
    const r = sampleRate(buckets(0, MIN_SAMPLES));
    expect(r).toBe(0);
    expect(r).not.toBeNull();
  });
});

describe('countSamples', () => {
  it('累加 ok + fail', () => {
    expect(countSamples([{ start: 0, ok: 2, fail: 1 }])).toBe(3);
  });

  it('空桶不计入（没请求过 ≠ 失败）', () => {
    expect(countSamples([{ start: 0, ok: 0, fail: 0 }])).toBe(0);
  });
});

describe('describePopup —— 判定顺序', () => {
  it('未配置：即使开关开着也算未配置（没有凭据就没有规则）', () => {
    const v = describePopup(
      snap({
        configured: false,
        account: null,
        proxy: { enabled: true, hasCredential: false, ruleCount: 0 },
      }),
    );
    expect(v.state).toBe('not-configured');
    expect(v.needsLogin).toBe(true);
  });

  it('凭据确实不存在 + 拿不到资料 → 凭据失效', () => {
    // 只有 hasCredential:false 才是"真没凭据"。
    // hasCredential:true 时即使 account 为 null 也不该报警（见下一组用例）
    const v = describePopup(
      snap({ account: null, proxy: { enabled: true, hasCredential: false, ruleCount: 0 } }),
    );
    expect(v.state).toBe('credential-missing');
    expect(v.pill).toBe('凭据失效');
    expect(v.needsLogin).toBe(true);
  });

  it('明确 -101 且规则没了 → 凭据失效', () => {
    const v = describePopup(
      snap({
        account: { ...healthyAccount, healthy: false, reason: '账号未登录（-101）' },
        proxy: { enabled: true, hasCredential: true, ruleCount: 0 },
      }),
    );
    expect(v.state).toBe('expired');
    expect(v.tone).toBe('bad');
  });

  it('失效原因会显示出来（归因）', () => {
    const v = describePopup(
      snap({
        account: { ...healthyAccount, healthy: false, reason: '账号未登录（-101）' },
        proxy: { enabled: true, hasCredential: true, ruleCount: 0 },
      }),
    );
    expect(v.line).toContain('-101');
  });

  it('用户主动关闭 → 已停用，不是故障，不触发扫码', () => {
    const v = describePopup(snap({ proxy: { enabled: false, hasCredential: true, ruleCount: 0 } }));
    expect(v.state).toBe('stopped');
    expect(v.tone).toBe('neutral');
    expect(v.needsLogin).toBe(false);
  });

  it('停用时即使成功率很低也不报警（自己关的，低成功率是预期）', () => {
    const v = describePopup(
      snap({
        proxy: { enabled: false, hasCredential: true, ruleCount: 0 },
        buckets: buckets(0, 10),
      }),
    );
    expect(v.state).toBe('stopped');
  });

  /**
   * ⚠️ **这条在 2026-10-29 被用户否决，语义反转了。**
   *
   * 原断言：`ruleCount: 0` → `inconsistent`（异常，bad 色）。
   *
   * 用户真机反馈：
   * > 「番剧页从别的页面切回来 popup 里面就会显示开关开着但规则没装上，
   * > 请关闭再开启一次，可问题是播放已经成功的被接管了，不用再重新开关一次」
   *
   * 现在 `ruleCount: 0` **不报警**，落到「已接管」。理由见 `popup-state.ts`
   * 那段长注释：切回标签页瞬间规则异步重建、以及 `countPathRules()`
   * 只数全局规则而番剧页生效的是标签页规则，两种情况下 0 都不代表故障。
   */
  it('开关开着但 0 条规则 → 不报警，仍是「已接管」（2026-10-29 用户否决了旧行为）', () => {
    const v = describePopup(snap({ proxy: { enabled: true, hasCredential: true, ruleCount: 0 } }));
    expect(v.state).not.toBe('inconsistent');
    expect(v.state).toBe('active');
    expect(v.tone).toBe('good');
    // 并且不该有任何解释文字
    expect(v.line).toBeUndefined();
  });

  it('成功率低于阈值 → 已降级，用 warn 色', () => {
    const v = describePopup(snap({ buckets: buckets(1, Math.ceil(MIN_SAMPLES / DEGRADED_RATE)) }));
    expect(v.state).toBe('degraded');
    expect(v.tone).toBe('warn');
  });

  it('成功率达标 → 已接管', () => {
    const v = describePopup(snap({ buckets: buckets(10, 0) }));
    expect(v.state).toBe('active');
    expect(v.tone).toBe('good');
  });

  it('样本不足时不判降级（避免 1 次失败就报"成功率 0%"）', () => {
    const v = describePopup(snap({ buckets: buckets(0, 2) }));
    expect(v.state).toBe('active');
  });

  it('没有样本时也是已接管，不是降级', () => {
    expect(describePopup(snap({ buckets: [] })).state).toBe('active');
  });
});

describe('describeExpiry —— 相对时间', () => {
  it('无到期日返回空串（非会员不该显示"已过期"）', () => {
    expect(describeExpiry(null, NOW)).toBe('');
  });

  it('已过期', () => {
    expect(describeExpiry(NOW - 86_400_000, NOW)).toBe('已过期');
    // 刚好到点也算过期
    expect(describeExpiry(NOW, NOW)).toBe('已过期');
  });

  it('还剩不到一天 → 今天到期（不能显示成"1 天后"）', () => {
    // 回归：曾经用 Math.ceil，把 1 小时算成"1 天后到期"
    expect(describeExpiry(NOW + 3600_000, NOW)).toBe('今天到期');
    expect(describeExpiry(NOW + 23 * 3600_000, NOW)).toBe('今天到期');
  });

  it('1 天零 1 小时仍是 1 天后（floor 不往前凑）', () => {
    expect(describeExpiry(NOW + 86_400_000 + 3600_000, NOW)).toBe('1 天后到期');
  });

  it('30 天内按天', () => {
    expect(describeExpiry(NOW + 5 * 86_400_000, NOW)).toBe('5 天后到期');
  });

  it('超过 30 天按月', () => {
    expect(describeExpiry(NOW + 90 * 86_400_000, NOW)).toBe('3 个月后到期');
    // 59 天是"1 个月"而不是"2 个月"（floor）
    expect(describeExpiry(NOW + 59 * 86_400_000, NOW)).toBe('1 个月后到期');
  });
});

describe('describeVip', () => {
  it('年度会员带到期日', () => {
    expect(describeVip({ vipLabel: 'annual', expireAt: NOW + 60 * 86_400_000 }, NOW)).toContain(
      '年度大会员',
    );
  });

  it('非会员不拼到期日', () => {
    expect(describeVip({ vipLabel: 'none', expireAt: null }, NOW)).toBe('非会员');
  });

  it('会员类型未知按月度显示，不夸大成年度', () => {
    expect(describeVip({ vipLabel: 'monthly', expireAt: null }, NOW)).toBe('大会员');
  });
});

describe('探测失败 ≠ 凭据失效（踩过的坑）', () => {
  /**
   * 用户实际遇到的场景：
   *   画质正常播到 2160p，DNR 规则 2 条都在，
   *   但 popup 显示"凭据读取失败，需要重新扫码"。
   *
   * 原因是探活（nav 请求）走不通——手动设 Cookie 头是 forbidden header，
   * 会被浏览器丢弃，探测于是以未登录身份发出，返回 -101。
   * 探活失败被误当成了"凭据失效"。
   *
   * 判据应该是：**DNR 规则在，代理就在工作，不该报警。**
   */
  it('规则在但拿不到账号资料 → 已接管，不报凭据失效', () => {
    const v = describePopup(
      snap({
        account: null,
        proxy: { enabled: true, hasCredential: true, ruleCount: 2 },
      }),
    );
    expect(v.state).toBe('active');
    expect(v.needsLogin).toBe(false);
    expect(v.pill).toBe('已接管');
  });

  it('规则在但 health=false → 已接管，不让用户重扫一个能用的号', () => {
    const v = describePopup(
      snap({
        account: { ...healthyAccount, healthy: false, reason: '网络不可达' },
        proxy: { enabled: true, hasCredential: true, ruleCount: 2 },
      }),
    );
    expect(v.state).toBe('active');
    expect(v.needsLogin).toBe(false);
  });

  it('凭据真不存在 + 拿不到资料 → 真的凭据失效', () => {
    const v = describePopup(
      snap({
        account: null,
        proxy: { enabled: true, hasCredential: false, ruleCount: 0 },
      }),
    );
    expect(v.state).toBe('credential-missing');
    expect(v.needsLogin).toBe(true);
  });

  it('明确 -101 + 规则没了 → 真的失效', () => {
    const v = describePopup(
      snap({
        account: { ...healthyAccount, healthy: false, reason: '账号未登录（-101）' },
        proxy: { enabled: true, hasCredential: true, ruleCount: 0 },
      }),
    );
    expect(v.state).toBe('expired');
    expect(v.needsLogin).toBe(true);
  });

  it('开关关掉时，即便 health=false 也只报已停用', () => {
    const v = describePopup(
      snap({
        account: { ...healthyAccount, healthy: false },
        proxy: { enabled: false, hasCredential: true, ruleCount: 0 },
      }),
    );
    // 已停用优先：用户自己关的，不能同时报两种状态
    expect(v.state).toBe('stopped');
    expect(v.needsLogin).toBe(false);
  });
});

describe('第一次点图标误报"凭据失效"（竞态）', () => {
  /**
   * 用户报的 bug：第一次点扩展图标总显示"凭据失效，需要重新扫码"，
   * 再点一次就正常显示"已接管"。
   *
   * 根因：首次打开时 `account/summary` 还在探测（nav 要往返），返回 `account: null`；
   * 若当时用户不在视频页，`ruleCount` 也恰好是 0。旧逻辑只看 `ruleCount > 0`，
   * 于是走进"凭据失效"。
   *
   * `proxy.hasCredential` 读的是 storage 里密文是否存在——同步、不依赖网络，
   * 是"凭据确实在"的**硬证据**。它说有就不能报警。
   */
  it('hasCredential=true + account=null + ruleCount=0 → 已接管，不报警', () => {
    const v = describePopup(
      snap({
        account: null,
        proxy: { enabled: true, hasCredential: true, ruleCount: 0 },
      }),
    );
    expect(v.state).toBe('active');
    expect(v.needsLogin).toBe(false);
    expect(v.pill).toBe('已接管');
  });

  it('第二次打开拿到资料后，状态不会变化（不闪）', () => {
    const first = describePopup(
      snap({ account: null, proxy: { enabled: true, hasCredential: true, ruleCount: 0 } }),
    );
    const second = describePopup(
      snap({
        account: healthyAccount,
        proxy: { enabled: true, hasCredential: true, ruleCount: 2 },
      }),
    );
    // 两次都是"已接管"，用户不会看到状态跳变
    expect(first.state).toBe(second.state);
    expect(first.pill).toBe(second.pill);
  });

  it('hasCredential=false 才是真未配置/失效', () => {
    const v = describePopup(
      snap({ account: null, proxy: { enabled: false, hasCredential: false, ruleCount: 0 } }),
    );
    expect(v.state).toBe('credential-missing');
  });
});

describe('ruleCount = -1 表示"读不到"而不是"没有规则"', () => {
  /**
   * 诊断日志曾经出现互相矛盾的两行：
   *   播放代理总开关  已开启（0 条路径规则，⚠️ 不一致）
   *   DNR 全局路径规则 2
   *
   * 根因：background 的 `proxy/status` 把三个取值包在一个 try 里，
   * 任何一处抛异常就整体返回 `ruleCount: 0`，UI 于是报"不一致"。
   * 而诊断页自己调 `getSessionRules()` 能正常看到 2 条。
   *
   * 修法：读不到时用 -1 表示"未知"，UI 不能把未知当成 0。
   */
  it('ruleCount=-1 + 开关开 → 不报不一致', () => {
    const v = describePopup(snap({ proxy: { enabled: true, hasCredential: true, ruleCount: -1 } }));
    expect(v.state).not.toBe('inconsistent');
    expect(v.tone).not.toBe('bad');
  });

  it('ruleCount=0 + 开关开 → 也不报不一致（2026-10-29 改：见上方同义用例）', () => {
    const v = describePopup(snap({ proxy: { enabled: true, hasCredential: true, ruleCount: 0 } }));
    expect(v.state).toBe('active');
  });
});

describe('状态 5：当前页不是视频页（2026-10-26 新增）', () => {
  it('有账号、开关开、但在首页 → 未生效（不是「已接管」）', () => {
    const v = describePopup(snap({ page: { kind: 'other' } }));
    expect(v.state).toBe('not-video');
    expect(v.pill).toBe('未生效');
    // 中性色：这不是故障，不该报警
    expect(v.tone).toBe('neutral');
    expect(v.needsLogin).toBe(false);
  });

  it('⚠️ 用户自己关掉开关时，「已停用」优先于「未生效」', () => {
    // 排序依据：与用户操作相关的状态 > 与页面上下文相关的状态
    const v = describePopup(
      snap({
        page: { kind: 'other' },
        proxy: { enabled: false, hasCredential: true, ruleCount: 0 },
      }),
    );
    expect(v.state).toBe('stopped');
  });

  it('未配置时仍然说「未配置」——引导扫码比说"页面不对"有用', () => {
    const v = describePopup(snap({ page: { kind: 'other' }, configured: false, account: null }));
    expect(v.state).toBe('not-configured');
    expect(v.needsLogin).toBe(true);
  });

  it('拿不到账号资料但有凭据 + 不在视频页 → 未生效（不说「已接管」）', () => {
    // 这条曾经会返回 active 并写"取流已由播放账号接管"，而用户根本不在视频页
    const v = describePopup(snap({ page: { kind: 'other' }, account: null }));
    expect(v.state).toBe('not-video');
  });

  it('在视频页时不受影响（回归）', () => {
    expect(describePopup(snap({ page: { kind: 'play' } })).state).toBe('active');
  });
});

describe('describeExpiry：超过一年要说"年"', () => {
  it('800 天 → 2 年后到期', () => {
    // 不加这一档，单位算错时会显示"698197 个月后到期"——
    // 那种数字没人读得懂，也就没人发现它是 bug
    expect(describeExpiry(NOW + 800 * 86_400_000, NOW)).toBe('2 年后到期');
  });

  it('365 天以内仍是"个月"（不越过 1 年就别说年）', () => {
    expect(describeExpiry(NOW + 200 * 86_400_000, NOW)).toBe('6 个月后到期');
  });
});

/**
 * 「被要求删掉的文案」守卫 —— 2026-10-29 用户逐条点名。
 *
 * ## 为什么要专门写这种"不存在"的测试
 *
 * 这几句都是一句 `line` 字符串，删掉之后**没有任何编译错误、也没有别的测试会发现**。
 * 下一个人只要觉得"popup 太空了"就会顺手加回去 —— 而用户已经明确说过三次不要。
 *
 * 用断言把它们钉住，比在任何文档里写"不要加"都可靠。
 *
 * 用户原话（2026-10-29）：
 * > 「番剧页的取流已由播放账号接管、当前使用主账号画质、
 * >  开关开着但规则没装上，请关闭再开启一次，这些文字都可以删掉。
 * >  非视频页的当前页不是播放页、打开视频或番剧后这里会显示该页已解锁的画质，
 * >  这些文字也都可以删掉。」
 */
describe('被删掉的文案不许加回来', () => {
  const forbidden = [
    '取流已由播放账号接管',
    '当前使用主账号画质',
    '规则没装上',
    '当前页不是播放页',
    '打开任意视频页',
    '打开视频或番剧后',
  ];

  it('已接管状态没有解释文字', () => {
    const v = describePopup(snap());
    expect(v.state).toBe('active');
    expect(v.line).toBeUndefined();
  });

  it('已停用状态没有解释文字', () => {
    const v = describePopup(snap({ proxy: { enabled: false, hasCredential: true, ruleCount: 2 } }));
    expect(v.state).toBe('stopped');
    expect(v.line).toBeUndefined();
  });

  it('非视频页没有解释文字', () => {
    const v = describePopup(snap({ page: { kind: 'other' } }));
    expect(v.state).toBe('not-video');
    expect(v.line).toBeUndefined();
  });

  it('任何状态下都不会出现这些句子', () => {
    const cases = [
      snap(),
      snap({ page: { kind: 'other' } }),
      snap({ proxy: { enabled: false, hasCredential: true, ruleCount: 2 } }),
      snap({ proxy: { enabled: true, hasCredential: true, ruleCount: 0 } }),
      snap({ buckets: buckets(1, 10) }),
      snap({ account: null }),
      snap({ configured: false }),
    ];
    for (const s of cases) {
      const v = describePopup(s);
      for (const bad of forbidden) {
        expect(v.line ?? '').not.toContain(bad);
      }
    }
  });
});
