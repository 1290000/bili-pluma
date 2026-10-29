/**
 * popup 快照的组装逻辑。
 *
 * ## 为什么快照本身要有测试
 *
 * `chrome-extension://` 页面被 bsk sandbox 拒绝 `evaluate`，所以 popup 渲染成什么样
 * **只能靠用户手点截图**。快照接口就是为了把这件事变成可读 JSON。
 *
 * 但如果快照自己写错了，自动化会**报一个不存在的 bug** —— 比没有快照更糟
 * （用户会去排查一个虚构的问题）。所以这里断言的是"快照与 popup 会渲染的内容一致"。
 *
 * ## 断言重点
 *
 * 1. **不许带凭据**（AGENTS §5.2）—— 序列化后整段 grep
 * 2. `texts` 那两行与 `popup/main.tsx` 的 JSX 拼法一致
 * 3. 开关关着时 `unlock` 与 `texts.unlockLine` 都是 `null`（问题 5 的快照侧）
 */

import { describe, expect, it } from 'vitest';

import type { Capability, PageTracksView } from '@shared/types/playinfo';
import { buildPageSnapshot } from '@core/ui/page-snapshot';

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
    topQualityIds: [120, 112],
    ...over,
  };
}

function pageView(over: Partial<PageTracksView> = {}): PageTracksView {
  return {
    pageKey: 'BV1jt421t7XH',
    p: 1,
    updatedAt: 0,
    primary: {
      usable: true,
      reason: 'ssr',
      capability: cap({ maxHeight: 1080, topQualityIds: [112] }),
      user: { uname: '主账号昵称', face: null, level: 6 },
      mid: null,
      loggedIn: 'yes',
    },
    playback: { capability: cap() },
    diff: {
      heightGain: 1080,
      frameRateGain: 0,
      hiResGained: false,
      dolbyAudioGained: false,
      dolbyVisionGained: false,
      improved: true,
    },
    ...over,
  };
}

const ACCOUNT = {
  uname: '播放账号昵称',
  mid: 1000002,
  vipLabel: 'annual' as const,
  expireAt: 1900000000000,
  healthy: true,
};

const PROXY_ON = { enabled: true, hasCredential: true, ruleCount: 3 };
const PROXY_OFF = { enabled: false, hasCredential: true, ruleCount: 0 };

describe('buildPageSnapshot —— 基本字段', () => {
  it('视频页 + 开关开着：画质区有内容，主账号来自实时', () => {
    const s = buildPageSnapshot({
      pageView: pageView(),
      proxy: PROXY_ON,
      account: ACCOUNT,
      cached: null,
    });

    expect(s.page).toEqual({ kind: 'play', pageKey: 'BV1jt421t7XH', p: 1 });
    expect(s.primary.uname).toBe('主账号昵称');
    expect(s.primary.source).toBe('live');
    expect(s.unlock).not.toBeNull();
    expect(s.unlock?.title).toBe('已解锁');
    expect(s.proxy.enabled).toBe(true);
  });

  it('texts.primaryLine = 昵称（有昵称时不写占位）', () => {
    const s = buildPageSnapshot({
      pageView: pageView(),
      proxy: PROXY_ON,
      account: ACCOUNT,
      cached: null,
    });
    expect(s.texts.primaryLine).toBe('主账号昵称');
  });

  it('texts.unlockLine 拼法与 JSX 一致：`标题 · 锚点`', () => {
    const s = buildPageSnapshot({
      pageView: pageView(),
      proxy: PROXY_ON,
      account: ACCOUNT,
      cached: null,
    });
    expect(s.texts.unlockLine).toBe(`${s.unlock?.title} · ${s.unlock?.anchor}`);
    // 锚点必须带上主账号可用画质，那是 §2.3 的核心
    expect(s.texts.unlockLine).toContain('主账号仅可用 1080P');
  });

  it('非播放页：page.kind=other，画质区为 null', () => {
    const s = buildPageSnapshot({
      pageView: null,
      proxy: PROXY_ON,
      account: ACCOUNT,
      cached: null,
    });
    expect(s.page).toEqual({ kind: 'other', pageKey: null, p: null });
    expect(s.unlock).toBeNull();
    expect(s.texts.unlockLine).toBeNull();
  });
});

describe('buildPageSnapshot —— 开关关着（问题 5 的快照侧）', () => {
  it('proxy.enabled=false → unlock 与 unlockLine 都是 null', () => {
    const s = buildPageSnapshot({
      pageView: pageView(),
      proxy: PROXY_OFF,
      account: ACCOUNT,
      cached: null,
    });
    expect(s.unlock).toBeNull();
    expect(s.texts.unlockLine).toBeNull();
  });

  it('开关关着时不会残留「主账号基线未知」那句话', () => {
    const noSsr = pageView({
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
    const s = buildPageSnapshot({
      pageView: noSsr,
      proxy: PROXY_OFF,
      account: ACCOUNT,
      cached: null,
    });
    expect(JSON.stringify(s)).not.toContain('主账号基线未知');
  });
});

describe('buildPageSnapshot —— 主账号占位文案', () => {
  it('播放页 + unknown → 占位是「读取中…」而不是「未登录」', () => {
    const s = buildPageSnapshot({
      pageView: pageView({
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
      }),
      proxy: PROXY_ON,
      account: ACCOUNT,
      cached: null,
    });
    expect(s.primary.placeholder).toBe('读取中…');
    expect(s.texts.primaryLine).not.toBe('未登录');
  });

  it('播放页 + 确认未登录 → 占位是「未登录」，且不读缓存', () => {
    const s = buildPageSnapshot({
      pageView: pageView({
        primary: {
          usable: false,
          reason: 'absent',
          capability: null,
          user: null,
          mid: null,
          loggedIn: 'no',
        },
        playback: null,
        diff: null,
      }),
      proxy: PROXY_ON,
      account: ACCOUNT,
      // 有缓存也**不能**用 —— 那是原纪律真正要防的
      cached: { uname: '上次的昵称', level: 5 },
    });
    expect(s.primary.uname).toBeNull();
    expect(s.primary.placeholder).toBe('未登录');
    expect(s.primary.source).toBe('none');
  });

  it('播放页 + yes 但无昵称（番剧页）+ 有缓存 → 缓存兜底', () => {
    const s = buildPageSnapshot({
      pageView: pageView({
        pageKey: 'ep3854821',
        primary: {
          usable: false,
          reason: 'absent',
          capability: null,
          user: null,
          mid: null,
          loggedIn: 'yes',
        },
        playback: null,
        diff: null,
      }),
      proxy: PROXY_ON,
      account: ACCOUNT,
      cached: { uname: '上次的昵称', level: 5 },
    });
    expect(s.primary.uname).toBe('上次的昵称');
    expect(s.primary.source).toBe('cached');
  });
});

describe('buildPageSnapshot —— 不得携带凭据（AGENTS §5.2）', () => {
  it('序列化后不含任何凭据形态的字符串', () => {
    const s = buildPageSnapshot({
      pageView: pageView(),
      proxy: PROXY_ON,
      account: ACCOUNT,
      cached: { uname: 'x', level: 1 },
    });
    const text = JSON.stringify(s);

    for (const needle of ['SESSDATA', 'sessdata', 'bili_jct', 'biliJct', 'DedeUserID', 'cookie']) {
      expect(text, `快照里出现了 ${needle} —— 任何 *:ok 消息都不得携带凭据`).not.toContain(needle);
    }
  });

  it('账号部分只有 AccountSummary 级字段（mid 是必要标识，不是凭据）', () => {
    const s = buildPageSnapshot({
      pageView: pageView(),
      proxy: PROXY_ON,
      account: ACCOUNT,
      cached: null,
    });
    expect(Object.keys(s.playbackAccount ?? {}).sort()).toEqual([
      'expireAt',
      'healthy',
      'mid',
      'uname',
      'vipLabel',
    ]);
  });
});
