// @vitest-environment jsdom

/**
 * 面板数据层的单测（1.1.0 阶段 2，T1）。
 *
 * ## 这个文件守什么
 *
 * `panel-data.ts` 里的判据全部是**"面板会不会谎报"**那一类：
 *
 * | 场景 | 必须 | 反例（改坏了会怎样） |
 * | --- | --- | --- |
 * | 非播放页 | `unlock === null` | 首页显示「等待取流…」，用户一直等一个不会来的东西 |
 * | 总开关关着 | `unlock === null` | 停用状态却显示画质卡，描述一件不存在的事 |
 * | `proxy/status` 拿不到 | `snapshot === null`，胶囊「未知」 | 编一个「已接管」 |
 * | `account/summary` 拿不到 | `unknown: true` 且**不**说"未配置" | 引导用户去扫一个已经存在的号 |
 * | 只改一个布尔项 | 另外三个原样不变 | 写回时把其余三个重置成缺省值 |
 *
 * 前四条来自 `02-ui-spec.md` §3 与 `summary-view.ts` 里真机踩过的记录。
 * 第五条来自 `ui-prefs-store.ts` 的整块覆盖语义（ADR 0033 决定五）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildPanelModel,
  buildPopupSnapshot,
  buildQualityView,
  describeAdDebugCaveat,
  patchCleanOption,
  toggleHideCategory,
} from '../../../src/content/panel/panel-data';
import {
  DEFAULT_CLEAN_OPTIONS,
  type CleanOptions,
} from '../../../src/content/site-clean/clean-options';
import type { PopupAccount, PopupSnapshot } from '../../../src/core/ui/popup-state';
import type { PrimaryCard } from '../../../src/shared/utils/primary-card';

/** 一个"已接管"的最小快照 */
function snapshot(overrides: Partial<PopupSnapshot> = {}): PopupSnapshot {
  return {
    proxy: { enabled: true, hasCredential: true, ruleCount: 3 },
    configured: true,
    account: {
      uname: '播',
      mid: 2,
      vipLabel: 'annual',
      expireAt: null,
      healthy: true,
      checkedAt: 0,
      reason: null,
    },
    buckets: [],
    page: { kind: 'play' },
    ...overrides,
  };
}

const PRIMARY: PrimaryCard = { uname: '主', level: 6, loggedIn: 'yes', source: 'live' };

/** 一个最小的 `PageTracksView`（只要 `pageKey` 与 `loggedIn` 就能走到 `describeUnlock`） */
function pageView(): Parameters<typeof buildPanelModel>[0]['pageView'] {
  return {
    pageKey: 'BV1xx411c7mD',
    p: 1,
    updatedAt: 0,
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
  };
}

describe('buildQualityView：非播放页不许编数据', () => {
  it('★ 非播放页即使传了解锁卡也必须丢弃（unlock === null）', () => {
    /**
     * `describeUnlock()` 在拿到 view 时会返回非 null —— 所以面板必须自己拦一道。
     * 反例：把 `pageKind === 'play' ? unlock : null` 改成 `unlock` → 本条必红。
     */
    const v = buildQualityView({
      view: { pill: '未生效', tone: 'neutral' },
      unlock: { title: '等待取流…', badges: [], anchor: 'x', improved: false },
      proxyEnabled: true,
      pageKind: 'other',
      pageStateKind: 'ok',
    });
    expect(v.unlock).toBeNull();
    expect(v.pageKind).toBe('other');
  });

  it('非播放页不渲染任何解释文字（line 为 null）', () => {
    /**
     * `02-ui-spec.md` §3 状态 5 的定稿：非视频页**两处都不渲染**。
     * `describePopup()` 对 not-video 已经不返回 line，这里确认面板原样透传、不补文案。
     */
    const v = buildQualityView({
      view: { pill: '未生效', tone: 'neutral' },
      unlock: null,
      proxyEnabled: true,
      pageKind: 'other',
      pageStateKind: 'ok',
    });
    expect(v.line).toBeNull();
    expect(v.pill).toBe('未生效');
  });

  it('播放页正常显示解锁卡', () => {
    const unlock = {
      title: '已解锁',
      badges: ['4K'],
      anchor: '主账号仅可用 1080P',
      improved: true,
    };
    const v = buildQualityView({
      view: { pill: '已接管', tone: 'good' },
      unlock,
      proxyEnabled: true,
      pageKind: 'play',
      pageStateKind: 'ok',
    });
    expect(v.unlock).toEqual(unlock);
  });

  it('拿不到 proxy/status 时胶囊是「未知」，不编一个状态', () => {
    const v = buildQualityView({
      view: null,
      unlock: null,
      proxyEnabled: null,
      pageKind: 'play',
      pageStateKind: 'ok',
    });
    expect(v.pill).toBe('未知');
    expect(v.tone).toBe('neutral');
    expect(v.proxyEnabled).toBeNull();
  });
});

describe('★ 播放页：区分"等数据"与"通道断了"（2026-11-10 真机教训）', () => {
  /**
   * ## 为什么需要这一组
   *
   * 真机排查**猜了两次都没中**，根因是：`not-ready`（内容脚本在、数据还没到）
   * 与 `no-content-script`（通道断了）在 UI 上**完全同形**（都没有解锁卡）。
   *
   * 现在的规矩：
   * | pageStateKind | 播放页表现 |
   * | --- | --- |
   * | `not-ready` | 显示「等待取流…」占位 —— 用户该等一下 |
   * | `no-content-script` / `timeout` | **不摆占位** —— 摆了就是骗用户继续等 |
   * | `ok` 但 unlock 为 null | 不摆占位（开关关着等，由 describeUnlock 决定） |
   *
   * 非播放页**一律**不摆占位（那里本来就没有取流这回事）。
   */

  it('★ not-ready → 显示「等待取流…」占位', () => {
    const v = buildQualityView({
      view: { pill: '已接管', tone: 'good' },
      unlock: null,
      proxyEnabled: true,
      pageKind: 'play',
      pageStateKind: 'not-ready',
    });
    expect(v.unlock).not.toBeNull();
    expect(v.unlock?.title).toBe('等待取流…');
    expect(v.unlock?.badges).toEqual([]);
  });

  it('★ no-content-script → 不摆占位（通道断了不能说"等待中"）', () => {
    const v = buildQualityView({
      view: { pill: '已接管', tone: 'good' },
      unlock: null,
      proxyEnabled: true,
      pageKind: 'play',
      pageStateKind: 'no-content-script',
    });
    expect(v.unlock).toBeNull();
  });

  it('★ timeout → 不摆占位', () => {
    const v = buildQualityView({
      view: null,
      unlock: null,
      proxyEnabled: null,
      pageKind: 'play',
      pageStateKind: 'timeout',
    });
    expect(v.unlock).toBeNull();
  });

  it('非播放页即使 not-ready 也不摆占位（首页没有取流这回事）', () => {
    const v = buildQualityView({
      view: { pill: '未生效', tone: 'neutral' },
      unlock: null,
      proxyEnabled: true,
      pageKind: 'other',
      pageStateKind: 'not-ready',
    });
    expect(v.unlock).toBeNull();
  });

  it('有 unlock 时原样用 unlock，不被占位覆盖', () => {
    const real = { title: '已解锁', badges: ['4K'], anchor: '主账号仅可用 1080P', improved: true };
    const v = buildQualityView({
      view: { pill: '已接管', tone: 'good' },
      unlock: real,
      proxyEnabled: true,
      pageKind: 'play',
      pageStateKind: 'ok',
    });
    expect(v.unlock).toEqual(real);
  });
});

describe('buildPopupSnapshot：缺消息时的降级', () => {
  it('★ 拿不到 proxy/status → snapshot 为 null（而不是编一个默认值）', () => {
    expect(
      buildPopupSnapshot({ proxy: null, account: null, buckets: [], pageKind: 'play' }),
    ).toBeNull();
  });

  it('有凭据就算已配置 —— 即使 account/summary 没回来', () => {
    /**
     * 与 `popup/main.tsx` 同一判据：两个来源任一为真。
     * `hasCredential` 是同步可读的硬证据（密文在不在），不依赖网络探测。
     */
    const s = buildPopupSnapshot({
      proxy: { enabled: true, hasCredential: true, ruleCount: 0 },
      account: null,
      buckets: [],
      pageKind: 'play',
    });
    expect(s?.configured).toBe(true);
  });

  it('没凭据也没 account → 未配置', () => {
    const s = buildPopupSnapshot({
      proxy: { enabled: false, hasCredential: false, ruleCount: 0 },
      account: null,
      buckets: [],
      pageKind: 'other',
    });
    expect(s?.configured).toBe(false);
  });

  it('pageKind 正确映射到 PopupSnapshot.page', () => {
    const play = buildPopupSnapshot({
      proxy: { enabled: true, hasCredential: true, ruleCount: 1 },
      account: null,
      buckets: [],
      pageKind: 'play',
    });
    const other = buildPopupSnapshot({
      proxy: { enabled: true, hasCredential: true, ruleCount: 1 },
      account: null,
      buckets: [],
      pageKind: 'other',
    });
    expect(play?.page.kind).toBe('play');
    expect(other?.page.kind).toBe('other');
  });
});

describe('buildPanelModel：总开关关着时不画锁画质卡', () => {
  it('★ 开关关着 → unlock 为 null（即使有 pageView）', () => {
    /**
     * 这条判据在 `summary-view.ts` 有完整的现场记录：
     * 关掉总开关后仍显示「主账号基线未知（本页没有 SSR 数据）」是在描述一件不存在的事。
     * 反例：把 `snapshot?.proxy.enabled !== false` 改成 `true` → 本条必红。
     */
    const model = buildPanelModel({
      snapshot: snapshot({ proxy: { enabled: false, hasCredential: true, ruleCount: 0 } }),
      pageView: pageView(),
      primary: PRIMARY,
      clean: null,
      pageKind: 'play',
      accountKnown: true,
      pageStateKind: 'ok',
    });
    expect(model.quality.unlock).toBeNull();
    expect(model.quality.proxyEnabled).toBe(false);
    expect(model.quality.pill).toBe('已停用');
  });

  it('开关开着 + 播放页 → unlock 非 null', () => {
    const model = buildPanelModel({
      snapshot: snapshot(),
      pageView: pageView(),
      primary: PRIMARY,
      clean: null,
      pageKind: 'play',
      accountKnown: true,
      pageStateKind: 'ok',
    });
    expect(model.quality.unlock).not.toBeNull();
  });

  it('非播放页整体不画解锁卡', () => {
    const model = buildPanelModel({
      snapshot: snapshot({ page: { kind: 'other' } }),
      pageView: null,
      primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' },
      clean: null,
      pageKind: 'other',
      accountKnown: true,
      pageStateKind: 'ok',
    });
    expect(model.quality.unlock).toBeNull();
    expect(model.quality.pill).toBe('未生效');
  });

  it('★ account 没读到 → unknown 为 true，且不冒充"未配置"', () => {
    const model = buildPanelModel({
      snapshot: snapshot(),
      pageView: null,
      primary: PRIMARY,
      clean: null,
      pageKind: 'other',
      accountKnown: false,
      pageStateKind: 'ok',
    });
    expect(model.account.unknown).toBe(true);
  });

  it('clean 为 null 时原样透传（UI 据此禁用开关，而不是当成全关）', () => {
    const model = buildPanelModel({
      snapshot: snapshot(),
      pageView: null,
      primary: PRIMARY,
      clean: null,
      pageKind: 'other',
      accountKnown: true,
      pageStateKind: 'ok',
    });
    expect(model.clean).toBeNull();
  });

  it('snapshot 为 null 时账户区 unknown 为 true、hasCredential 为 false', () => {
    const model = buildPanelModel({
      snapshot: null,
      pageView: null,
      primary: PRIMARY,
      clean: null,
      pageKind: 'play',
      accountKnown: false,
      pageStateKind: 'ok',
    });
    expect(model.account.unknown).toBe(true);
    expect(model.account.hasCredential).toBe(false);
    expect(model.quality.proxyEnabled).toBeNull();
  });
});

describe('patchCleanOption：只改一个键（读—改—写的"改"）', () => {
  it('★ 只改 adEnabled，另外三个原样不变', () => {
    /**
     * `writeCleanOptionFlags()` 是**整块覆盖**。这条断言钉住"调用方手里必须是完整集合"。
     * 反例：把 `{...current, [key]: next}` 改成 `{[key]: next}` → 本条必红，
     * 表现为另外三个开关在页面上被静默重置成缺省值。
     */
    const current: CleanOptions = {
      adEnabled: false,
      adPreserveEventBanner: true,
      adDebug: true,
      homeHideSwipe: true,
    };
    const next = patchCleanOption(current, 'adEnabled', true);

    expect(next.adEnabled).toBe(true);
    expect(next.adPreserveEventBanner).toBe(true);
    expect(next.adDebug).toBe(true);
    expect(next.homeHideSwipe).toBe(true);
    // 四个键一个都不能少
    expect(Object.keys(next).sort()).toEqual(Object.keys(DEFAULT_CLEAN_OPTIONS).sort());
  });

  it('不修改传入的旧对象（纯函数）', () => {
    const current: CleanOptions = { ...DEFAULT_CLEAN_OPTIONS };
    const before = { ...current };
    patchCleanOption(current, 'adDebug', true);
    expect(current).toEqual(before);
  });
});

describe('describeAdDebugCaveat', () => {
  it('广告开 + 调试开 → 提示"不会隐藏"', () => {
    expect(
      describeAdDebugCaveat({ ...DEFAULT_CLEAN_OPTIONS, adEnabled: true, adDebug: true }),
    ).toBe('调试模式开着：广告不会被隐藏，只会用红框标出。');
  });

  it('调试开但广告关 → 不需要提示（调试模式没意义，但也不误导）', () => {
    expect(
      describeAdDebugCaveat({ ...DEFAULT_CLEAN_OPTIONS, adEnabled: false, adDebug: true }),
    ).toBeNull();
  });

  it('广告开但调试关 → 不需要提示（正常隐藏）', () => {
    expect(
      describeAdDebugCaveat({ ...DEFAULT_CLEAN_OPTIONS, adEnabled: true, adDebug: false }),
    ).toBeNull();
  });
});

describe('toggleHideCategory', () => {
  it('勾选会加入，取消会移除', () => {
    expect(toggleHideCategory([], '番剧', true)).toEqual(['番剧']);
    expect(toggleHideCategory(['番剧', '电影'], '番剧', false)).toEqual(['电影']);
  });

  it('重复勾选不产生重复项', () => {
    expect(toggleHideCategory(['番剧'], '番剧', true)).toEqual(['番剧']);
  });

  it('不修改传入数组', () => {
    const cur = ['番剧'];
    toggleHideCategory(cur, '电影', true);
    expect(cur).toEqual(['番剧']);
  });
});

describe('PopupAccount 形状自检', () => {
  it('本文件用的 account 字面量与 PopupAccount 对齐（防类型漂移）', () => {
    const a: PopupAccount = {
      uname: '播',
      mid: 2,
      vipLabel: 'annual',
      expireAt: null,
      healthy: true,
      checkedAt: 0,
      reason: null,
    };
    expect(a.vipLabel).toBe('annual');
  });
});
