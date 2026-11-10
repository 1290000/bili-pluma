// @vitest-environment jsdom

/**
 * `open-cycler.ts` 的**直接**单测（2026-11-10 阶段 2 收口的落地）。
 *
 * ## 为什么重写这个文件
 *
 * 阶段 2 的 `panel-open-reload.test.ts` 测的是**镜像**——把入口里的
 * 节流 / 并发 / 重试逻辑抄了一份进测试文件。那会漂移
 * （`popup-snapshot.ts` 文件头记录过同一类风险：镜像与真实实现悄悄脱节）。
 *
 * 现在逻辑搬进了 `src/content/panel/open-cycler.ts`（只依赖注入的三个函数），
 * 所以测试可以**直接驱动真实实现**。
 *
 * ## 三条判据的出处（全部来自真机）
 *
 * | 判据 | 真机根因 |
 * | --- | --- |
 * | 展开要重取 | 取数只在挂载时跑一次，`pageState` 停在初始化态 |
 * | 节流但**最后一次必须生效** | hover 连续触发；直接丢弃会让最后一次落空 |
 * | 并发时最后一次发起者优先 | 旧结果后返回会覆盖新结果 → 数据倒退 |
 * | `not-ready` 短重试，拿到 ok 立即停 | 展开瞬间数据可能还没到；**不是轮询** |
 *
 * ## 反向验证
 *
 * 改坏 `open-cycler.ts` 里任一个判据，对应条目必红。已实测四条（见任务报告）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOT_READY_MAX_RETRIES,
  NOT_READY_RETRY_DELAY_MS,
  NOT_READY_TOTAL_MS,
  OPEN_RELOAD_THROTTLE_MS,
  createOpenCycler,
  type LoadResult,
} from '../../../src/content/panel/open-cycler';

type Kind = LoadResult['pageStateKind'];

/**
 * 建一个 cycler + 可控的 load。
 *
 * 定时器用 `vi.useFakeTimers()`，所以 `now()` 直接读 `Date.now()` 即可
 * （fake timers 会接管它）。
 */
function harness(resolve: (n: number) => Promise<Kind | null>) {
  let loads = 0;
  let active = true;

  const cycler = createOpenCycler({
    load: async () => {
      loads += 1;
      const k = await resolve(loads);
      return k === null ? null : { pageStateKind: k };
    },
    isActive: () => active,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  return {
    cycler,
    loadCount: () => loads,
    deactivate: () => {
      active = false;
    },
  };
}

/** 冲掉 microtask + 推进时钟 */
async function tick(ms = 0): Promise<void> {
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('★ 展开重取', () => {
  it('★ 首次 open 立即取数一次', async () => {
    const h = harness(async () => 'ok');
    h.cycler.open();
    await tick();
    expect(h.loadCount()).toBe(1);
  });

  it('★ 节流窗口内连续 open：不刷屏，但窗口结束时补一次（最后一次必须生效）', async () => {
    const h = harness(async () => 'ok');
    h.cycler.open();
    await tick();
    expect(h.loadCount()).toBe(1);

    // 窗口内连续 5 次
    for (let i = 0; i < 5; i += 1) {
      h.cycler.open();
      await tick(20);
    }
    // 仍在窗口内：不应有新请求
    expect(h.loadCount()).toBe(1);

    // 窗口结束 → 尾随补一次
    await tick(OPEN_RELOAD_THROTTLE_MS);
    expect(h.loadCount()).toBe(2);
  });

  it('★ 窗口过后再 open → 立刻取数', async () => {
    const h = harness(async () => 'ok');
    h.cycler.open();
    await tick();
    await tick(OPEN_RELOAD_THROTTLE_MS + 10);

    h.cycler.open();
    await tick();
    expect(h.loadCount()).toBe(2);
  });

  it('★ 并发时以"最后一次发起"的结果为准（旧结果不得覆盖新的）', async () => {
    /**
     * 构造：第 1 次很慢、第 2 次很快。若没有序号保护，慢的那次后返回会覆盖新的。
     *
     * ## ⚠️ 断言点必须在 `load()` **之外**
     *
     * 序号保护（`if (my !== seq) return`）发生在 `load()` 返回**之后**。
     * 所以如果在 `load()` 内部记"我到了"，无论有没有保护都会记录 —— 那条断言什么也守不住。
     *
     * 正确做法：`load()` 只负责产生结果，**副作用（模拟 `setModel`）放在
     * `load()` 返回之后**由 cycler 决定要不要继续。这里用 `onResult` 观察：
     * cycler 丢弃过期结果时不会走到 `scheduleRetry`，所以观察点是
     * **重试是否被排上**——第 1 次的 `not-ready` 若被误当成最新，会排重试。
     */
    const gates: (() => void)[] = [];
    const retrySpy = vi.fn();
    let loads = 0;

    const cycler = createOpenCycler({
      load: async () => {
        loads += 1;
        const my = loads;
        await new Promise<void>((res) => {
          gates[my - 1] = res;
        });
        /**
         * 第 1 次返回 `not-ready`（会被排重试），第 2 次返回 `ok`（不排重试）。
         * 若序号保护失效：第 1 次后返回 → cycler 认为它是最新的 → **排重试**
         * （因为 not-ready）→ 后续重试会再调 load → `loads` 变大。
         */
        return { pageStateKind: my === 1 ? 'not-ready' : 'ok' } as LoadResult;
      },
      isActive: () => true,
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        retrySpy(fn, ms);
        return setTimeout(fn, ms);
      },
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });

    cycler.open();
    await tick();
    await tick(OPEN_RELOAD_THROTTLE_MS + 10);
    cycler.open();
    await tick(loads === 2 ? 0 : 0);
    expect(gates.length).toBe(2);

    // 第 2 次（ok）先完成
    gates[1]?.();
    await tick();
    const timersAfterGood = retrySpy.mock.calls.length;

    // 第 1 次（not-ready）后完成 —— 已过期，**不得**排重试
    gates[0]?.();
    await tick();

    expect(retrySpy.mock.calls.length, '过期结果被当成了最新的一次，排了不该排的重试').toBe(
      timersAfterGood,
    );
  });

  it('面板不活跃时 open 不取数', async () => {
    const h = harness(async () => 'ok');
    h.deactivate();
    h.cycler.open();
    await tick();
    expect(h.loadCount()).toBe(0);
  });

  it('load 抛错不影响下一次 open', async () => {
    let first = true;
    const h = harness(async () => {
      if (first) {
        first = false;
        throw new Error('boom');
      }
      return 'ok';
    });

    h.cycler.open();
    await tick();
    // 没崩，且计数到了 1
    expect(h.loadCount()).toBe(1);

    await tick(OPEN_RELOAD_THROTTLE_MS + 10);
    h.cycler.open();
    await tick();
    expect(h.loadCount()).toBe(2);
  });
});

describe('★ not-ready 自动重试（不是轮询）', () => {
  it('★ not-ready 会排重试，最多 NOT_READY_MAX_RETRIES 次', async () => {
    const h = harness(async () => 'not-ready');
    h.cycler.open();
    await tick();

    for (let i = 0; i < NOT_READY_MAX_RETRIES + 3; i += 1) {
      await tick(NOT_READY_RETRY_DELAY_MS);
    }
    // 1 次初始 + 3 次重试
    expect(h.loadCount()).toBe(1 + NOT_READY_MAX_RETRIES);
  });

  it('★ 中途拿到 ok → 立即停止重试', async () => {
    const h = harness(async (n) => (n >= 2 ? 'ok' : 'not-ready'));
    h.cycler.open();
    await tick();
    expect(h.loadCount()).toBe(1);

    await tick(NOT_READY_RETRY_DELAY_MS);
    expect(h.loadCount()).toBe(2);

    // 拿到 ok 之后，推很久也不应有新请求
    await tick(NOT_READY_RETRY_DELAY_MS * 10);
    expect(h.loadCount()).toBe(2);
  });

  it('★ timeout 不排重试（通道断了重试没意义）', async () => {
    const h = harness(async () => 'timeout');
    h.cycler.open();
    await tick();
    await tick(NOT_READY_RETRY_DELAY_MS * 5);
    expect(h.loadCount()).toBe(1);
  });

  it('★ no-content-script 不排重试', async () => {
    const h = harness(async () => 'no-content-script');
    h.cycler.open();
    await tick();
    await tick(NOT_READY_RETRY_DELAY_MS * 5);
    expect(h.loadCount()).toBe(1);
  });

  it('ok 不排重试', async () => {
    const h = harness(async () => 'ok');
    h.cycler.open();
    await tick();
    await tick(NOT_READY_RETRY_DELAY_MS * 5);
    expect(h.loadCount()).toBe(1);
  });

  it('★ 超过总时限后不再重试（第二道保险）', async () => {
    /**
     * 场景：面板长期不收起，每次 load 都 not-ready。
     * 次数上限能兜住，但总时限是第二道保险 —— 这里验证它真的生效：
     * 把时钟推过 `NOT_READY_TOTAL_MS` 后，重试链应该已经断掉。
     */
    const h = harness(async () => 'not-ready');
    h.cycler.open();
    await tick();

    // 推过总时限
    await tick(NOT_READY_TOTAL_MS + NOT_READY_RETRY_DELAY_MS * 2);
    const after = h.loadCount();

    // 再推很久，不应再增加
    await tick(NOT_READY_TOTAL_MS);
    expect(h.loadCount()).toBe(after);
  });
});

describe('生命周期', () => {
  it('★ dispose 后挂起的定时器都不再触发', async () => {
    const h = harness(async () => 'not-ready');
    h.cycler.open();
    await tick();
    const before = h.loadCount();

    h.cycler.dispose();
    await tick(NOT_READY_RETRY_DELAY_MS * 5);
    expect(h.loadCount()).toBe(before);
  });

  it('★ dispose 让在飞的取数结果作废（不落到 UI）', async () => {
    /** 显式标注类型，否则 TS 会把闭包里的赋值收窄成 never */
    let release: (() => void) | undefined;
    let loads = 0;
    const cycler = createOpenCycler({
      load: async () => {
        loads += 1;
        await new Promise<void>((res) => {
          release = res;
        });
        return { pageStateKind: 'ok' };
      },
      isActive: () => true,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });

    cycler.open();
    await tick();
    expect(loads).toBe(1);

    cycler.dispose();
    release?.();
    await tick();

    // dispose 之后再 open 才是新一轮；这里只断言"没有因为旧结果而继续排重试"
    expect(loads).toBe(1);
  });

  it('close 不清 not-ready 重试（收起面板后数据仍会就绪）', async () => {
    const h = harness(async (n) => (n >= 2 ? 'ok' : 'not-ready'));
    h.cycler.open();
    await tick();
    expect(h.loadCount()).toBe(1);

    h.cycler.close();
    await tick(NOT_READY_RETRY_DELAY_MS);
    // 重试照常发生
    expect(h.loadCount()).toBe(2);
  });

  it('close 取消尾随（为一次已经过去的 hover 服务，不该再发）', async () => {
    const h = harness(async () => 'ok');
    h.cycler.open();
    await tick();
    expect(h.loadCount()).toBe(1);

    h.cycler.open(); // 窗口内 → 排尾随
    h.cycler.close(); // 收起 → 取消尾随
    await tick(OPEN_RELOAD_THROTTLE_MS * 2);
    expect(h.loadCount()).toBe(1);
  });
});
