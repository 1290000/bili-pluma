import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UPDATE_STATE,
  isNewerThan,
  isUpdateAvailable,
  normalizeUpdateState,
  resolvePhase,
  shouldPrompt,
  withApplied,
  withAutoCheck,
  withCheckResult,
  withDismissed,
  withFailedCheck,
  withIntervalDays,
  withFailedUpdate,
  withPendingUpdate,
  type UpdateState,
} from '@core/update/state';

const CURRENT = '1.1.0';

function stateWith(over: Partial<UpdateState>): UpdateState {
  return { ...DEFAULT_UPDATE_STATE, ...over };
}

const NEWER = {
  version: '1.2.0',
  zipUrl: 'https://example.invalid/pluma-1.2.0.zip',
  sizeBytes: 289831,
  publishedAt: '2026-11-16T00:00:00Z',
};

describe('normalizeUpdateState：坏数据一律退回默认值', () => {
  it('null / 字符串 / 数字都不炸', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      expect(normalizeUpdateState(raw)).toEqual(DEFAULT_UPDATE_STATE);
    }
  });

  it('字段类型不对时逐个退回，不影响其他字段', () => {
    const state = normalizeUpdateState({
      autoCheckEnabled: 'yes',
      intervalDays: 0,
      lastCheckAt: 'yesterday',
      etag: 12,
      latest: { version: '1.2.0' },
    });
    expect(state.autoCheckEnabled).toBe(true);
    expect(state.intervalDays).toBe(1);
    expect(state.lastCheckAt).toBeNull();
    expect(state.etag).toBeNull();
    expect(state.latest).toBeNull();
  });

  it('合法的部分原样保留', () => {
    const state = normalizeUpdateState({
      autoCheckEnabled: false,
      intervalDays: 3,
      lastCheckAt: 1000,
      latest: NEWER,
      pendingUpdate: { from: '1.1.0', to: '1.2.0', at: 2000 },
    });
    expect(state.autoCheckEnabled).toBe(false);
    expect(state.intervalDays).toBe(3);
    expect(state.lastCheckAt).toBe(1000);
    expect(state.latest?.version).toBe('1.2.0');
    expect(state.pendingUpdate?.to).toBe('1.2.0');
  });
});

describe('isUpdateAvailable', () => {
  it('没有 latest ⇒ false', () => {
    expect(isUpdateAvailable(DEFAULT_UPDATE_STATE, CURRENT)).toBe(false);
  });

  it('latest 更新 ⇒ true', () => {
    expect(isUpdateAvailable(stateWith({ latest: NEWER }), CURRENT)).toBe(true);
  });

  it('latest 同版本 ⇒ false', () => {
    expect(isUpdateAvailable(stateWith({ latest: { ...NEWER, version: CURRENT } }), CURRENT)).toBe(
      false,
    );
  });

  it('latest 版本号是垃圾 ⇒ false，而不是抛错把面板搞崩', () => {
    expect(
      isUpdateAvailable(stateWith({ latest: { ...NEWER, version: 'garbage' } }), CURRENT),
    ).toBe(false);
  });
});

describe('isNewerThan：全仓唯一判据（字符串不等 ≠ 更新）', () => {
  /**
   * ## 这条就是 2026-11-17 真机 bug 的最小复现
   *
   * 用户装了 1.2.0 的包、线上最新还是 1.1.0。旧代码 `latest !== currentVersion`
   * 是 `'1.1.0' !== '1.2.0'` ⇒ true ⇒ 面板卡头挂「有新版本」，
   * 而按钮用 `phase`（走 `isNewer`）算出来是 `idle` ⇒ 禁用。**同一个面板自相矛盾。**
   * 更新窗口那两处更严重：会让「立即更新」可点 ⇒ **允许降级安装**。
   */
  it('★★★ 线上 1.1.0 / 本地 1.2.0 ⇒ false（本地更新，不是"有新版本"）', () => {
    expect(isNewerThan('1.1.0', '1.2.0')).toBe(false);
  });

  it('线上 1.2.0 / 本地 1.1.0 ⇒ true', () => {
    expect(isNewerThan('1.2.0', '1.1.0')).toBe(true);
  });

  it('同版本 ⇒ false', () => {
    expect(isNewerThan('1.2.0', '1.2.0')).toBe(false);
  });

  it('没查到最新版（null）⇒ false，且不抛', () => {
    expect(isNewerThan(null, '1.2.0')).toBe(false);
  });

  it('★ 版本号解析不了 ⇒ false（解析失败必须被吞掉，不许炸到调用方 UI）', () => {
    expect(() => isNewerThan('abc', '1.2.0')).not.toThrow();
    expect(isNewerThan('abc', '1.2.0')).toBe(false);
    expect(isNewerThan('1.2.0', 'abc')).toBe(false);
  });

  it('多段版本按数字比，不是按字符串比', () => {
    // 字典序会认为 '1.10.0' < '1.9.0'，数字序才是对的
    expect(isNewerThan('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerThan('1.9.0', '1.10.0')).toBe(false);
  });
});

describe('shouldPrompt：dismissed 只压提示，不改变"有更新"', () => {
  it('没关过 ⇒ 提示', () => {
    expect(shouldPrompt(stateWith({ latest: NEWER }), CURRENT)).toBe(true);
  });

  it('关掉过这一版 ⇒ 不提示，但仍然"有更新"', () => {
    const state = stateWith({ latest: NEWER, dismissedVersion: '1.2.0' });
    expect(shouldPrompt(state, CURRENT)).toBe(false);
    expect(isUpdateAvailable(state, CURRENT)).toBe(true);
  });

  it('出了下一版 ⇒ 重新提示', () => {
    const state = stateWith({ latest: { ...NEWER, version: '1.3.0' }, dismissedVersion: '1.2.0' });
    expect(shouldPrompt(state, CURRENT)).toBe(true);
  });
});

describe('状态转换', () => {
  it('withAutoCheck 不清 lastCheckAt（重新打开开关后能立刻补查）', () => {
    const state = withAutoCheck(stateWith({ lastCheckAt: 12345 }), false);
    expect(state.autoCheckEnabled).toBe(false);
    expect(state.lastCheckAt).toBe(12345);
    expect(withAutoCheck(state, true).lastCheckAt).toBe(12345);
  });

  it('withCheckResult 记下时间、ETag 与最新版', () => {
    const state = withCheckResult(DEFAULT_UPDATE_STATE, {
      at: 999,
      etag: 'W/"abc"',
      latest: NEWER,
    });
    expect(state.lastCheckAt).toBe(999);
    expect(state.etag).toBe('W/"abc"');
    expect(state.latest?.version).toBe('1.2.0');
  });

  it('自动检查失败 ⇒ 状态原封不动（下次加载还得重试）', () => {
    const before = stateWith({ lastCheckAt: 111 });
    expect(withFailedCheck(before, 999, false)).toEqual(before);
  });

  it('手动检查失败 ⇒ 只记手动冷却', () => {
    const state = withFailedCheck(stateWith({ lastCheckAt: 111 }), 999, true);
    expect(state.lastManualCheckAt).toBe(999);
    expect(state.lastCheckAt).toBe(111);
  });

  it('withDismissed 只动 dismissedVersion', () => {
    const state = withDismissed(stateWith({ latest: NEWER }), '1.2.0');
    expect(state.dismissedVersion).toBe('1.2.0');
    expect(state.latest?.version).toBe('1.2.0');
  });

  it('withIntervalDays 把非法值夹到 1', () => {
    expect(withIntervalDays(DEFAULT_UPDATE_STATE, 0).intervalDays).toBe(1);
    expect(withIntervalDays(DEFAULT_UPDATE_STATE, -5).intervalDays).toBe(1);
    expect(withIntervalDays(DEFAULT_UPDATE_STATE, 3.7).intervalDays).toBe(3);
  });

  it('withApplied 清掉 pendingUpdate 并记下版本', () => {
    const pending = withPendingUpdate(DEFAULT_UPDATE_STATE, { from: '1.1.0', to: '1.2.0', at: 1 });
    const applied = withApplied(pending, '1.2.0');
    expect(applied.pendingUpdate).toBeNull();
    expect(applied.lastAppliedVersion).toBe('1.2.0');
  });
});

describe('resolvePhase', () => {
  it('有 pendingUpdate 优先报 pending-reload', () => {
    const state = stateWith({
      latest: NEWER,
      pendingUpdate: { from: '1.1.0', to: '1.2.0', at: 1 },
    });
    expect(resolvePhase(state, CURRENT)).toBe('pending-reload');
  });

  it('无更新 ⇒ idle', () => {
    expect(resolvePhase(DEFAULT_UPDATE_STATE, CURRENT)).toBe('idle');
  });

  it('有更新但关过提示 ⇒ dismissed', () => {
    const state = stateWith({ latest: NEWER, dismissedVersion: '1.2.0' });
    expect(resolvePhase(state, CURRENT)).toBe('dismissed');
  });

  it('有更新 ⇒ available', () => {
    expect(resolvePhase(stateWith({ latest: NEWER }), CURRENT)).toBe('available');
  });
});

describe('关掉提示（withDismissed）的整条链路', () => {
  it('dismiss 当前这一版 ⇒ 不再提示，phase 变 dismissed', () => {
    const before = stateWith({ latest: NEWER });
    expect(shouldPrompt(before, CURRENT)).toBe(true);
    expect(resolvePhase(before, CURRENT)).toBe('available');

    const after = withDismissed(before, NEWER.version);
    expect(shouldPrompt(after, CURRENT)).toBe(false);
    expect(resolvePhase(after, CURRENT)).toBe('dismissed');
    // 关键：**"有更新"这个事实没变** —— 版本行与「立即更新」都靠它
    expect(isUpdateAvailable(after, CURRENT)).toBe(true);
  });

  it('下一个版本重新提示（dismissedVersion 只压那一版）', () => {
    const dismissed = withDismissed(stateWith({ latest: NEWER }), NEWER.version);
    const nextRelease = { ...NEWER, version: '1.3.0' };

    const after = withCheckResult(dismissed, { at: 1000, etag: null, latest: nextRelease });
    expect(shouldPrompt(after, CURRENT)).toBe(true);
    expect(resolvePhase(after, CURRENT)).toBe('available');
  });

  it('dismiss 不会顺手把 latest 清掉（否则"已是最新"就是谎报）', () => {
    const after = withDismissed(stateWith({ latest: NEWER }), NEWER.version);
    expect(after.latest?.version).toBe(NEWER.version);
  });
});

describe('更新后自检的两种结局（Step 6）', () => {
  it('成功：withApplied 同时清掉 pendingUpdate 与失败记录', () => {
    const before = withPendingUpdate(
      withFailedUpdate(DEFAULT_UPDATE_STATE, { to: '1.0.0', at: 1 }),
      { from: '1.1.0', to: '1.2.0', at: 2 },
    );
    const after = withApplied(before, '1.2.0');
    expect(after.pendingUpdate).toBeNull();
    expect(after.lastFailedUpdate).toBeNull();
    expect(after.lastAppliedVersion).toBe('1.2.0');
  });

  it('失败：清掉 pendingUpdate 但**留下**失败记录（不许静默）', () => {
    const before = withPendingUpdate(DEFAULT_UPDATE_STATE, { from: '1.1.0', to: '1.2.0', at: 2 });
    const after = withFailedUpdate(before, { to: '1.2.0', at: 2 });
    expect(after.pendingUpdate).toBeNull();
    expect(after.lastFailedUpdate).toEqual({ to: '1.2.0', at: 2 });
  });

  it('坏数据里的 lastFailedUpdate 被归一化掉', () => {
    expect(normalizeUpdateState({ lastFailedUpdate: { at: 1 } }).lastFailedUpdate).toBeNull();
    expect(normalizeUpdateState({ lastFailedUpdate: 'x' }).lastFailedUpdate).toBeNull();
    expect(
      normalizeUpdateState({ lastFailedUpdate: { to: '1.2.0', at: 5 } }).lastFailedUpdate,
    ).toEqual({
      to: '1.2.0',
      at: 5,
    });
  });
});
