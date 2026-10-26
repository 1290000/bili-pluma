import { describe, expect, it } from 'vitest';

import { describeUnlock, unlockedBadges } from '@core/playinfo/summary-view';
import type { Capability, PageTracksView } from '@shared/types/playinfo';

/**
 * 守的是 §2.3 的文案不许越界。
 *
 * 「已解锁」是**能力声明**，「没有提升」是**事实陈述**。这条线画错的后果不是难看，
 * 而是用户看到「已解锁 4K」却只有 1080P —— 插件从"证据"变成"装饰"。
 *
 * 用例里的数字取自 2026-10-26 的真机实测（BV1jt421t7XH P1）：
 * 主账号 1080p/30fps，播放账号 2160p/60fps/Hi-Res，提升 1080p · +30fps · +Hi-Res。
 */

function cap(over: Partial<Capability> = {}): Capability {
  return {
    maxHeight: 2160,
    maxFrameRate: 60,
    maxFrameRateAtTopHeight: 60,
    hasHiRes: true,
    hasDolbyAudio: false,
    providesDolbyVision: false,
    topTrack: null,
    videoCount: 19,
    audioCount: 3,
    ...over,
  };
}

function view(over: Partial<PageTracksView> = {}): PageTracksView {
  return {
    bvid: 'BV1jt421t7XH',
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
      user: { uname: '{{primary_name}}', face: null },
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
  it('已解锁 4K / 60fps / Hi-Res，锚点是"主账号仅可用 1080P"', () => {
    const s = describeUnlock(view());
    expect(s?.title).toBe('已解锁');
    expect(s?.improved).toBe(true);
    expect(s?.badges).toEqual(['4K', '60fps', 'Hi-Res']);
    expect(s?.anchor).toBe('主账号仅可用 1080P');
  });
});

describe('describeUnlock：播放账号侧还没数据', () => {
  it('只说"等待取流"，不猜画质', () => {
    const s = describeUnlock(view({ playback: null, diff: null }));
    expect(s?.title).toBe('等待取流…');
    expect(s?.badges).toEqual([]);
    expect(s?.improved).toBe(false);
    // 锚点仍然给（主账号基线是独立拿到的）
    expect(s?.anchor).toBe('主账号仅可用 1080P');
  });
});

describe('describeUnlock：没有提升的两种原因必须分开说', () => {
  it('两侧完全相同 → 「无提升（源限制）」', () => {
    const primary = cap({ maxHeight: 1080, hasHiRes: false });
    const playback = cap({ maxHeight: 1080, hasHiRes: false });
    const s = describeUnlock(
      view({
        primary: { usable: true, reason: 'ssr', capability: primary, user: null, loggedIn: 'yes' },
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
    ['client-written', '主账号基线不可用（数据来源是播放账号）'],
    ['absent', '主账号基线未知（本页没有 SSR 数据）'],
    ['unparsable', '主账号基线未知（数据解析失败）'],
  ] as const)('%s → %s', (reason, expected) => {
    const s = describeUnlock(
      view({
        primary: { usable: false, reason, capability: null, user: null, loggedIn: 'yes' },
        diff: null,
      }),
    );
    expect(s?.anchor).toBe(expected);
  });

  it('usable 为真但能力为空（不该出现）时也不编数字', () => {
    const s = describeUnlock(
      view({
        primary: { usable: true, reason: 'ssr', capability: null, user: null, loggedIn: 'yes' },
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
        primary: { usable: false, reason: 'absent', capability: null, user: null, loggedIn: 'no' },
        diff: null,
      }),
    );
    expect(s?.title).toBe('未登录主账号');
    expect(s?.anchor).toBe('主账号未登录，无对比基线');
  });

  it('徽章仍按播放账号实际拿到的显示（实测 2160p 在响应里）', () => {
    const s = describeUnlock(
      view({
        primary: { usable: false, reason: 'absent', capability: null, user: null, loggedIn: 'no' },
        diff: null,
      }),
    );
    expect(s?.badges).toContain('4K');
  });
});
