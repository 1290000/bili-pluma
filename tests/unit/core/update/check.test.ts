import { describe, expect, it, vi } from 'vitest';

import { releaseIsNewer, runCheck, type ReleaseSource } from '@core/update/check';
import { DEFAULT_UPDATE_STATE, type UpdateState } from '@core/update/state';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;
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

/** 端口桩：记录被调用次数与传入的 etag。 */
function stubSource(result: Awaited<ReturnType<ReleaseSource['latest']>> | Error): {
  source: ReleaseSource;
  calls: Array<string | null>;
} {
  const calls: Array<string | null> = [];
  const source: ReleaseSource = {
    latest: (etag) => {
      calls.push(etag);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return { source, calls };
}

function run(
  over: Partial<UpdateState>,
  result: Awaited<ReturnType<ReleaseSource['latest']>> | Error,
  extras: { manual?: boolean; now?: number } = {},
) {
  const { source, calls } = stubSource(result);
  return {
    calls,
    promise: runCheck({
      state: stateWith(over),
      currentVersion: CURRENT,
      now: extras.now ?? T0,
      manual: extras.manual ?? false,
      manualCooldownMs: 60_000,
      source,
    }),
  };
}

describe('runCheck：闸门在请求之前', () => {
  it('自动开关关掉 ⇒ 一次请求都不发（把闸门挪到请求之后，这条会红）', async () => {
    const { calls, promise } = run(
      { autoCheckEnabled: false, lastCheckAt: T0 - 30 * DAY },
      { kind: 'ok', release: RELEASE, etag: 'e' },
    );
    const result = await promise;
    expect(result.outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('间隔没到 ⇒ 不发请求', async () => {
    const { calls, promise } = run(
      { lastCheckAt: T0 - 1000 },
      { kind: 'ok', release: RELEASE, etag: 'e' },
    );
    expect((await promise).outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('手动检查不受自动开关影响（关掉自动也能手动）', async () => {
    const { calls, promise } = run(
      { autoCheckEnabled: false },
      { kind: 'ok', release: RELEASE, etag: 'e' },
      { manual: true },
    );
    expect((await promise).outcome).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('手动检查冷却中 ⇒ 不发请求', async () => {
    const { calls, promise } = run(
      { lastManualCheckAt: T0 - 1000 },
      { kind: 'ok', release: RELEASE, etag: 'e' },
      { manual: true },
    );
    expect((await promise).outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('条件请求带上了上次的 ETag', async () => {
    const { calls, promise } = run({ etag: 'W/"1"' }, { kind: 'not-modified', etag: 'W/"1"' });
    await promise;
    expect(calls).toEqual(['W/"1"']);
  });
});

describe('runCheck：结果到状态的映射', () => {
  it('200 ⇒ lastCheckAt 与 latest 都更新', async () => {
    const { promise } = run({}, { kind: 'ok', release: RELEASE, etag: 'W/"2"' });
    const { state, outcome } = await promise;
    expect(outcome).toBe('ok');
    expect(state.lastCheckAt).toBe(T0);
    expect(state.etag).toBe('W/"2"');
    expect(state.latest?.version).toBe('1.2.0');
  });

  it('304 ⇒ 时间推进但 latest 保留（否则每次打开都查）', async () => {
    const before = stateWith({ latest: RELEASE, etag: 'W/"1"' });
    const { source } = stubSource({ kind: 'not-modified', etag: 'W/"1"' });
    const { state } = await runCheck({
      state: before,
      currentVersion: CURRENT,
      now: T0,
      manual: false,
      manualCooldownMs: 60_000,
      source,
    });
    expect(state.lastCheckAt).toBe(T0);
    expect(state.latest?.version).toBe('1.2.0');
  });

  it('限流 ⇒ lastCheckAt 不动、latest 不动（不许写成"无新版本"）', async () => {
    const before = stateWith({ lastCheckAt: T0 - 5 * DAY, latest: RELEASE });
    const { source } = stubSource({ kind: 'rate-limited', resetAt: T0 + DAY });
    const { state, outcome } = await runCheck({
      state: before,
      currentVersion: CURRENT,
      now: T0,
      manual: false,
      manualCooldownMs: 60_000,
      source,
    });
    expect(outcome).toBe('rate-limited');
    expect(state.lastCheckAt).toBe(T0 - 5 * DAY);
    expect(state.latest?.version).toBe('1.2.0');
  });

  it('网络失败 ⇒ lastCheckAt 不动，reason 有内容', async () => {
    const { promise } = run(
      { lastCheckAt: T0 - 5 * DAY },
      { kind: 'error', message: 'TypeError: fetch failed' },
    );
    const { state, outcome, reason } = await promise;
    expect(outcome).toBe('failed');
    expect(state.lastCheckAt).toBe(T0 - 5 * DAY);
    expect(reason).toContain('fetch failed');
  });

  it('端口意外抛异常 ⇒ 变成 failed，不外溢', async () => {
    const { promise } = run({}, new Error('boom'));
    const { outcome, reason } = await promise;
    expect(outcome).toBe('failed');
    expect(reason).toBe('boom');
  });

  it('手动检查成功也会记冷却时间', async () => {
    const { promise } = run({}, { kind: 'ok', release: RELEASE, etag: null }, { manual: true });
    const { state } = await promise;
    expect(state.lastManualCheckAt).toBe(T0);
  });
});

describe('releaseIsNewer', () => {
  it('null ⇒ false', () => {
    expect(releaseIsNewer(null, CURRENT)).toBe(false);
  });

  it('同版本 ⇒ false', () => {
    expect(releaseIsNewer({ ...RELEASE, version: CURRENT }, CURRENT)).toBe(false);
  });

  it('新版本 ⇒ true', () => {
    expect(releaseIsNewer(RELEASE, CURRENT)).toBe(true);
  });

  it('垃圾版本号 ⇒ false，不抛', () => {
    expect(releaseIsNewer({ ...RELEASE, version: 'garbage' }, CURRENT)).toBe(false);
  });
});

describe('runCheck 与 vi.fn 的配合（防止桩被误用）', () => {
  it('source.latest 每次检查只调一次', async () => {
    const latest = vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, release: RELEASE, etag: null }),
    );
    await runCheck({
      state: DEFAULT_UPDATE_STATE,
      currentVersion: CURRENT,
      now: T0,
      manual: false,
      manualCooldownMs: 60_000,
      source: { latest },
    });
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
