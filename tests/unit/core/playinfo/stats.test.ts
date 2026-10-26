import { describe, expect, it } from 'vitest';

import {
  BUCKET_COUNT,
  BUCKET_MS,
  barStates,
  bucketStart,
  recordResult,
  summarize,
  toTimeline,
  type StatBucket,
} from '@core/playinfo/stats';

/**
 * 守的是"图表不要骗人"。
 *
 * 最关键的用例：稀疏时段必须补成空桶（画灰），
 * 不能把"没请求"画成"失败"——那会让用户误判扩展坏了。
 */

const T0 = 1_760_000_000_000;

describe('bucketStart', () => {
  it('对齐到 5 分钟窗口', () => {
    expect(bucketStart(T0)).toBe(Math.floor(T0 / BUCKET_MS) * BUCKET_MS);
    expect(bucketStart(T0) % BUCKET_MS).toBe(0);
  });
});

describe('recordResult', () => {
  it('同一个窗口内的多次结果累加', () => {
    let b: StatBucket[] = [];
    b = recordResult(b, T0, true);
    b = recordResult(b, T0 + 1000, true);
    b = recordResult(b, T0 + 2000, false);

    expect(b).toHaveLength(1);
    expect(b[0]?.ok).toBe(2);
    expect(b[0]?.fail).toBe(1);
  });

  it('不修改传入的数组（纯函数）', () => {
    const original: StatBucket[] = [{ start: bucketStart(T0), ok: 1, fail: 0 }];
    const copy = JSON.parse(JSON.stringify(original));
    recordResult(original, T0, false);
    expect(original).toEqual(copy);
  });

  it('超出窗口的旧桶被丢弃', () => {
    let b: StatBucket[] = [];
    for (let i = 0; i < BUCKET_COUNT + 5; i += 1) {
      b = recordResult(b, T0 + i * BUCKET_MS, true);
    }
    expect(b.length).toBeLessThanOrEqual(BUCKET_COUNT);
  });

  it('结果按时间排序（图表依赖顺序）', () => {
    let b: StatBucket[] = [];
    b = recordResult(b, T0 + 2 * BUCKET_MS, true);
    b = recordResult(b, T0, true);
    const starts = b.map((x) => x.start);
    expect([...starts].sort((a, c) => a - c)).toEqual(starts);
  });
});

describe('toTimeline —— 必须补齐成固定长度', () => {
  it('恒返回 12 个连续窗口', () => {
    const t = toTimeline([], T0);
    expect(t).toHaveLength(BUCKET_COUNT);
    // 连续：相邻差恰好一个 BUCKET_MS
    for (let i = 1; i < t.length; i += 1) {
      expect((t[i]?.start ?? 0) - (t[i - 1]?.start ?? 0)).toBe(BUCKET_MS);
    }
  });

  it('没请求过的窗口 ok=fail=0（画灰，不是画红）', () => {
    const t = toTimeline([], T0);
    expect(t.every((b) => b.ok === 0 && b.fail === 0)).toBe(true);
  });

  it('有数据的窗口被正确落到对应位置', () => {
    const s = bucketStart(T0);
    const t = toTimeline([{ start: s, ok: 3, fail: 1 }], T0);
    const hit = t.find((b) => b.start === s);
    expect(hit?.ok).toBe(3);
    expect(hit?.fail).toBe(1);
  });

  it('未来时间的数据不会混进窗口', () => {
    const future = bucketStart(T0 + 100 * BUCKET_MS);
    const t = toTimeline([{ start: future, ok: 9, fail: 0 }], T0);
    expect(t.some((b) => b.start === future)).toBe(false);
  });
});

describe('summarize', () => {
  it('没有样本时 rate 为 null（不是 0）', () => {
    expect(summarize([]).rate).toBeNull();
    expect(summarize(toTimeline([], T0)).rate).toBeNull();
  });

  it('成功率按 ok/(ok+fail) 算', () => {
    const s = summarize([
      { start: 0, ok: 3, fail: 1 },
      { start: BUCKET_MS, ok: 4, fail: 0 },
    ]);
    expect(s.total).toBe(8);
    expect(s.ok).toBe(7);
    expect(s.rate).toBeCloseTo(7 / 8);
  });
});

describe('barStates：柱子的颜色不许骗人', () => {
  it('固定 12 根，稀疏时段补 empty', () => {
    const states = barStates([], T0);
    expect(states).toHaveLength(BUCKET_COUNT);
    expect(states.every((s) => s === 'empty')).toBe(true);
  });

  it('全成功 → ok，全失败 → fail，混合 → partial', () => {
    const now = T0;
    const buckets = [
      { start: bucketStart(now), ok: 3, fail: 0 },
      { start: bucketStart(now) - BUCKET_MS, ok: 0, fail: 2 },
      { start: bucketStart(now) - BUCKET_MS * 2, ok: 2, fail: 1 },
    ];
    const states = barStates(buckets, now);
    expect(states[11]).toBe('ok');
    expect(states[10]).toBe('fail');
    expect(states[9]).toBe('partial');
  });

  it('⚠️ 没有请求的窗口是 empty（灰），不是 fail（红）', () => {
    // 一小时里大部分桶本来就是空的（playurl 只在加载和切 P 时调），
    // 画成红会让用户以为一直在失败
    const states = barStates([{ start: bucketStart(T0), ok: 1, fail: 0 }], T0);
    expect(states.filter((s) => s === 'empty')).toHaveLength(BUCKET_COUNT - 1);
    expect(states).not.toContain('fail');
  });
});
