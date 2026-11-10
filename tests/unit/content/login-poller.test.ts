// @vitest-environment node

/**
 * 扫码登录后的**一次性轮询**（2026-11-10）。
 *
 * ## 为什么需要它
 *
 * 扫码窗口在**无痕分区**（`incognito: 'split'`），两个 background 实例不能直接通信，
 * 唯一共享的是 `chrome.storage.local` —— 所以只能轮询 `account/summary`。
 *
 * ## 本文件守的关键判据
 *
 * | 判据 | 反例 |
 * | --- | --- |
 * | 检测到新 mid → **立刻停** | 不停 → 变成无限轮询，一直打 `account/summary` |
 * | 超时 → 停 | 不停 → 同上 |
 * | `stop()` → 停且**清定时器** | 不清 → 面板关掉后还在跑，泄漏 |
 * | 连点两次只有一个轮询 | 叠加 → 双倍请求 |
 * | **第一次轮询不立即成功** | 用 `mid !== null` 当判据 → 用户还没扫码就"成功" |
 */

import { describe, expect, it } from 'vitest';

import {
  POLL_MAX,
  POLL_MS,
  startLoginPolling,
  type AccountSnapshot,
  type PollOutcome,
} from '../../../src/content/panel/login-poller';

/**
 * 假定时器 —— 手动控制"3 秒过去了"。
 *
 * 用假的而不是真 `setTimeout`：真定时器会让测试每条都等 3 秒，
 * 而且无法精确断言"排了一次还是两次"。
 */
function fakeClock() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();

  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimer: (h: unknown): void => {
      pending.delete(h as number);
    },
    /** 推进一次定时器（触发最早排的那个） */
    async advance(): Promise<void> {
      const entry = [...pending.entries()][0];
      if (!entry) throw new Error('没有排队的定时器 —— 轮询已经停了？');
      const [id, t] = entry;
      pending.delete(id);
      t.fn();
      // 让 tick 里的 await 走完
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    /** 还有几个挂着的定时器 */
    size: () => pending.size,
  };
}

/** 造一个可控的 read */
function reader(sequence: (AccountSnapshot | Error)[]) {
  let i = 0;
  const calls: number[] = [];
  return {
    read: async (): Promise<AccountSnapshot> => {
      calls.push(i);
      const v = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error('序列为空 —— 测试数据写错了');
      return v;
    },
    callCount: () => calls.length,
  };
}

describe('★★ 检测到新账号 → 立刻停', () => {
  it('★★ 首次配置：从 null 变成有 mid → 成功并停下', async () => {
    /**
     * 反例：去掉 `finish({kind:'configured'})` → 轮询继续跑，本条的
     * `running()` 断言变红（会一直是 true）。
     */
    const clock = fakeClock();
    const r = reader([{ mid: null }, { mid: null }, { mid: 12345 }]);
    const outcomes: PollOutcome[] = [];

    const p = startLoginPolling(
      {
        read: r.read,
        onDone: (o) => outcomes.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      null,
    );

    // 第 1 次 tick（启动时立刻跑）：mid null，继续
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(p.running()).toBe(true);

    await clock.advance(); // 第 2 次：仍 null
    expect(p.running()).toBe(true);

    await clock.advance(); // 第 3 次：12345 → 成功
    expect(p.running()).toBe(false);
    expect(outcomes).toEqual([{ kind: 'configured', mid: 12345 }]);
    // ★ 停了之后不该再有定时器
    expect(clock.size()).toBe(0);
  });

  it('★★ 换号：mid 变了 → 成功', async () => {
    const clock = fakeClock();
    const r = reader([{ mid: 111 }, { mid: 222 }]);
    const outcomes: PollOutcome[] = [];

    const p = startLoginPolling(
      {
        read: r.read,
        onDone: (o) => outcomes.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      111,
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await clock.advance();

    expect(p.running()).toBe(false);
    expect(outcomes).toEqual([{ kind: 'configured', mid: 222 }]);
  });

  it('★★ 「账号本来就是配置着的」**不能**立即判成功', async () => {
    /**
     * 这是最容易写错的判据。
     *
     * 如果用 `if (snap.mid !== null)` → 用户点「重新登录」后**第一次轮询就成功**，
     * 因为他原来的号本来就在 —— 等于轮询毫无作用，而且会误导用户
     * "已经登录好了"（其实他还没扫码）。
     *
     * 正确判据：`mid !== null && mid !== before`。
     */
    const clock = fakeClock();
    // 一直是同一个号（用户还没扫完）
    const r = reader([{ mid: 111 }]);
    const outcomes: PollOutcome[] = [];

    const p = startLoginPolling(
      {
        read: r.read,
        onDone: (o) => outcomes.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      111,
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // ★ 还在等，没有报成功
    expect(p.running()).toBe(true);
    expect(outcomes).toEqual([]);

    p.stop();
  });
});

describe('★★ 超时 → 停', () => {
  it(`★★ 轮询 ${String(POLL_MAX)} 次都没检测到 → timeout`, async () => {
    const clock = fakeClock();
    const r = reader([{ mid: null }]);
    const outcomes: PollOutcome[] = [];

    const p = startLoginPolling(
      {
        read: r.read,
        onDone: (o) => outcomes.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      null,
    );

    // 第 1 次在启动时已经跑了
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 再推进 POLL_MAX - 1 次
    for (let i = 1; i < POLL_MAX; i += 1) {
      if (!p.running()) break;
      await clock.advance();
    }

    expect(p.running()).toBe(false);
    expect(outcomes).toEqual([{ kind: 'timeout' }]);
    expect(clock.size()).toBe(0);
  });
});

describe('★★ stop() → 停且清定时器', () => {
  it('★★ 调用 stop() 后不再有定时器（面板关闭时不能泄漏）', async () => {
    /**
     * 反例：`stop()` 不清 `handle` → `clock.size()` 仍 > 0，
     * 真机上表现为"面板关了，background 还在被轮询"。
     */
    const clock = fakeClock();
    const r = reader([{ mid: null }]);
    const outcomes: PollOutcome[] = [];

    const p = startLoginPolling(
      {
        read: r.read,
        onDone: (o) => outcomes.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      null,
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.size()).toBe(1);

    p.stop();

    expect(p.running()).toBe(false);
    expect(outcomes).toEqual([{ kind: 'cancelled' }]);
    // ★ 定时器清掉了
    expect(clock.size()).toBe(0);
  });

  it('stop() 幂等（连调两次只回调一次）', () => {
    const clock = fakeClock();
    const outcomes: PollOutcome[] = [];
    const p = startLoginPolling(
      {
        read: async () => ({ mid: null }),
        onDone: (o) => outcomes.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      null,
    );
    p.stop();
    p.stop();
    expect(outcomes).toEqual([{ kind: 'cancelled' }]);
  });

  it('★ 停止后再推进定时器不会重复回调', async () => {
    const clock = fakeClock();
    const outcomes: PollOutcome[] = [];
    const p = startLoginPolling(
      {
        read: async () => ({ mid: 999 }),
        onDone: (o) => outcomes.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      999,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    p.stop();
    // 定时器已被清，没有可推进的
    expect(clock.size()).toBe(0);
    expect(outcomes).toEqual([{ kind: 'cancelled' }]);
  });
});

describe('★ 连点两次「重新登录」只有一个轮询', () => {
  it('★ 先 stop 旧的再开新的 → 旧的不再产生回调', async () => {
    /**
     * 调用方（`content-panel.content.ts`）负责"先停旧的再开新的"。
     * 本测试验证那个模式**确实**不会叠加。
     *
     * ⚠️ 模块本身不做全局单例 —— 那会让测试互相污染，
     * 而且"只有一个轮询"是调用方的责任，不是轮询器的。
     */
    const clock = fakeClock();
    const first: PollOutcome[] = [];
    const second: PollOutcome[] = [];

    const p1 = startLoginPolling(
      {
        read: async () => ({ mid: null }),
        onDone: (o) => first.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      null,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 用户又点了一次
    p1.stop();
    const p2 = startLoginPolling(
      {
        read: async () => ({ mid: 777 }),
        onDone: (o) => second.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      null,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 第一个已被取消，不会报成功
    expect(first).toEqual([{ kind: 'cancelled' }]);
    // 第二个成功了
    expect(second).toEqual([{ kind: 'configured', mid: 777 }]);
    expect(p1.running()).toBe(false);
    expect(p2.running()).toBe(false);
  });
});

describe('★ 单次读失败不放弃', () => {
  it('★ 中途抛错 → 继续轮询，不立刻失败', async () => {
    /**
     * 网络抖一下就放弃太脆弱。原 options 也是容错的（`send()` 返回 null 后继续）。
     */
    const clock = fakeClock();
    const r = reader([{ mid: null }, new Error('boom'), { mid: 555 }]);
    const outcomes: PollOutcome[] = [];

    const p = startLoginPolling(
      {
        read: r.read,
        onDone: (o) => outcomes.push(o),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      null,
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(p.running()).toBe(true);

    await clock.advance(); // 抛错
    expect(p.running(), '单次失败不该停止轮询').toBe(true);

    await clock.advance(); // 555 → 成功
    expect(outcomes).toEqual([{ kind: 'configured', mid: 555 }]);
  });
});

describe('常量', () => {
  it('间隔 3 秒、最多 60 次（与原 options 一致）', () => {
    expect(POLL_MS).toBe(3000);
    expect(POLL_MAX).toBe(60);
    // 3 分钟
    expect(POLL_MS * POLL_MAX).toBe(180_000);
  });
});
