import { describe, expect, it } from 'vitest';

import {
  MAX_BADGES,
  PGC_HIDDEN_BADGES,
  describeUnlock,
  unlockedBadges,
} from '@core/playinfo/summary-view';
import type { Capability, PageTracksView } from '@shared/types/playinfo';
import { QUALITY_NAMES } from '@shared/utils/quality';

/**
 * 守的是 §2.3 的文案不许越界。
 *
 * 「已解锁」是**能力声明**，「没有提升」是**事实陈述**。这条线画错的后果不是难看，
 * 而是用户看到「已解锁 4K」却只有 1080P —— 插件从"证据"变成"装饰"。
 *
 * 用例里的数字取自 2026-10-26 的真机实测（BV1jt421t7XH P1）：
 * 主账号 1080p/30fps，播放账号 2160p/60fps/Hi-Res，提升 1080p · +30fps · +Hi-Res。
 */

/**
 * 构造能力。
 *
 * ⚠️ **`topQualityIds` 必须跟着 `maxHeight` 一起变**，否则测试会自相矛盾：
 * 曾经写成固定 `[120]`，于是 `cap({ maxHeight: 4320 })` 得出「4K」而不是「8K」、
 * `cap({ maxHeight: 480 })` 得出「4K」而不是「480P」—— 两条断言同时变红。
 *
 * 现在的规则：调用方没显式给 `topQualityIds` 时，按 `maxHeight` 推一个**合理的 qid**，
 * 模拟真实数据（真实响应里 id 与 height 永远一致）。
 */
function cap(over: Partial<Capability> = {}): Capability {
  const maxHeight = over.maxHeight ?? 2160;
  const fallbackIds =
    maxHeight >= 4320 ? [127] : maxHeight >= 2160 ? [120] : maxHeight >= 1080 ? [80] : [32];

  return {
    maxHeight,
    maxFrameRate: 60,
    maxFrameRateAtTopHeight: 60,
    hasHiRes: true,
    hasDolbyAudio: false,
    providesDolbyVision: false,
    topTrack: null,
    videoCount: 19,
    audioCount: 3,
    ...over,
    // ⚠️ 放在 `...over` **之后**：`over.maxHeight` 变了而没给 ids 时，
    // 必须用按新高度算出的 fallback，否则 ids 与 height 互相矛盾
    topQualityIds: over.topQualityIds ?? fallbackIds,
  };
}

function view(over: Partial<PageTracksView> = {}): PageTracksView {
  return {
    pageKey: 'BV1jt421t7XH',
    p: 1,
    updatedAt: 0,
    primary: {
      usable: true,
      reason: 'ssr',
      capability: cap({
        maxHeight: 1080,
        maxFrameRate: 30,
        maxFrameRateAtTopHeight: 30,
        hasHiRes: false,
      }),
      user: { uname: 'testuser-primary', face: null, level: 6 },
      mid: null,
      loggedIn: 'yes',
    },
    playback: { capability: cap() },
    diff: {
      heightGain: 1080,
      frameRateGain: 30,
      hiResGained: true,
      dolbyAudioGained: false,
      dolbyVisionGained: false,
      improved: true,
    },
    ...over,
  };
}

describe('describeUnlock：不是视频页 / 还没报到', () => {
  it('null → null（popup 显示"打开任意视频页"）', () => {
    expect(describeUnlock(null)).toBeNull();
  });
});

describe('describeUnlock：真实提升（真机数据）', () => {
  it('已解锁 4K / 60fps / Hi-Res，锚点是"主账号最高 1080P"', () => {
    const s = describeUnlock(view());
    expect(s?.title).toBe('已解锁');
    expect(s?.improved).toBe(true);
    expect(s?.badges).toEqual(['4K', '60fps', 'Hi-Res']);
    expect(s?.anchor).toBe('主账号最高 1080P');
  });
});

describe('describeUnlock：播放账号侧还没数据', () => {
  it('只说"等待取流"，不猜画质', () => {
    const s = describeUnlock(view({ playback: null, diff: null }));
    expect(s?.title).toBe('等待取流…');
    expect(s?.badges).toEqual([]);
    expect(s?.improved).toBe(false);
    // 锚点仍然给（主账号基线是独立拿到的）
    expect(s?.anchor).toBe('主账号最高 1080P');
  });
});

describe('describeUnlock：没有提升的两种原因必须分开说', () => {
  it('两侧完全相同 → 「无提升（源限制）」', () => {
    const primary = cap({ maxHeight: 1080, hasHiRes: false });
    const playback = cap({ maxHeight: 1080, hasHiRes: false });
    const s = describeUnlock(
      view({
        primary: {
          usable: true,
          reason: 'ssr',
          capability: primary,
          user: null,
          mid: null,
          loggedIn: 'yes',
        },
        playback: { capability: playback },
        diff: {
          heightGain: 0,
          frameRateGain: 0,
          hiResGained: false,
          dolbyAudioGained: false,
          dolbyVisionGained: false,
          improved: false,
        },
      }),
    );
    expect(s?.title).toBe('无提升（源限制）');
    expect(s?.improved).toBe(false);
  });

  it('播放账号反而更弱 → 「没有提升」（这是异常，不是源限制）', () => {
    const s = describeUnlock(
      view({
        primary: {
          usable: true,
          reason: 'ssr',
          capability: cap({ maxHeight: 2160 }),
          user: null,
          mid: null,
          loggedIn: 'yes',
        },
        playback: { capability: cap({ maxHeight: 1080, hasHiRes: false }) },
        diff: {
          heightGain: -1080,
          frameRateGain: 0,
          hiResGained: false,
          dolbyAudioGained: false,
          dolbyVisionGained: false,
          improved: false,
        },
      }),
    );
    expect(s?.title).toBe('没有提升');
  });

  it('有播放账号数据但没有对比结论 → 「无法对比」', () => {
    const s = describeUnlock(
      view({
        primary: {
          usable: false,
          reason: 'client-written',
          capability: null,
          user: null,
          mid: null,
          loggedIn: 'yes',
        },
        diff: null,
      }),
    );
    expect(s?.title).toBe('无法对比');
  });
});

describe('describeUnlock：基线不可用时锚点必须说清原因', () => {
  it.each([
    ['client-written', '主账号基线不可用（数据来源是取流账号）'],
    ['absent', '主账号基线未知（本页没有 SSR 数据）'],
    ['unparsable', '主账号基线未知（数据解析失败）'],
  ] as const)('%s → %s', (reason, expected) => {
    const s = describeUnlock(
      view({
        primary: {
          usable: false,
          reason,
          capability: null,
          user: null,
          mid: null,
          loggedIn: 'yes',
        },
        diff: null,
      }),
    );
    expect(s?.anchor).toBe(expected);
  });

  it('usable 为真但能力为空（不该出现）时也不编数字', () => {
    const s = describeUnlock(
      view({
        primary: {
          usable: true,
          reason: 'ssr',
          capability: null,
          user: null,
          mid: null,
          loggedIn: 'yes',
        },
        diff: null,
      }),
    );
    expect(s?.anchor).toBe('主账号基线未知');
  });
});

describe('unlockedBadges', () => {
  it('30fps 不单独出徽章（多数视频的默认值，标出来是噪音）', () => {
    expect(unlockedBadges(cap({ maxFrameRateAtTopHeight: 30 }))).not.toContain('30fps');
  });

  it('用最高高度那一档的帧率，不是全轨最高', () => {
    // 1080P 有 120fps、4K 只有 60fps —— 徽章必须是 60fps
    const badges = unlockedBadges(cap({ maxFrameRate: 120, maxFrameRateAtTopHeight: 60 }));
    expect(badges).toContain('60fps');
    expect(badges).not.toContain('120fps');
  });

  it('杜比全景声与杜比视界分开出（语义不同）', () => {
    expect(unlockedBadges(cap({ hasDolbyAudio: true, providesDolbyVision: true }))).toEqual(
      expect.arrayContaining(['杜比全景声', '杜比视界']),
    );
  });

  it('⚠️ 永不产出 HDR 徽章（四个信号全被实测证伪）', () => {
    const badges = unlockedBadges(cap({ maxHeight: 4320, hasDolbyAudio: true }));
    expect(badges.join(',')).not.toMatch(/HDR/i);
  });

  it('8K 优先于 4K（顺序曾经写反过）', () => {
    expect(unlockedBadges(cap({ maxHeight: 4320 }))[0]).toBe('8K');
    expect(unlockedBadges(cap({ maxHeight: 2160 }))[0]).toBe('4K');
  });

  it('null → 空数组', () => {
    expect(unlockedBadges(null)).toEqual([]);
  });
});

describe('describeUnlock：主账号未登录（Q1 的 A 部分）', () => {
  /** 游客态：两侧都是 480P，diff 判成"两侧相同" */
  const guestView = (): PageTracksView =>
    view({
      primary: {
        usable: true,
        reason: 'ssr',
        capability: cap({
          maxHeight: 480,
          maxFrameRate: 30,
          maxFrameRateAtTopHeight: 30,
          hasHiRes: false,
        }),
        user: null,
        mid: null,
        loggedIn: 'no',
      },
      playback: {
        capability: cap({
          maxHeight: 480,
          maxFrameRate: 30,
          maxFrameRateAtTopHeight: 30,
          hasHiRes: false,
        }),
      },
      diff: {
        heightGain: 0,
        frameRateGain: 0,
        hiResGained: false,
        dolbyAudioGained: false,
        dolbyVisionGained: false,
        improved: false,
      },
    });

  it('⚠️ 说「未登录主账号」，不许说「无提升（源限制）」', () => {
    // 游客两侧都是 480P，若走"两侧相同"分支就会谎报成"这个视频本来只有 480P"
    const s = describeUnlock(guestView());
    expect(s?.title).toBe('未登录主账号');
    expect(s?.title).not.toBe('无提升（源限制）');
  });

  it('锚点也不说"仅可用 480P"——那读起来像"你这个号只有 480P"', () => {
    expect(describeUnlock(guestView())?.anchor).toBe('主账号未登录，无对比基线');
  });

  it('徽章仍按播放账号实际拿到的显示（不因为没登录就隐藏事实）', () => {
    expect(describeUnlock(guestView())?.badges).toEqual(['480P']);
  });

  it('若游客态真的拿到了提升，仍如实说「已解锁」（不被未登录盖掉）', () => {
    // Q1 的 B 部分尚未实测，这里只保证：万一代理对游客有效，UI 不会把成绩藏起来
    const s = describeUnlock(
      view({
        primary: {
          usable: true,
          reason: 'ssr',
          capability: cap({ maxHeight: 480 }),
          user: null,
          mid: null,
          loggedIn: 'no',
        },
      }),
    );
    expect(s?.title).toBe('已解锁');
    expect(s?.improved).toBe(true);
  });

  it('loggedIn 为 unknown（还没读到 cookie）时不改变原有判定', () => {
    const s = describeUnlock(
      view({
        // ⚠️ 两侧必须**完全一致**才算"源限制"，所以 hasHiRes 也要显式给 false
        // （cap() 的默认值有 Hi-Res，漏写就会走到"没有提升"分支）
        primary: {
          usable: true,
          reason: 'ssr',
          capability: cap({ maxHeight: 480, hasHiRes: false }),
          user: null,
          mid: null,
          loggedIn: 'unknown',
        },
        playback: { capability: cap({ maxHeight: 480, hasHiRes: false }) },
        diff: {
          heightGain: 0,
          frameRateGain: 0,
          hiResGained: false,
          dolbyAudioGained: false,
          dolbyVisionGained: false,
          improved: false,
        },
      }),
    );
    expect(s?.title).toBe('无提升（源限制）');
  });
});

describe('describeUnlock：游客页没有 __playinfo__（2026-10-26 InPrivate 实测）', () => {
  it('⚠️ diff 为 null 时也要说「未登录主账号」，不是「无法对比」', () => {
    // 实测：游客页 B站不 SSR __playinfo__，所以基线恒为 absent、diff 恒为 null。
    // 若按"先判 diff 再判登录"的顺序，会显示「无法对比」——
    // 那句话只说明"数据缺"，不告诉用户"该去登录"。
    const s = describeUnlock(
      view({
        primary: {
          usable: false,
          reason: 'absent',
          capability: null,
          user: null,
          mid: null,
          loggedIn: 'no',
        },
        diff: null,
      }),
    );
    expect(s?.title).toBe('未登录主账号');
    expect(s?.anchor).toBe('主账号未登录，无对比基线');
  });

  it('徽章仍按播放账号实际拿到的显示（实测 2160p 在响应里）', () => {
    const s = describeUnlock(
      view({
        primary: {
          usable: false,
          reason: 'absent',
          capability: null,
          user: null,
          mid: null,
          loggedIn: 'no',
        },
        diff: null,
      }),
    );
    expect(s?.badges).toContain('4K');
  });
});

/**
 * PGC 页（番剧 / 国创 / 电影）—— ADR 0024。
 *
 * ## 这条线为什么必须单独钉住
 *
 * PGC 页没有主账号基线，`diff` 恒为 `null`。修好 `pageKey` 之前，
 * 番剧页根本产不出 view（popup 停在「正在读取本页取流数据…」）；
 * 修好之后如果不拦，就会落到「无法对比」—— 那句读起来像"还在加载"，
 * 而真相是**设计上就不做对比**。
 *
 * 更不能说「已解锁」：那是能力声明，没有对比就没有证据。
 */
describe('describeUnlock：PGC 页不做对比（ADR 0024）', () => {
  /** PGC 页的典型形状：有播放账号侧数据，主账号基线不可用，diff 为 null */
  const pgc = (over: Partial<PageTracksView> = {}): PageTracksView => ({
    pageKey: 'ep:3854821',
    p: 1,
    updatedAt: 0,
    primary: {
      usable: false,
      reason: 'client-written',
      capability: null,
      user: { uname: '主账号', face: null, level: 6 },
      mid: null,
      loggedIn: 'yes',
    },
    playback: { capability: cap({ maxHeight: 2160, hasHiRes: true }) },
    diff: null,
    ...over,
  });

  it('标题是「已取得 4K」（事实陈述），不是「已解锁」', () => {
    const r = describeUnlock(pgc());
    expect(r?.title).toBe('已取得 4K');
    expect(r?.title).not.toBe('已解锁');
    expect(r?.improved).toBe(false);
  });

  it('锚点如实说不做对比，不写「无法对比」也不写「未知」', () => {
    const r = describeUnlock(pgc());
    expect(r?.anchor).toBe('取流账号提供');
    expect(r?.anchor).not.toContain('无法对比');
    expect(r?.anchor).not.toContain('未知');
  });

  it('徽章照常给 —— 不隐瞒播放账号实际拿到了什么', () => {
    const r = describeUnlock(pgc());
    expect(r?.badges).toContain('4K');
    expect(r?.badges).toContain('Hi-Res');
  });

  it('PGC 侧还没数据时仍是「等待取流…」且不说已取得', () => {
    const r = describeUnlock(pgc({ playback: null }));
    expect(r?.title).toBe('等待取流…');
    expect(r?.badges).toEqual([]);
  });

  it('主账号是游客也不影响 PGC 的措辞（本来就不对比）', () => {
    const r = describeUnlock(
      pgc({
        primary: {
          usable: false,
          reason: 'absent',
          capability: null,
          user: null,
          mid: null,
          loggedIn: 'no',
        },
      }),
    );
    expect(r?.title).toBe('已取得 4K');
    expect(r?.anchor).toBe('取流账号提供');
  });

  it('普通视频页不受影响 —— 仍然能说「已解锁」', () => {
    const r = describeUnlock(view());
    expect(r?.title).toBe('已解锁');
    expect(r?.improved).toBe(true);
  });
});

/**
 * 同高度多档 —— **2026-10-29 用户真机指出的 bug**。
 *
 * 用户原话：「我测试的这个番剧有 1080p 高码率还有 HDR 真彩」，
 * 而 popup 只显示了一个 `1080P`。
 *
 * 实测数据（ss34412，`dash.video[].id` 与 `support_formats` 双向核对）：
 * ```
 * 125  HDR 真彩        height 1080  bw 1437687
 * 112  1080P 高码率     height 1080  bw 3461623  ← 三条轨
 *  80  1080P 高清       height 1080  bw  987711
 *  64  720P 准高清      height  720
 * ```
 * 125 / 112 / 80 **高度完全相同**，`heightLabel` 必然把它们折叠成一个。
 */
describe('unlockedBadges：同高度多档（用 quality id 区分）', () => {
  it('ss34412 的真实档位：1080 档里只标 HDR 与 1080P+（1080P 已按用户要求去掉）', () => {
    const badges = unlockedBadges(
      cap({
        maxHeight: 1080,
        maxFrameRateAtTopHeight: 23,
        hasHiRes: false,
        topQualityIds: [125, 112, 80, 64, 32, 16],
      }),
    );
    expect(badges).toContain('HDR');
    expect(badges).toContain('1080P+');
    /**
     * ⚠️ 2026-10-29 用户要求：`80`(1080P) 不再出徽章。
     *
     * 理由：**不开大会员也能看 1080P**，它不是"这个身份额外拿到了什么"，
     * 标出来等于把"人人都有"说成"解锁成果"。
     * 同一批改动还删了 `116`(1080P60)，因为已有 `60fps` 徽章表达帧数。
     * 见 `src/shared/utils/quality.ts` 的 `BADGE_QUALITY_NAMES`。
     */
    expect(badges).not.toContain('1080P');
    // 只有高度信息时才会出现的那种"折叠"，这里不许再出现：
    // 即不能只有一个 1080P 而没有 1080P+ / HDR
    expect(badges.filter((b) => b.startsWith('1080P')).length).toBe(1);
  });

  it('按 id 降序（与 B 站画质菜单顺序一致）', () => {
    const badges = unlockedBadges(cap({ maxHeight: 1080, topQualityIds: [80, 125, 112] }));
    // 80(1080P) 已删 → 只剩 HDR / 1080P+
    expect(badges.slice(0, 2)).toEqual(['HDR', '1080P+']);
    expect(badges).not.toContain('1080P');
  });

  it('没有 id（老数据/解析失败）时退回高度标签，不猜档位', () => {
    expect(unlockedBadges(cap({ maxHeight: 1080, topQualityIds: [] }))[0]).toBe('1080P');
  });

  it('id 全是表里没有的 → 退回高度标签，不编名字', () => {
    expect(unlockedBadges(cap({ maxHeight: 1080, topQualityIds: [99999] }))[0]).toBe('1080P');
  });

  it('4K 场景不受影响：120 → 4K', () => {
    expect(unlockedBadges(cap({ maxHeight: 2160, topQualityIds: [120] }))[0]).toBe('4K');
  });
});

/**
 * 视频页 vs 番剧页的档位差异 —— **2026-10-29 真机实测对照**。
 *
 * ## 为什么要把这两组数据钉进测试
 *
 * 用户看到番剧页显示「1080P」而视频页显示「4K 60fps」，问是不是该把 60fps 换成 1080P+。
 * 实测两个视频的真实档位完全不同，**不能互换**：
 *
 * | 内容 | 真实 id 清单 | 说明 |
 * | --- | --- | --- |
 * | `BV1jt421t7XH` | `126 120 116 80 64 32 16` | **没有 112**；116 是 1080P60 |
 * | 番剧 `ep341208` | `125 112 80 64 32 16` | **没有 116**；有 125/112 |
 *
 * 结论：`60fps` 是**帧率**徽章（来自 `116` 那条轨的 `frame_rate`），
 * `1080P+` 是**画质档**徽章（来自 `112`）。两者不同维度、不同来源，
 * 在只有 `116` 的视频上换成 `1080P+` 会**凭空多报一个有实际意义的档位**。
 */
describe('真实档位对照：视频页与番剧页不是同一套档位', () => {
  it('BV1jt421t7XH：4K + 60fps，没有 1080P+', () => {
    /**
     * ⚠️ `topQualityIds` 只装**最高那一档**（2160）的 id —— 这是 `capabilityOf()`
     * 的真实语义。所以这里是 `[126, 120]`（杜比视界 + 4K 都标在 2160 上），
     * 不是整个 id 清单。传全集会让测试模拟出一个线上不存在的能力。
     */
    const badges = unlockedBadges(
      cap({
        maxHeight: 2160,
        maxFrameRateAtTopHeight: 60,
        hasHiRes: true,
        topQualityIds: [126, 120],
      }),
    );
    expect(badges).toContain('杜比视界');
    expect(badges).toContain('4K');
    expect(badges).not.toContain('1080P+');
    // 60fps 来自 116 那条轨的帧率，与画质档是两个维度 —— 不互相顶替
    expect(badges).toContain('60fps');
  });

  it('ep341208（番剧）：HDR + 1080P+ + 1080P，没有 4K', () => {
    // 这一集最高也是 1080，所以 125/112/80 三个都落在"最高那一档"里
    const badges = unlockedBadges(
      cap({
        maxHeight: 1080,
        maxFrameRateAtTopHeight: 24,
        hasHiRes: false,
        topQualityIds: [125, 112, 80],
      }),
    );
    expect(badges).toContain('HDR');
    expect(badges).toContain('1080P+');
    // 80(1080P) 已删除，见 quality.ts 的 BADGE_QUALITY_NAMES
    expect(badges).not.toContain('1080P');
    expect(badges).not.toContain('4K');
  });

  /**
   * 试看**不受分辨率限制** —— 真机实测（ep4292442，预告，49 秒）：
   * 档位 `112 80 64 32 16`、`accept_quality [112,80,64,32,16]`。
   * B 站的试看限制是**时长截断**，不是降画质。
   */
  it('试看内容也能有 1080P+（限制的是时长不是分辨率）', () => {
    const badges = unlockedBadges(
      cap({ maxHeight: 1080, maxFrameRateAtTopHeight: 30, topQualityIds: [112, 80, 64, 32, 16] }),
    );
    expect(badges[0]).toBe('1080P+');
  });
});

describe('徽章上限在真实数据下不会被撑爆', () => {
  it('两个实测样本的徽章数都 ≤ MAX_BADGES（不会被截断丢掉信息）', () => {
    const videoPage = unlockedBadges(
      cap({
        maxHeight: 2160,
        maxFrameRateAtTopHeight: 60,
        hasHiRes: true,
        topQualityIds: [126, 120],
      }),
    );
    const pgcPage = unlockedBadges(
      cap({
        maxHeight: 1080,
        maxFrameRateAtTopHeight: 24,
        hasHiRes: true,
        hasDolbyAudio: true,
        topQualityIds: [125, 112, 80],
      }),
    );
    expect(videoPage.length).toBeLessThanOrEqual(MAX_BADGES);
    expect(pgcPage.length).toBeLessThanOrEqual(MAX_BADGES);
    // 关键：截断不许发生在最前面几个（画质档必须保留）
    expect(videoPage[0]).toBe('杜比视界');
    expect(pgcPage[0]).toBe('HDR');
  });
});

/**
 * PGC 页徽章过滤 —— **2026-10-29 用户要求**。
 *
 * 用户原话：「试看能看 1080p 的，所以应该把番剧页的 popup 里的 1080p 去掉」。
 *
 * 判据不是"1080P 是低画质"，而是**试看本来就能看 1080P**
 * （B 站的试看限制是时长，不是分辨率）。所以在番剧页标 1080P
 * 等于告诉用户"你能看 1080P"—— 他没有插件也能做到，是废话。
 */
describe('describeUnlock：PGC 页不显示试看就能看的档位', () => {
  const pgc = (ids: number[], maxHeight = 1080): PageTracksView => ({
    pageKey: 'ep:341208',
    p: 1,
    updatedAt: 0,
    primary: {
      usable: false,
      reason: 'client-written',
      capability: null,
      user: { uname: '主账号', face: null, level: 6 },
      mid: null,
      loggedIn: 'yes',
    },
    playback: {
      capability: cap({
        maxHeight,
        maxFrameRateAtTopHeight: 24,
        hasHiRes: false,
        topQualityIds: ids,
      }),
    },
    diff: null,
  });

  it('125/112/80 → 只显示 HDR 和 1080P+，1080P 被去掉', () => {
    const r = describeUnlock(pgc([125, 112, 80]));
    expect(r?.badges).toEqual(['HDR', '1080P+']);
    expect(r?.badges).not.toContain('1080P');
  });

  it('标题也跳过被过滤的档：不是「已取得 1080P」而是「已取得 HDR」', () => {
    expect(describeUnlock(pgc([125, 112, 80]))?.title).toBe('已取得 HDR');
  });

  it('播放账号只拿到 80 → 徽章为空，标题不编具体档位', () => {
    const r = describeUnlock(pgc([80]));
    expect(r?.badges).toEqual([]);
    // 不许写「已取得 1080P」（那正是被要求去掉的东西）
    expect(r?.title).toBe('已取得取流账号的画质');
    expect(r?.title).not.toContain('1080P');
  });

  it('4K 场景不受影响（120 不该被过滤）', () => {
    const r = describeUnlock(pgc([120], 2160));
    expect(r?.badges).toContain('4K');
    expect(r?.title).toBe('已取得 4K');
  });

  it('普通视频页**不**做这个过滤（那里 1080P 是有意义的对比锚点）', () => {
    const r = describeUnlock(
      view({
        primary: {
          usable: true,
          reason: 'ssr',
          capability: cap({ maxHeight: 480, maxFrameRateAtTopHeight: 30, topQualityIds: [32] }),
          user: { uname: 'p', face: null, level: 1 },
          mid: null,
          loggedIn: 'yes',
        },
        playback: { capability: cap({ maxHeight: 1080, topQualityIds: [80] }) },
        diff: {
          heightGain: 600,
          frameRateGain: 0,
          hiResGained: false,
          dolbyAudioGained: false,
          dolbyVisionGained: false,
          improved: true,
        },
      }),
    );
    expect(r?.badges).toContain('1080P');
  });

  it('PGC_HIDDEN_BADGES 的每一项都必须能在 QUALITY_NAMES 里找到（防改名漂移）', () => {
    const known = new Set(Object.values(QUALITY_NAMES));
    for (const b of PGC_HIDDEN_BADGES) {
      expect(known.has(b)).toBe(true);
    }
  });
});

/**
 * 改 `topQualityIds` 为"每档取最高"之后的**副作用守卫**。
 *
 * 现在 `topQualityIds` 会包含 720/480/360 的 id（以前只有最高档）。
 * 而**视频页不做 PGC 过滤** —— 会不会因此多出一堆低档徽章、把
 * `MAX_BADGES`(6) 撑爆、把真正有意义的 `60fps` 挤掉？
 */
describe('topQualityIds 扩容后的徽章数量', () => {
  it('视频页：4K 视频的徽章不会因为收了 720/480/360 而爆掉', () => {
    const badges = unlockedBadges(
      cap({
        maxHeight: 2160,
        maxFrameRateAtTopHeight: 60,
        hasHiRes: true,
        // ep733317 的真实全集（v3 语义：全部收）
        topQualityIds: [125, 120, 112, 80, 64, 32, 16],
      }),
    );
    expect(badges.length).toBeLessThanOrEqual(MAX_BADGES);
    // 最前面的必须是最有意义的档，不能被低档挤掉
    // 720 及以下不做徽章（BADGE_QUALITY_NAMES 之外），所以第三位是 60fps
    expect(badges.slice(0, 3)).toEqual(['HDR', '4K', '1080P+']);
    // 60fps 与 Hi-Res 必须还在
    expect(badges).toContain('60fps');
    expect(badges).toContain('Hi-Res');
  });

  it('PGC 页：过滤低档后只剩 HDR / 1080P+（4K 视频的限免集）', () => {
    const r = describeUnlock({
      pageKey: 'ep:733317',
      p: 1,
      updatedAt: 0,
      primary: {
        usable: false,
        reason: 'client-written',
        capability: null,
        user: null,
        mid: null,
        loggedIn: 'yes',
      },
      playback: {
        capability: cap({
          maxHeight: 2160,
          maxFrameRateAtTopHeight: 24,
          hasHiRes: false,
          topQualityIds: [125, 120, 112, 80, 64, 32, 16],
        }),
      },
      diff: null,
    });
    // 按 id 降序：125(HDR) → 120(4K) → 112(1080P+)，80(1080P) 被过滤
    expect(r?.badges).toEqual(['HDR', '4K', '1080P+']);
  });
});

/**
 * 问题 5：关掉总开关后，画质区整块不显示。
 *
 * ## 原来的症状
 *
 * 关掉开关 → popup 仍显示「主账号基线未知（本页没有 SSR 数据）· 1080P」。
 * 那时**根本没在代理**，这行字描述的是一个不存在的东西 ——
 * 既不是对比、也不是错误，纯粹是噪音。用户要求"直接去掉"。
 *
 * ## 为什么用 `null` 而不是新加一个"空视图"类型
 *
 * `null` 原来只表示"不是播放页"。现在多一个含义"开关关着"。
 * 两者在 UI 上的处理**相同**（都不渲染画质卡），所以不需要区分 ——
 * popup 只需要知道"画这张卡吗"。
 *
 * 但**不能共用同一句提示文案**：非播放页是「打开视频页可见」（那句在这里成立），
 * 开关关着是**什么都不显示**（用户刚亲手关的，再说"去视频页看看"是装傻）。
 * 所以 `popup/main.tsx` 不再根据 `null` 反推文案，而是两层判断分开写。
 */
describe('describeUnlock：总开关关着时不产出视图（问题 5）', () => {
  /** 一份完整的视频页数据，用来证明"数据齐了也不显示" */
  const PLAY_VIEW = view({
    pageKey: 'BV1jt421t7XH',
    primary: {
      usable: true,
      reason: 'ssr',
      capability: cap({ maxHeight: 1080, topQualityIds: [80] }),
      user: { uname: 'x', face: null, level: 6 },
      mid: '1000001',
      loggedIn: 'yes',
    },
    playback: { capability: cap({ maxHeight: 2160, topQualityIds: [120] }) },
    diff: {
      heightGain: 1080,
      frameRateGain: 0,
      hiResGained: false,
      dolbyAudioGained: false,
      dolbyVisionGained: false,
      improved: true,
    },
  });

  it('proxyEnabled=false → 返回 null（数据齐全也不显示）', () => {
    expect(describeUnlock(PLAY_VIEW, false)).toBeNull();
  });

  it('proxyEnabled=true → 正常出视图（对照，证明不是永久 null）', () => {
    const r = describeUnlock(PLAY_VIEW, true);
    expect(r).not.toBeNull();
    expect(r?.improved).toBe(true);
  });

  it('不传第二个参数时默认 true（向后兼容，老调用点行为不变）', () => {
    expect(describeUnlock(PLAY_VIEW)).toEqual(describeUnlock(PLAY_VIEW, true));
  });

  it('proxyEnabled=false 时，连「主账号基线未知」那句也不产出（问题 5 的原症状）', () => {
    /** 构造"没有 SSR 数据"的情形 —— 正是用户报的那一条 */
    const noSsr = view({
      // 必须是**视频页**：PGC 页的锚点固定是「播放账号提供」，
      // 「主账号基线未知」那句只在视频页出现（见 anchorText 的 isVideoPage 分支）
      pageKey: 'BV1jt421t7XH',
      primary: {
        usable: false,
        reason: 'absent',
        capability: null,
        user: null,
        mid: null,
        loggedIn: 'unknown',
      },
      playback: null,
      diff: null,
    });
    // 开关开着时会显示锚点「主账号基线未知（本页没有 SSR 数据）」
    expect(describeUnlock(noSsr, true)?.anchor).toContain('主账号基线未知');
    // 关着时整块不产出
    expect(describeUnlock(noSsr, false)).toBeNull();
  });
});

/**
 * ## 步骤 3：`same-identity`（取流身份 == 页面身份）
 *
 * 这一组守的是一条**假事实**：
 *
 * 两侧是同一个号时，`diff` **不是 `null`** —— 它是同一份数据的两次计量，各项增益全 0。
 * 于是会落到 `same === true` 分支，标题「无提升（源限制）」。
 *
 * 那句在暗示"这个视频本来就只有这画质"，而真相是"你只有一个号"。
 * 用户会据此以为插件没起作用，或者以为视频本身糊 —— **这是会骗人的**。
 *
 * 正确出口是「无法对比」：只说"没有可比的数据"，不声称任何一方强弱。
 */
describe('describeUnlock：same-identity 走「无法对比」，不许说成源限制', () => {
  /** 同一份数据的两次计量：两侧能力完全相同 → 旧逻辑必然算出 same=true */
  const sameCap = cap({
    maxHeight: 1080,
    maxFrameRate: 30,
    maxFrameRateAtTopHeight: 30,
    hasHiRes: false,
  });

  function sameIdentityView(): PageTracksView {
    return view({
      primary: {
        usable: false, // same-identity 下基线不可用
        reason: 'same-identity',
        capability: null, // 能力已被清空
        user: { uname: 'testuser-primary', face: null, level: 6 },
        // 假 mid：测试只关心"有没有 mid"，不关心它具体是多少
        mid: '12345',
        loggedIn: 'yes',
      },
      playback: { capability: sameCap },
      /**
       * ⚠️ 关键：`diff` **非 null**，且增益全 0。
       * 这正是旧逻辑会误判成「无提升（源限制）」的输入。
       */
      diff: {
        heightGain: 0,
        frameRateGain: 0,
        hiResGained: false,
        dolbyAudioGained: false,
        dolbyVisionGained: false,
        improved: false,
      },
    });
  }

  it('标题是「无法对比」，**不是**「无提升（源限制）」', () => {
    const s = describeUnlock(sameIdentityView());
    expect(s?.title).toBe('无法对比');
    expect(s?.title).not.toContain('源限制');
  });

  it('锚点陈述事实，不喊用户去登录，也不报"基线不可用"', () => {
    const s = describeUnlock(sameIdentityView());
    expect(s?.anchor).toBe('取流身份与页面身份相同，无对比基线');
    // 「未登录主账号」是行动号召，只在真没登录时才对 —— 这里不该出现
    expect(s?.anchor).not.toContain('未登录');
    // 「不可用」读起来像故障，而同一身份是正常状态
    expect(s?.anchor).not.toContain('不可用');
  });

  it('improved 恒为 false（没有对比就没有能力声明）', () => {
    expect(describeUnlock(sameIdentityView())?.improved).toBe(false);
  });

  /**
   * ## 对照组：证明上面三条不是恒真
   *
   * 把 reason 换回 `'ssr'` + 两侧能力相同 + `diff` 非 null，
   * **必须**得到「无提升（源限制）」—— 那说明这个分支确实由 reason 决定，
   * 而不是因为输入本来就落不到那里。
   */
  it('对照：同样的 diff、reason=ssr → 仍走「无提升（源限制）」', () => {
    const v = sameIdentityView();
    const asSsr = view({
      ...v,
      primary: {
        ...v.primary,
        usable: true,
        reason: 'ssr',
        capability: sameCap, // 两侧相同
      },
    });
    expect(describeUnlock(asSsr)?.title).toBe('无提升（源限制）');
  });

  /**
   * ⚠️ **本文件测不到 `page-identity` 的接入**，说明一下免得下一个人误以为覆盖了：
   *
   * `describeUnlock` 的输入是 `PageTracksView`，里面的 `primary.reason` 是
   * **`page-state.ts` 收敛后**的值，取不到 background 的原始 `ProxyActivateReason`。
   *
   * 所以"`page-identity` 会不会变成 `same-identity`"这件事
   * **只能在 `tests/unit/content/page-state.test.ts` 里测**（见那边的
   * 「page-identity 收成 same-identity」用例）。
   *
   * 本文件的职责边界：只要 `primary.reason === 'same-identity'`，
   * 就必须输出「无法对比」且不落「无提升（源限制）」—— 上面三条已经锁住。
   */

  /**
   * `same-identity` **优先于** `loggedIn === 'no'`。
   *
   * 两者真机上互斥（游客态 `primaryMid === null` → `self` 分支不触发），
   * 但互斥由 `page.handler.ts` 保证，不是这里保证的。
   * 一旦被破坏，先说**事实**（同一身份），再喊用户去登录 ——
   * 否则用户白跑一趟去登录，登录完还是这套数据。
   */
  it('互斥被破坏时（same-identity + loggedIn=no）→ 先说事实，不喊去登录', () => {
    const v = sameIdentityView();
    const broken = view({ ...v, primary: { ...v.primary, loggedIn: 'no' } });

    const s = describeUnlock(broken);
    expect(s?.anchor).toBe('取流身份与页面身份相同，无对比基线');
    expect(s?.title).toBe('无法对比');
  });
});

/**
 * ## task-26：`same-identity` 的**两种成因，两句话术**
 *
 * ### 用户看到的问题（真机实测）
 *
 * `page` 模式（用户主动选了「浏览器账号」）下，画质区**同一屏出现两句互不衔接的话**：
 *   - 标题「**无需代理**」—— 说的是"你选了浏览器账号"
 *   - 锚点「**取流身份与页面身份相同**」—— 说的是"两个账号刚好是同一个"
 *
 * 用户原话：**「我是自己选的浏览器账号，为什么说身份相同？」**
 *
 * ### 根因：合并判据是对的，合并**话术**是错的
 *
 * `SAME_IDENTITY_REASONS = ['self', 'page-identity']` 回答的是
 * **「有没有第二个身份可比」** —— 两者答案确实相同（都没有），**那个数组合并是对的**。
 *
 * 但「**为什么**没有第二个身份」不同，界面必须分别说：
 *
 * | 成因 | 事实 | 话术 |
 * | --- | --- | --- |
 * | `self` | 两个 mid **碰巧相同** | **事实陈述**：「身份相同」 |
 * | `page-identity` | 用户**主动选择**用浏览器账号 | **选择陈述**：「用浏览器登录账号」 |
 *
 * **这就是「成因不同、后果相同」在界面层的落点遗漏。**
 *
 * ### 为什么用 `proxyIdentity` 而不是新增枚举值
 *
 * `primary.reason` 仍然只是 `'same-identity'` —— **不改 `SAME_IDENTITY_REASONS`**，
 * 也**不新增 `PrimaryBaselineReason` 值**（那会动摇"有没有第二个身份可比"这条判据）。
 * 区分显示只需多读一个**已有字段** `PageTracksView.proxyIdentity`。
 */
describe('task-26：same-identity 按成因分支话术', () => {
  const sameCap = cap({
    maxHeight: 1080,
    maxFrameRate: 30,
    maxFrameRateAtTopHeight: 30,
    hasHiRes: false,
  });

  /** 构造 `same-identity` 视图，可选择带哪个 `proxyIdentity` */
  function sameIdentityWith(proxyIdentity?: PageTracksView['proxyIdentity']): PageTracksView {
    return view({
      primary: {
        usable: false,
        reason: 'same-identity',
        capability: null,
        user: { uname: 'testuser-primary', face: null, level: 6 },
        mid: '12345',
        loggedIn: 'yes',
      },
      playback: { capability: sameCap },
      diff: {
        heightGain: 0,
        frameRateGain: 0,
        hiResGained: false,
        dolbyAudioGained: false,
        dolbyVisionGained: false,
        improved: false,
      },
      ...(proxyIdentity === undefined ? {} : { proxyIdentity }),
    });
  }

  it('★ page-identity → 话术含「浏览器登录账号」，**不含**「身份相同」', () => {
    const s = describeUnlock(sameIdentityWith('page-identity'));
    expect(s?.anchor).toContain('浏览器登录账号');

    /**
     * ⚠️ 这两条是**核心**：用户抱怨的正是"我选的，为什么说身份相同"。
     * 只要这里还出现「身份相同」，那个 bug 就没修。
     */
    expect(s?.anchor, 'page-identity 下仍说「身份相同」= 原 bug 未修').not.toContain('身份相同');
  });

  it('★ self → 话术含「身份相同」，**不含**「浏览器登录账号」', () => {
    const s = describeUnlock(sameIdentityWith('self'));
    expect(s?.anchor).toContain('身份相同');

    /**
     * 反向也要守：`self` 是"两个号碰巧一样"的**事实**，
     * 说成"你选了浏览器账号"是**假话** —— 用户可能根本没选过。
     */
    expect(s?.anchor, 'self 下说「浏览器登录账号」= 把事实说成了选择').not.toContain(
      '浏览器登录账号',
    );
  });

  it('★ 两种成因话术**必须不同**（这是本任务的全部意义）', () => {
    const selfAnchor = describeUnlock(sameIdentityWith('self'))?.anchor;
    const pageAnchor = describeUnlock(sameIdentityWith('page-identity'))?.anchor;
    expect(pageAnchor).not.toBe(selfAnchor);
  });

  it('★ proxyIdentity 缺失（老快照 / 回包未到）→ 回落**事实陈述**（保守方向）', () => {
    /**
     * ## 为什么缺失时回落"身份相同"而不是"浏览器登录账号"
     *
     * 那是**保守方向**：
     *   - 「身份相同」在 `self` 情形下**永远正确**，只是没说清成因
     *   - 而把 `self` 说成"你选的浏览器账号"是**假话**（用户可能根本没选）
     *
     * 两个方向的错误代价不对称 → 选"可能不精确但永不说错"的那个。
     */
    const s = describeUnlock(sameIdentityWith(undefined));
    expect(s?.anchor).toBe('取流身份与页面身份相同，无对比基线');
  });

  it('★ 其他 proxyIdentity 值（如 unknown / ok）→ 也回落事实陈述', () => {
    for (const other of ['unknown', 'ok', 'disabled', 'self'] as const) {
      const s = describeUnlock(sameIdentityWith(other));
      expect(s?.anchor, `proxyIdentity=${other} 不该说成"浏览器登录账号"`).not.toContain(
        '浏览器登录账号',
      );
    }
  });

  it('两种成因的**标题**相同（都是「无法对比」—— 结论一致，成因不同）', () => {
    /**
     * 话术分支只影响**锚点**，不影响**标题**：
     * 两者确实都"没有可对比的第二方"，结论相同。
     * 若标题也分了，就变成两个界面状态 —— 而任务约束明确"不新增状态"。
     */
    for (const id of ['self', 'page-identity'] as const) {
      const s = describeUnlock(sameIdentityWith(id));
      expect(s?.title, `proxyIdentity=${id} 的标题不该变`).toBe('无法对比');
    }
  });

  it('两种成因的 improved 都是 false（没有对比就没有能力声明）', () => {
    for (const id of ['self', 'page-identity'] as const) {
      expect(describeUnlock(sameIdentityWith(id))?.improved).toBe(false);
    }
  });
});
