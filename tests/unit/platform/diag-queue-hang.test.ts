// @vitest-environment jsdom

/**
 * `diag()` / `trace()` 的**队列不悬挂**保证（2026-11-10，T5）。
 *
 * ## 修的是什么
 *
 * 原来两个函数**共用同一个模块级 Promise 链** `pending`：
 *
 * ```ts
 * let pending: Promise<void> = Promise.resolve();
 * export function diag(...)  { pending = pending.then(...); return pending; }
 * export function trace(...) { pending = pending.then(...); return pending; }
 * ```
 *
 * 只要链上**任何一次** `chrome.storage.local.get/set` 卡住，
 * 整条链就**永久悬挂**，之后所有 `diag()` / `trace()` 都返回那个卡住的 Promise。
 *
 * 后果：**诊断功能整体失效且无感知**（调用方全是 `void`，看起来一切正常），
 * 而且会让后续排查**全部误判** —— "日志里没有"被读成"代码没执行"。
 *
 * ## 本文件守什么
 *
 * | 判据 | 反例 |
 * | --- | --- |
 * | 一次写入卡住 → 后续写入**仍能完成** | 共用链 → 永久堵死 |
 * | `diag` 卡住不影响 `trace`（反之亦然） | 共用链 → 互相牵连 |
 * | 超时后链继续（不抛错） | 超时抛错 → 后续全红 |
 * | 语义不变：30 条环形、时间正序 | 改坏缓存逻辑 |
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DIAG_KEY,
  DIAG_LIMIT,
  WRITE_TIMEOUT_MS,
  diag,
  readDiag,
  trace,
  readDiagTrace,
} from '../../../src/platform/storage/diag-store';

/** 永不 resolve 的 storage */
function installHangingStorage(): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: () => new Promise<Record<string, unknown>>(() => undefined),
        set: () => new Promise<void>(() => undefined),
      },
    },
  });
}

/** 正常的内存 storage */
function installWorkingStorage(): { bag: Record<string, unknown> } {
  const bag: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: bag[key] })),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(bag, patch);
        }),
      },
    },
  });
  return { bag };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('★★ 一次卡住不会永久悬挂', () => {
  it('★★ storage 永不 resolve 时，diag() 仍会在超时后 settle', async () => {
    /**
     * 反例：去掉 `withTimeout()` → 这个 promise 永远不 settle → 测试超时失败。
     *
     * 这正是原来那个结构性问题：一次卡住，之后所有 `diag()` 都返回卡住的 Promise。
     */
    installHangingStorage();
    vi.useFakeTimers();

    const p = diag('test', 'x');
    // 推进超过超时时间
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + 10);

    await expect(p).resolves.toBeUndefined();
  });

  it('★★ 第一次卡住后，第二次写入仍然会执行（不是被永久堵住）', async () => {
    /**
     * 这条是核心：原实现里第一次卡住 → `pending` 永久挂着 →
     * 第二次 `pending.then(...)` 永不执行。
     *
     * 现在每次写入都有超时，第一次超时后链继续。
     */
    vi.useFakeTimers();
    let setCalls = 0;
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          // 第一次 get 卡住，之后正常
          get: vi
            .fn()
            .mockImplementationOnce(() => new Promise<Record<string, unknown>>(() => undefined))
            .mockImplementation(async () => ({})),
          set: vi.fn(async () => {
            setCalls += 1;
          }),
        },
      },
    });

    void diag('first', 'x');
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + 10);
    // 第一次超时，没 set 成功
    expect(setCalls).toBe(0);

    void diag('second', 'y');
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + 10);
    // ★ 第二次真的执行了
    expect(setCalls).toBe(1);
  });

  it('★★ diag 卡住不影响 trace（两条链独立）', async () => {
    vi.useFakeTimers();
    let traceSet = 0;
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          // diag 用 get，trace 只用 set —— 让 get 永远卡住
          get: () => new Promise<Record<string, unknown>>(() => undefined),
          set: vi.fn(async () => {
            traceSet += 1;
          }),
        },
      },
    });

    void diag('stuck', 'x'); // 会卡在 get
    void trace('t', 'y'); // 只 set，应该能成功

    await vi.advanceTimersByTimeAsync(10);
    // ★ diag 还没结束，但 trace 已经写完
    expect(traceSet).toBe(1);

    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + 10);
  });

  it('超时**不抛错**（诊断失败不需要任何人知道）', async () => {
    installHangingStorage();
    vi.useFakeTimers();
    const p = diag('x', 'y');
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + 10);
    // resolves，不是 rejects
    await expect(p).resolves.toBeUndefined();
  });
});

describe('★ 语义没变（30 条环形、时间正序）', () => {
  it('保留最近 DIAG_LIMIT 条', async () => {
    const { bag } = installWorkingStorage();
    for (let i = 0; i < DIAG_LIMIT + 10; i += 1) {
      await diag('s', `n${String(i)}`);
    }
    const list = bag[DIAG_KEY] as { detail?: string }[];
    expect(list.length).toBe(DIAG_LIMIT);
    // 最后一条是最新的
    expect(list[list.length - 1]?.detail).toBe(`n${String(DIAG_LIMIT + 9)}`);
  });

  it('时间正序（写入顺序 = 数组顺序）', async () => {
    const { bag } = installWorkingStorage();
    await diag('a', '1');
    await diag('b', '2');
    await diag('c', '3');
    const list = bag[DIAG_KEY] as { step: string }[];
    expect(list.map((e) => e.step)).toEqual(['a', 'b', 'c']);
  });

  it('readDiag() 返回时间正序', async () => {
    installWorkingStorage();
    await diag('a');
    await diag('b');
    const logs = await readDiag();
    expect(logs.map((l) => l.step)).toEqual(['a', 'b']);
  });

  it('写入失败静默（不抛）', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async () => {
            throw new Error('boom');
          },
          set: async () => {
            throw new Error('boom');
          },
        },
      },
    });
    await expect(diag('x')).resolves.toBeUndefined();
    await expect(trace('x', 'y')).resolves.toBeUndefined();
  });

  it('trace 语义不变：覆盖写、独立 key', async () => {
    const { bag } = installWorkingStorage();
    await trace('a', '1');
    await trace('b', '2');
    const rec = bag['pluma:diag-trace'] as { step: string };
    expect(rec.step).toBe('b');
    expect(await readDiagTrace()).toMatchObject({ step: 'b', detail: '2' });
  });
});
