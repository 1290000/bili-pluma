// @vitest-environment node

/**
 * 说明页**自轮询状态机**（2026-11-12，task-4 主线 D-2）。
 *
 * ## 这一轮要解决的用户痛点
 *
 * 「我通过弹出来的弹窗跳到了扩展界面打开了在 InPrivate 中允许后，再返回原本的网页，
 *   此时点击扫码登录取流账号没有反应……必须重新刷新整个界面之后再次点击
 *   扫码登录取流账号才能真正的弹出扫码界面」。
 *
 * 根因（`poc/probe/logout-login/REPORT.md` D.4）：旧实现只靠一次性的
 * `chrome.storage.onChanged` 监听器，而它在 **8 秒后永久摘掉**；
 * 用户开权限普遍超过 8 秒 → 说明页此后**永远关不掉**，只能刷新。
 *
 * ## 本文件守的判据
 *
 * | 判据 | 反例（反向验证） |
 * | --- | --- |
 * | 两个条件**同时**成立才 `done` | 只看权限 → 重现 D.3「说明页没了、二维码也没有」 |
 * | 8 秒之后**仍然**在轮询 | 改回一次性监听 → 「T+8s 之后开好权限」那条变红 |
 * | 超时（≥60s）→ `timeout` 且停 | 不设上限 → 页面开着就一直在读 storage |
 * | `stop()` 幂等且清定时器 | 不清 → 页面卸载后还在跑 |
 * | 单次读失败不放弃 | 一次抛错就停 → 网络抖一下就永远关不掉 |
 */

import { describe, expect, it } from 'vitest';

import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  startIncognitoWatch,
  type WatchState,
} from '../../../entrypoints/need-incognito/incognito-watch';

/**
 * 假时钟 —— 手动推进"过去了多少毫秒"。
 *
 * 用真的 `setTimeout` 会让每条测试等 90 秒；这里同时模拟**时间流逝**与**定时器触发**，
 * 才能断言"第 N 拍之后才触发"。
 */
function fakeClock(startAt = 0) {
  let t = startAt;
  let seq = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();

  const flush = async (): Promise<void> => {
    // 让 tick 里两层的 await（Promise.all + 读数）都走完
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  return {
    now: (): number => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      seq += 1;
      pending.set(seq, { fn, at: t + ms });
      return seq;
    },
    clearTimer: (h: unknown): void => {
      pending.delete(h as number);
    },
    /** 推进一拍（时间前进一个间隔，并触发挂着的那个定时器） */
    async advance(ms = POLL_INTERVAL_MS): Promise<void> {
      t += ms;
      const due = [...pending.entries()].filter(([, v]) => v.at <= t);
      for (const [id, v] of due) {
        pending.delete(id);
        v.fn();
        await flush();
      }
    },
    /** 推进到某个绝对时刻（中间自动补拍），用于跨过 8 秒 / 60 秒 */
    async advanceTo(target: number): Promise<void> {
      while (t < target) {
        const next = Math.min(t + POLL_INTERVAL_MS, target);
        await this.advance(next - t);
      }
    },
    size: (): number => pending.size,
  };
}

function constReader(v: boolean | Error) {
  return async (): Promise<boolean> => {
    if (v instanceof Error) throw v;
    return v;
  };
}

describe('★★ 两个条件同时成立才 done', () => {
  it('★★ 权限先开、窗口后开 → 第 3 拍 done', async () => {
    const clock = fakeClock();
    const states: WatchState[] = [];
    // 第 0 拍：allowed false；第 1 拍：allowed true 但 ready false；第 2 拍：两个都 true
    let n = 0;
    const allowed = async (): Promise<boolean> => n >= 1;
    const ready = async (): Promise<boolean> => n >= 2;
    const bump = (): void => {
      n += 1;
    };

    startIncognitoWatch({
      readReady: ready,
      readAllowed: async () => {
        const v = await allowed();
        bump();
        return v;
      },
      onState: (s) => states.push(s),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    // 首轮 tick 立即执行
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(states).toEqual([]); // 首轮 waiting 不回调

    await clock.advance(); // n=1 → allowed true, ready false
    expect(states).toEqual([]);

    await clock.advance(); // n=2 → 两个都 true
    expect(states).toEqual(['done']);
  });

  it('★★ 只有权限开、窗口没就绪 → **不许** done（这条防的是 D.3「说明页没了二维码也没有」）', async () => {
    const clock = fakeClock();
    const states: WatchState[] = [];

    startIncognitoWatch({
      readReady: constReader(false), // 窗口始终没就绪
      readAllowed: constReader(true), // 权限已开
      onState: (s) => states.push(s),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    for (let i = 0; i < 10; i += 1) await clock.advance();

    expect(states, '权限开但窗口没就绪就关页面 = 用户看到"点了没反应"').toEqual([]);
  });

  it('★★ 只有窗口就绪、权限没开 → **不许** done（`assumed` 是猜测）', async () => {
    const clock = fakeClock();
    const states: WatchState[] = [];

    startIncognitoWatch({
      readReady: constReader(true),
      readAllowed: constReader(false),
      onState: (s) => states.push(s),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    for (let i = 0; i < 10; i += 1) await clock.advance();

    expect(states).toEqual([]);
  });
});

describe('★★ 8 秒之后仍然在轮询（旧 bug 的主现场）', () => {
  it('★★ 权限在 T+15s 才开、窗口在 T+20s 才就绪 → 仍然 done', async () => {
    /**
     * 这是**整个改动存在的理由**：旧实现 `watchForLoginReady` 默认 8 秒超时后
     * `cleanup()` 永久摘监听器，之后说明页再也收不到任何信号。
     *
     * 反向验证：把 `startIncognitoWatch` 换成"首轮读一次，之后不再排定时器"
     *（等价于一次性监听超时后摘除）→ 本条变红：`states` 为空。
     */
    const clock = fakeClock();
    const states: WatchState[] = [];
    const startAt = clock.now();

    startIncognitoWatch({
      readAllowed: async () => clock.now() - startAt >= 15_000,
      readReady: async () => clock.now() - startAt >= 20_000,
      onState: (s) => states.push(s),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    // 走过旧实现的 8 秒死线
    await clock.advanceTo(9_000);
    expect(states, '8 秒后还在等，没有误判成 timeout').toEqual([]);

    // 继续走到窗口就绪
    await clock.advanceTo(21_000);
    expect(states, 'T+20s 才开好也该被检测到').toEqual(['done']);
  });

  it('★★ 轮询间隔是 1.5 秒、总时长 ≥ 60 秒', () => {
    /**
     * 裁决 3.1 的硬指标。反向改小（例如 1 秒）不是 bug，但改到 > 2 秒会让
     * "开好权限后要等好几拍"重新变成体感卡顿；总时长 < 60 秒直接违约。
     */
    expect(POLL_INTERVAL_MS).toBe(1500);
    expect(POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe('★★ 超时 → timeout 且停', () => {
  it('★★ 一直没就绪 → 到 POLL_TIMEOUT_MS 时 timeout，之后不再有定时器', async () => {
    const clock = fakeClock();
    const states: WatchState[] = [];

    const h = startIncognitoWatch({
      readReady: constReader(false),
      readAllowed: constReader(false),
      onState: (s) => states.push(s),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(clock.size()).toBe(1); // 首轮之后排了一拍

    await clock.advanceTo(POLL_TIMEOUT_MS + POLL_INTERVAL_MS);

    expect(states).toEqual(['timeout']);
    expect(h.running()).toBe(false);
    expect(clock.size(), 'timeout 之后不许再有定时器').toBe(0);
  });
});

describe('★★ stop() → 停且清定时器', () => {
  it('★★ 页面卸载后不许再轮询', async () => {
    /**
     * 反向验证：`stop()` 不清 `clearTimer` → `clock.size()` 仍是 1，本条变红。
     * 真机表现：说明页关掉后后台仍每 1.5 秒读一次 storage。
     */
    const clock = fakeClock();
    const states: WatchState[] = [];

    const h = startIncognitoWatch({
      readReady: constReader(false),
      readAllowed: constReader(false),
      onState: (s) => states.push(s),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(clock.size()).toBe(1);

    h.stop();

    expect(h.running()).toBe(false);
    expect(clock.size()).toBe(0);
    expect(states).toEqual([]);
  });

  it('stop() 幂等，且停止后不再回调', async () => {
    const clock = fakeClock();
    const states: WatchState[] = [];
    const h = startIncognitoWatch({
      readReady: constReader(true),
      readAllowed: constReader(true),
      onState: (s) => states.push(s),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    // 首轮就会 done（两个都 true），所以先 stop 意义在于验证不重复回调
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(states).toEqual(['done']);

    h.stop();
    h.stop();
    expect(states).toEqual(['done']);
  });
});

describe('★ 单次读失败不放弃', () => {
  it('★ 读 storage 抛错 → 继续轮询，之后能 done', async () => {
    /**
     * 反向验证：把 `.catch(() => false)` 去掉、让异常冒出去 → 本轮 tick 直接 reject，
     * 不再排下一拍，本条变红（`states` 为空）。
     */
    const clock = fakeClock();
    const states: WatchState[] = [];
    let failOnce = true;

    startIncognitoWatch({
      readReady: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('storage 暂时读不到');
        }
        return true;
      },
      readAllowed: constReader(true),
      onState: (s) => states.push(s),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(states, '首轮读失败不该判 done，也不该停').toEqual([]);

    await clock.advance();
    expect(states).toEqual(['done']);
  });
});
