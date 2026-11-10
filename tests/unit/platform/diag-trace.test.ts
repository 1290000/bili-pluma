// @vitest-environment jsdom

/**
 * `trace()` 定位通道（2026-11-10 第七轮，smoke 的建议）。
 *
 * ## 为什么需要独立通道
 *
 * `diag()` 是 **30 条环形缓冲**，而 `page/quality` 在播放中每几秒写一轮、
 * 一次 3 条 —— 几分钟就把缓冲冲干净。
 *
 * smoke 实测：`onMessage` 一条都看不到，但 `proxy/set` / `page/quality` 都在，
 * **而且它们也是同一个 listener 写的** —— 说明代码执行了，只是被挤掉了。
 * 这一点让人**误判了两轮**（"日志里没有" ≠ "代码没执行"）。
 *
 * 所以 `trace()` ：
 * - 独立 key（`pluma:diag-trace`）
 * - **覆盖写**，只保留最近一条
 * - 永远看得见最近一次，不被任何高频日志挤掉
 *
 * ## 本文件守什么
 *
 * | 判据 | 反例 |
 * | --- | --- |
 * | 覆盖写（不是追加） | 改成 push → 仍会被挤掉 |
 * | 与主日志分 key | 共用 `pluma:diag` → 同一个缓冲问题 |
 * | 截断 detail | 不截断 → 一条可能撑大 storage |
 * | 失败静默 | 抛错 → 拖垮主流程 |
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DIAG_KEY,
  DIAG_TRACE_KEY,
  DIAG_TRACE_DETAIL_MAX,
  readDiagTrace,
  trace,
} from '../../../src/platform/storage/diag-store';

/** 内存版 storage.local */
function installFakeStorage(): { bag: Record<string, unknown>; setCount: () => number } {
  const bag: Record<string, unknown> = {};
  let sets = 0;
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: bag[key] })),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          sets += 1;
          Object.assign(bag, patch);
        }),
      },
    },
  });
  return { bag, setCount: () => sets };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('★ trace 通道', () => {
  it('★ 用的是独立 key，**不是**主日志的 key', async () => {
    const { bag } = installFakeStorage();
    await trace('x', 'y');
    expect(bag[DIAG_TRACE_KEY]).toBeDefined();
    // ★ 主日志没有被写
    expect(bag[DIAG_KEY]).toBeUndefined();
  });

  it('★ 覆盖写：第二次调用只保留一条（不追加）', async () => {
    const { bag } = installFakeStorage();
    await trace('step1', 'first');
    await trace('step2', 'second');

    const rec = bag[DIAG_TRACE_KEY] as { step: string; detail: string };
    expect(rec.step).toBe('step2');
    expect(rec.detail).toBe('second');
    // 不是数组 —— 覆盖写
    expect(Array.isArray(bag[DIAG_TRACE_KEY])).toBe(false);
  });

  it('★ 写 100 次后读出来的仍是最后一条（永不被挤掉）', async () => {
    installFakeStorage();
    for (let i = 0; i < 100; i += 1) {
      await trace('busy', `round ${String(i)}`);
    }
    const rec = await readDiagTrace();
    expect(rec?.detail).toBe('round 99');
  });

  it('detail 被截断到上限', async () => {
    installFakeStorage();
    await trace('x', 'a'.repeat(2000));
    const rec = await readDiagTrace();
    expect(rec?.detail.length).toBe(DIAG_TRACE_DETAIL_MAX);
  });

  it('带 from（区分 split 下的两个 SW 实例）', async () => {
    installFakeStorage();
    await trace('x', 'y');
    const rec = await readDiagTrace();
    expect(typeof rec?.from).toBe('string');
    expect((rec?.from ?? '').length).toBeGreaterThan(0);
  });

  it('带时间戳', async () => {
    installFakeStorage();
    const before = Date.now();
    await trace('x', 'y');
    const rec = await readDiagTrace();
    expect(rec?.at).toBeGreaterThanOrEqual(before);
  });
});

describe('读不到时的降级', () => {
  it('没有记录 → null', async () => {
    installFakeStorage();
    expect(await readDiagTrace()).toBeNull();
  });

  it('形状坏掉 → null（不抛）', async () => {
    const { bag } = installFakeStorage();
    bag[DIAG_TRACE_KEY] = { garbage: true };
    expect(await readDiagTrace()).toBeNull();
  });

  it('storage 抛错 → trace 静默、readDiagTrace 返回 null', async () => {
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
    // 都不能抛
    await expect(trace('x', 'y')).resolves.toBeUndefined();
    expect(await readDiagTrace()).toBeNull();
  });
});

describe('串行化（与 diag 共用写入队列）', () => {
  it('并发 trace 不会互相覆盖成中间态', async () => {
    installFakeStorage();
    await Promise.all([trace('a', '1'), trace('b', '2'), trace('c', '3')]);
    const rec = await readDiagTrace();
    // 最后一次发起的生效
    expect(rec?.step).toBe('c');
  });
});
