import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyUpdateBadge,
  handleUpdateAuto,
  handleUpdateCheck,
  checkPendingUpdate,
  handleUpdateDismiss,
  handleUpdateStatus,
  handleUpdateReload,
  runStartupUpdateCheck,
} from '@/src/background/handlers/update.handler';
// 2026-11-17 起 `toStatusView` 在 core（与 `resolvePhase` 相邻），不在 handler 里
import { DEFAULT_UPDATE_STATE, toStatusView, type UpdateState } from '@core/update/state';
import { UPDATE_STATE_KEY } from '@platform/update/state-store';
import { UPDATE_RELOAD_DELAY_MS } from '@shared/constants/update';
import type { ReleaseSource } from '@core/update/check';

const CURRENT = '1.1.0';

const RELEASE = {
  version: '1.2.0',
  zipUrl: 'https://github.com/o/r/releases/download/v1.2.0/pluma-1.2.0.zip',
  sizeBytes: 289_831,
  publishedAt: '2026-11-16T00:00:00Z',
};

function stateWith(over: Partial<UpdateState>): UpdateState {
  return { ...DEFAULT_UPDATE_STATE, ...over };
}

interface Harness {
  store: Map<string, unknown>;
  setCalls: Array<Record<string, unknown>>;
  badge: string[];
}

function stubChrome(initial: UpdateState | null): Harness {
  const store = new Map<string, unknown>();
  if (initial) store.set(UPDATE_STATE_KEY, initial);
  const setCalls: Array<Record<string, unknown>> = [];
  const badge: string[] = [];

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
        set: (obj: Record<string, unknown>) => {
          setCalls.push(obj);
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
          return Promise.resolve();
        },
      },
    },
    action: {
      setBadgeText: (args: { text: string }) => {
        badge.push(args.text);
        return Promise.resolve();
      },
    },
    runtime: { getManifest: () => ({ version: CURRENT }) },
  });

  return { store, setCalls, badge };
}

function stubSource(result: Awaited<ReturnType<ReleaseSource['latest']>>): ReleaseSource {
  return { latest: () => Promise.resolve(result) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toStatusView', () => {
  it('没有 latest ⇒ idle，latest 字段为 null', () => {
    const view = toStatusView(DEFAULT_UPDATE_STATE, CURRENT);
    expect(view.phase).toBe('idle');
    expect(view.latestVersion).toBeNull();
    expect(view.latestSizeBytes).toBeNull();
  });

  it('有新版 ⇒ available，并带体积给文案用', () => {
    const view = toStatusView(stateWith({ latest: RELEASE }), CURRENT);
    expect(view.phase).toBe('available');
    expect(view.latestVersion).toBe('1.2.0');
    expect(view.latestSizeBytes).toBe(289_831);
  });

  it('关过提示 ⇒ dismissed（但 latestVersion 还在）', () => {
    const view = toStatusView(stateWith({ latest: RELEASE, dismissedVersion: '1.2.0' }), CURRENT);
    expect(view.phase).toBe('dismissed');
    expect(view.latestVersion).toBe('1.2.0');
  });
});

describe('applyUpdateBadge', () => {
  it('有新版本 ⇒ 角标 "•"', async () => {
    const h = stubChrome(null);
    await applyUpdateBadge(stateWith({ latest: RELEASE }), CURRENT);
    expect(h.badge).toEqual(['•']);
  });

  it('没有新版本 ⇒ 清空', async () => {
    const h = stubChrome(null);
    await applyUpdateBadge(DEFAULT_UPDATE_STATE, CURRENT);
    expect(h.badge).toEqual(['']);
  });

  it('用户关过这一版 ⇒ 清空（不许再骚扰）', async () => {
    const h = stubChrome(null);
    await applyUpdateBadge(stateWith({ latest: RELEASE, dismissedVersion: '1.2.0' }), CURRENT);
    expect(h.badge).toEqual(['']);
  });
});

describe('handleUpdateStatus', () => {
  it('从 storage 读并归一化（坏数据不会炸）', async () => {
    stubChrome(null).store.set(UPDATE_STATE_KEY, { autoCheckEnabled: 'nope', latest: null });
    const reply = await handleUpdateStatus();
    expect(reply.type).toBe('update/status:ok');
    expect(reply.status.currentVersion).toBe(CURRENT);
    expect(reply.status.autoCheckEnabled).toBe(true);
  });
});

describe('handleUpdateCheck', () => {
  it('自动检查闸门没到 ⇒ skipped，且不写状态', async () => {
    const h = stubChrome(stateWith({ lastCheckAt: Date.now() }));
    const reply = await handleUpdateCheck(
      false,
      stubSource({ kind: 'ok', release: RELEASE, etag: 'e' }),
    );
    expect(reply.outcome).toBe('skipped');
    expect(h.setCalls).toHaveLength(0);
  });

  it('检查成功 ⇒ 写入状态 + 角标亮起', async () => {
    const h = stubChrome(stateWith({ lastCheckAt: null }));
    const reply = await handleUpdateCheck(
      false,
      stubSource({ kind: 'ok', release: RELEASE, etag: 'e' }),
    );
    expect(reply.outcome).toBe('ok');
    expect(reply.status.latestVersion).toBe('1.2.0');
    expect(h.setCalls).toHaveLength(1);
    expect(h.badge).toEqual(['•']);
  });

  it('304 ⇒ unchanged，lastCheckAt 推进', async () => {
    const before = stateWith({ lastCheckAt: null, latest: RELEASE });
    const h = stubChrome(before);
    const reply = await handleUpdateCheck(false, stubSource({ kind: 'not-modified', etag: 'e' }));
    expect(reply.outcome).toBe('unchanged');
    const written = h.store.get(UPDATE_STATE_KEY) as UpdateState;
    expect(written.lastCheckAt).not.toBeNull();
  });

  it('限流 ⇒ rate-limited 且 reason 说清什么时候能重试；状态不写', async () => {
    const h = stubChrome(stateWith({ lastCheckAt: null }));
    const reply = await handleUpdateCheck(
      false,
      stubSource({ kind: 'rate-limited', resetAt: Date.UTC(2026, 10, 16, 1, 0, 0) }),
    );
    expect(reply.outcome).toBe('rate-limited');
    expect(reply.reason).toContain('限流');
    expect(h.setCalls).toHaveLength(0);
  });

  it('失败 ⇒ reason 透传原始原因（不许吞成"检查失败"）', async () => {
    stubChrome(stateWith({ lastCheckAt: null }));
    const reply = await handleUpdateCheck(
      false,
      stubSource({ kind: 'error', message: 'HTTP 500' }),
    );
    expect(reply.outcome).toBe('failed');
    expect(reply.reason).toBe('HTTP 500');
  });
});

describe('handleUpdateAuto', () => {
  it('关掉 ⇒ 持久化 false，且不动 lastCheckAt', async () => {
    const h = stubChrome(stateWith({ lastCheckAt: 12345 }));
    const reply = await handleUpdateAuto(false);
    expect(reply.status.autoCheckEnabled).toBe(false);
    const written = h.store.get(UPDATE_STATE_KEY) as UpdateState;
    expect(written.autoCheckEnabled).toBe(false);
    expect(written.lastCheckAt).toBe(12345);
  });
});

describe('handleUpdateDismiss：打开「关于」Tab 即视为已读', () => {
  it('有新版 ⇒ 落盘 dismissedVersion，并**顺手消掉工具栏角标**', async () => {
    const h = stubChrome(stateWith({ latest: RELEASE }));
    const reply = await handleUpdateDismiss();

    expect(reply.type).toBe('update/dismiss:ok');
    expect(reply.status.phase).toBe('dismissed');
    // 版本行仍然要有最新版 —— dismiss 只压提示
    expect(reply.status.latestVersion).toBe('1.2.0');

    const written = h.store.get(UPDATE_STATE_KEY) as UpdateState;
    expect(written.dismissedVersion).toBe('1.2.0');

    // ⚠️ 漏掉 applyUpdateBadge 的话，Tab 红点没了但工具栏还亮着，且再也没有入口能消掉
    expect(h.badge).toEqual(['']);
  });

  it('没有 latest ⇒ 一个 version 都不许写（不许凭空记"关过了"）', async () => {
    const h = stubChrome(null);
    const reply = await handleUpdateDismiss();

    expect(reply.type).toBe('update/dismiss:ok');
    expect(reply.status.phase).toBe('idle');
    expect(h.setCalls).toHaveLength(0);
    expect(h.store.has(UPDATE_STATE_KEY)).toBe(false);
  });

  it('latest 与当前版本相同（本机已是最新）⇒ 落盘一次，记的是当前版本，不会误挡下一版', async () => {
    const h = stubChrome(stateWith({ latest: { ...RELEASE, version: CURRENT } }));
    const reply = await handleUpdateDismiss();
    expect(reply.status.phase).toBe('idle');
    // latest 存在，所以会写一次；但写进去的 dismissedVersion 是"当前这一版"，
    // 不该让下一版的红点失效
    const written = h.store.get(UPDATE_STATE_KEY) as UpdateState;
    expect(written.dismissedVersion).toBe(CURRENT);
    expect(written.dismissedVersion).not.toBe(RELEASE.version);
  });

  it('幂等：这一版已经记过 ⇒ 不写盘，但**仍补一次消角标**', async () => {
    const h = stubChrome(stateWith({ latest: RELEASE, dismissedVersion: '1.2.0' }));
    const reply = await handleUpdateDismiss();

    expect(reply.type).toBe('update/dismiss:ok');
    expect(reply.status.phase).toBe('dismissed');
    expect(h.setCalls, '已经记过这一版还写盘，白推一次 storage.onChanged').toHaveLength(0);
    /**
     * ⚠️ 断言是 `['']` 而**不是** `[]`（2026-11-17 三轮）。
     *
     * 角标是幂等 set，早退可以跳写盘，**不能**跳 `applyUpdateBadge`：
     * 上一次 `setBadgeText` 可能自己失败过（内部 catch，SW 刚醒拿不到 action），
     * 那时 dismissedVersion 已落盘 —— 若这里也跳过，`•` 就永远消不掉，
     * 而用户唯一的消除入口就是这条消息。
     */
    expect(h.badge, '早退把消角标一起跳了 —— 上一次失败的 setBadgeText 再也没人补').toEqual(['']);
  });

  it('dismiss 之后换一个更新的版本 ⇒ phase 回到 available（下一版要重新提示）', async () => {
    stubChrome(stateWith({ latest: RELEASE, dismissedVersion: '1.2.0' }));
    const reply = await handleUpdateStatus();
    expect(reply.status.phase).toBe('dismissed');

    stubChrome(stateWith({ latest: { ...RELEASE, version: '1.3.0' }, dismissedVersion: '1.2.0' }));
    const next = await handleUpdateStatus();
    expect(next.status.phase).toBe('available');
  });
});

describe('handleUpdateReload：关窗 → reload（顺序不能反）', () => {
  /**
   * ## 这条对应 2026-11-17 的第二个真机 bug
   *
   * 更新页写完文件后自己调 `chrome.runtime.reload()`：页面被销毁、**没人关窗**，
   * Chrome 把那个 440×600 的 popup 填成**空白新标签页**。用户既看不到"更新好了"，
   * 窗口也不消失。
   *
   * 所以收尾移到 SW：先 `windows.remove`，再延后 150ms `runtime.reload`。
   * 这里钉住三件事：①关的是 update.html 所在窗口 ②reload 确实发生
   * ③**reload 必须晚于关窗**（延后一拍）。
   */
  interface ReloadHarness {
    removed: number[];
    reloaded: () => number;
    queries: Array<Record<string, unknown>>;
  }

  function stubForReload(tabs: Array<{ windowId?: number | undefined }>): ReloadHarness {
    const removed: number[] = [];
    const queries: Array<Record<string, unknown>> = [];
    let reloadCount = 0;

    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        reload: () => {
          reloadCount += 1;
        },
        getManifest: () => ({ version: CURRENT }),
      },
      tabs: {
        query: (q: Record<string, unknown>) => {
          queries.push(q);
          return Promise.resolve(tabs);
        },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        remove: (id: number) => {
          removed.push(id);
          return Promise.resolve();
        },
      },
    });

    return { removed, reloaded: () => reloadCount, queries };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('★★ 关掉 update.html 所在的两个窗口，然后 reload（reload 必须延后）', async () => {
    vi.useFakeTimers();
    const h = stubForReload([{ windowId: 7 }, { windowId: 9 }]);

    const reply = await handleUpdateReload();

    expect(reply.type).toBe('update/reload:ok');
    // 用 URL 现查窗口，而不是记 windowId —— 窗口可能开很久，SW 这期间重启过
    expect(h.queries[0]).toEqual({ url: 'chrome-extension://test/update.html' });
    expect(h.removed, '关窗是收尾的一半，漏掉就是那个空白新标签页').toEqual([7, 9]);
    expect(h.reloaded(), 'reload 不能早于关窗生效 —— 窗口会被剩成空白页').toBe(0);

    vi.advanceTimersByTime(UPDATE_RELOAD_DELAY_MS);
    expect(h.reloaded()).toBe(1);
  });

  it('★ 两个标签在同一个窗口：只关那个窗口（重复调也不出错）', async () => {
    vi.useFakeTimers();
    const h = stubForReload([{ windowId: 7 }, { windowId: 7 }]);

    await handleUpdateReload();
    vi.advanceTimersByTime(UPDATE_RELOAD_DELAY_MS);

    expect(new Set(h.removed)).toEqual(new Set([7]));
    expect(h.reloaded()).toBe(1);
  });

  it('★ 没有 update.html 标签时也不许抛，reload 照常发生', async () => {
    vi.useFakeTimers();
    const h = stubForReload([]);

    await expect(handleUpdateReload()).resolves.toEqual({ type: 'update/reload:ok' });
    expect(h.removed).toEqual([]);

    vi.advanceTimersByTime(UPDATE_RELOAD_DELAY_MS);
    expect(h.reloaded()).toBe(1);
  });

  it('★ windowId 缺失 / 为 WINDOW_ID_NONE 时**不许**调 windows.remove（-1 不是窗口）', async () => {
    vi.useFakeTimers();
    const h = stubForReload([{ windowId: undefined }, { windowId: -1 }, { windowId: 5 }]);

    await handleUpdateReload();
    vi.advanceTimersByTime(UPDATE_RELOAD_DELAY_MS);

    expect(h.removed).toEqual([5]);
    expect(h.reloaded()).toBe(1);
  });

  it('★ 关窗失败也要继续 reload（关不掉比重载不了轻）', async () => {
    vi.useFakeTimers();
    let reloadCount = 0;
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        reload: () => {
          reloadCount += 1;
        },
        getManifest: () => ({ version: CURRENT }),
      },
      tabs: { query: () => Promise.resolve([{ windowId: 7 }]) },
      windows: {
        WINDOW_ID_NONE: -1,
        remove: () => Promise.reject(new Error('no such window')),
      },
    });

    await expect(handleUpdateReload()).resolves.toEqual({ type: 'update/reload:ok' });
    vi.advanceTimersByTime(UPDATE_RELOAD_DELAY_MS);
    expect(reloadCount).toBe(1);
  });
});

describe('runStartupUpdateCheck', () => {
  it('任何异常都被吞掉（后台行为不许炸 SW）', async () => {
    stubChrome(stateWith({ lastCheckAt: null }));
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    await expect(runStartupUpdateCheck()).resolves.toBeUndefined();
  });
});

describe('checkPendingUpdate：唯一能判定"目录选错了"的地方', () => {
  it('没有 pending ⇒ 什么都不做（不写状态）', async () => {
    const h = stubChrome(DEFAULT_UPDATE_STATE);
    await checkPendingUpdate();
    expect(h.setCalls).toHaveLength(0);
  });

  it('reload 后版本等于目标 ⇒ 记为已生效', async () => {
    const h = stubChrome(stateWith({ pendingUpdate: { from: '1.0.0', to: CURRENT, at: 111 } }));
    await checkPendingUpdate();
    const written = h.store.get(UPDATE_STATE_KEY) as UpdateState;
    expect(written.pendingUpdate).toBeNull();
    expect(written.lastAppliedVersion).toBe(CURRENT);
  });

  it('reload 后版本还是旧的 ⇒ 记为失败（多半选错目录）', async () => {
    const h = stubChrome(stateWith({ pendingUpdate: { from: CURRENT, to: '1.2.0', at: 111 } }));
    await checkPendingUpdate();
    const written = h.store.get(UPDATE_STATE_KEY) as UpdateState;
    expect(written.pendingUpdate).toBeNull();
    expect(written.lastFailedUpdate?.to).toBe('1.2.0');
    // 不许记成"已生效"
    expect(written.lastAppliedVersion).toBeNull();
  });

  it('失败信息会出现在面板视图里', async () => {
    stubChrome(stateWith({ lastFailedUpdate: { to: '1.2.0', at: 1 } }));
    const reply = await handleUpdateStatus();
    expect(reply.status.lastFailedVersion).toBe('1.2.0');
  });
});
