import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyUpdateBadge,
  handleUpdateAuto,
  handleUpdateCheck,
  handleUpdateStatus,
  runStartupUpdateCheck,
  toStatusView,
} from '@/src/background/handlers/update.handler';
import { DEFAULT_UPDATE_STATE, type UpdateState } from '@core/update/state';
import { UPDATE_STATE_KEY } from '@platform/update/state-store';
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

describe('runStartupUpdateCheck', () => {
  it('任何异常都被吞掉（后台行为不许炸 SW）', async () => {
    stubChrome(stateWith({ lastCheckAt: null }));
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    await expect(runStartupUpdateCheck()).resolves.toBeUndefined();
  });
});
