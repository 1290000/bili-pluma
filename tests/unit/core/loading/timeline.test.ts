import { describe, expect, it } from 'vitest';

import type { LoadEvent, LoadStage } from '@core/loading/timeline';
import {
  buildTimeline,
  currentSegment,
  detectSwitches,
  pairSegments,
} from '@core/loading/timeline';

/**
 * 守的是"时间轴画出来的每个节点都对应真实发生的事，且时间戳是原始值"。
 *
 * 事件由几个互不相识的采集钩子投递，投递顺序与时间顺序不保证一致。所以这里的断言分两类：
 *
 * 1. **该排的排好**：按 `t` 升序，同一 `t` 内按 `LoadStage` 声明顺序 —— 否则同一毫秒内的
 *    两个阶段每次渲染位置随机，用户截图对比时对不上。
 * 2. **不该动的绝不动**：非法时间戳直接丢（不修正成 0）、重复的去重、缺失的**不补造**、
 *    时间戳**从不被夹平**（真的倒退就照原样显示，那是采集侧的问题，应该被看见）。
 */

/** 造一条事件，只为让用例读起来短一点 */
function ev(t: number, stage: LoadStage, host?: string): LoadEvent {
  return host === undefined ? { t, stage } : { t, stage, host };
}

describe('buildTimeline：乱序输入被排好，时间戳原样保留', () => {
  it('t 乱序 → 按 t 升序输出，每条的 t 仍是原始值（不夹平）', () => {
    const { events, truncated } = buildTimeline([
      ev(30, 'playing'),
      ev(10, 'nav'),
      ev(20, 'playurl-req'),
    ]);

    expect(events.map((e) => e.stage)).toEqual(['nav', 'playurl-req', 'playing']);
    // 关键：没有一步去"修正"时间戳。10 就是 10，不会被抬成 30。
    expect(events.map((e) => e.t)).toEqual([10, 20, 30]);
    expect(truncated).toBe(false);
  });

  it('不改入参（采集侧环形缓冲不能被污染）', () => {
    const input: LoadEvent[] = [ev(30, 'playing'), ev(10, 'nav')];
    buildTimeline(input);
    expect(input.map((e) => e.t)).toEqual([30, 10]);
  });

  it('真的"响应早于请求"也照原样显示 —— 不许被抹平成看着合理的顺序', () => {
    // 这种数据说明采集钩子装晚了，是个要被看见的异常，不是要被夹平的噪声
    const { events } = buildTimeline([ev(20, 'seg-req'), ev(15, 'seg-res')]);

    expect(events.map((e) => [e.stage, e.t])).toEqual([
      ['seg-res', 15],
      ['seg-req', 20],
    ]);
  });
});

describe('buildTimeline：非法时间戳直接丢，不修正成 0', () => {
  it('t 为 NaN / Infinity / -1 的事件消失', () => {
    const { events } = buildTimeline([
      ev(Number.NaN, 'nav'),
      ev(Number.POSITIVE_INFINITY, 'playurl-req'),
      ev(-1, 'playurl-res'),
      ev(8, 'playing'),
    ]);

    // NaN/Infinity 修成 0 会凭空造出"页面刚开始就发生了这件事"的假节点
    expect(events).toHaveLength(1);
    expect(events[0]?.stage).toBe('playing');
    expect(events[0]?.t).toBe(8);
  });

  it('被丢掉的 -1 不会占住时间轴首位', () => {
    const { events } = buildTimeline([ev(-1, 'nav'), ev(5, 'playurl-req')]);

    expect(events.map((e) => [e.stage, e.t])).toEqual([['playurl-req', 5]]);
  });

  it('全部非法 → 空时间轴，不抛异常', () => {
    const result = buildTimeline([ev(Number.NaN, 'nav'), ev(-5, 'error')]);
    expect(result.events).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe('buildTimeline：去重', () => {
  it('stage + host + t 全同的事件只留一条（不相邻也去重）', () => {
    const { events } = buildTimeline([
      ev(10, 'seg-req', 'a.bilivideo.com'),
      ev(10, 'seg-req', 'b.bilivideo.com'),
      ev(10, 'seg-req', 'a.bilivideo.com'),
    ]);

    // 两条 a 中间夹着 b，只比"上一条"会漏掉
    expect(events.map((e) => e.host)).toEqual(['a.bilivideo.com', 'b.bilivideo.com']);
  });

  it('host 不同 / stage 不同 / t 不同都不是重复', () => {
    const { events } = buildTimeline([
      ev(10, 'seg-req', 'a.bilivideo.com'),
      ev(10, 'seg-req', 'b.bilivideo.com'),
      ev(10, 'seg-res', 'a.bilivideo.com'),
      ev(11, 'seg-req', 'a.bilivideo.com'),
    ]);

    expect(events).toHaveLength(4);
  });

  it('"没有 host" 与 "host 是空串" 不互相吞掉', () => {
    const { events } = buildTimeline([ev(10, 'nav'), ev(10, 'nav', '')]);
    expect(events).toHaveLength(2);
  });
});

describe('buildTimeline：超过上限时保留最新的一段', () => {
  it('limit = 3 时留下最后 3 条，并置 truncated', () => {
    const raw = [ev(1, 'nav'), ev(2, 'playurl-req'), ev(3, 'playurl-res'), ev(4, 'playing')];
    const { events, truncated } = buildTimeline(raw, 3);

    expect(events.map((e) => e.stage)).toEqual(['playurl-req', 'playurl-res', 'playing']);
    expect(truncated).toBe(true);
  });

  it('limit 恰好等于条数 → 不截断', () => {
    const raw = [ev(1, 'nav'), ev(2, 'playing')];
    expect(buildTimeline(raw, 2).truncated).toBe(false);
  });

  it('默认上限 200：201 条时只留 200 条且 truncated', () => {
    const raw = Array.from({ length: 201 }, (_unused, i) => ev(i + 1, 'seg-req'));
    const { events, truncated } = buildTimeline(raw);

    expect(events).toHaveLength(200);
    // 保留的是"最新的"：第一条被丢，最后一条（t=201）还在
    expect(events[0]?.t).toBe(2);
    expect(events[199]?.t).toBe(201);
    expect(truncated).toBe(true);
  });

  it('limit = 0 → 空时间轴且 truncated', () => {
    const { events, truncated } = buildTimeline([ev(1, 'nav')], 0);
    expect(events).toEqual([]);
    expect(truncated).toBe(true);
  });
});

describe('buildTimeline：同一 t 的事件按 LoadStage 声明顺序排', () => {
  it('playurl-res 在 playurl-req 之后，canplay 在 seg-res 之后', () => {
    const { events } = buildTimeline([
      ev(10, 'canplay'),
      ev(10, 'playurl-res'),
      ev(10, 'seg-res'),
      ev(10, 'nav'),
      ev(10, 'playurl-req'),
    ]);

    // 声明顺序即渲染顺序：同 t 时不许随机，否则两次截图对不上
    expect(events.map((e) => e.stage)).toEqual([
      'nav',
      'playurl-req',
      'playurl-res',
      'seg-res',
      'canplay',
    ]);
  });

  it('同一 t 组内顺序与输入顺序无关', () => {
    const a = buildTimeline([ev(1, 'stall'), ev(1, 'error'), ev(1, 'ext-patch')]);
    const b = buildTimeline([ev(1, 'ext-patch'), ev(1, 'stall'), ev(1, 'error')]);
    expect(a.events.map((e) => e.stage)).toEqual(b.events.map((e) => e.stage));
  });

  it('跨 t 时仍以 t 为准（阶段顺序不能压过时间）', () => {
    const { events } = buildTimeline([ev(10, 'canplay'), ev(20, 'nav')]);
    expect(events.map((e) => e.stage)).toEqual(['canplay', 'nav']);
  });
});

describe('buildTimeline：绝不补造事件', () => {
  it('输入缺 playing → 输出里也没有 playing', () => {
    const { events } = buildTimeline([ev(1, 'nav'), ev(9, 'canplay')]);

    expect(events.map((e) => e.stage)).not.toContain('playing');
    expect(events).toHaveLength(2);
  });

  it('空输入 → 空时间轴', () => {
    expect(buildTimeline([])).toEqual({ events: [], truncated: false });
  });
});

describe('currentSegment：此刻正在用的线路（P0-2）', () => {
  it('取**最后一条** seg-req，而不是 argmax', () => {
    const events = buildTimeline([
      ev(10, 'seg-req', 'a.bilivideo.com'),
      ev(20, 'seg-req', 'b.mcdn.bilivideo.com'),
    ]).events;

    expect(currentSegment(events)?.host).toBe('b.mcdn.bilivideo.com');
  });

  it('没有 host 的 seg-req 跳过（不把"不知道哪条线"当成一条线路）', () => {
    const events = buildTimeline([
      ev(10, 'seg-req', 'a.bilivideo.com'),
      { t: 20, stage: 'seg-req' },
    ]).events;

    expect(currentSegment(events)?.host).toBe('a.bilivideo.com');
  });

  it('只有里程碑 / 空输入 → null（不编一条）', () => {
    expect(currentSegment([])).toBeNull();
    expect(currentSegment(buildTimeline([ev(10, 'playing')]).events)).toBeNull();
  });
});

describe('detectSwitches：分片请求真的换了 host 才算切换', () => {
  it('相邻 seg-req 的 host 不同 → 产出一条切换（用后一条的 t）', () => {
    const events = buildTimeline([
      ev(10, 'seg-req', 'a.bilivideo.com'),
      ev(20, 'seg-req', 'a.bilivideo.com'),
      ev(30, 'seg-req', 'b.mcdn.bilivideo.com'),
    ]).events;

    expect(detectSwitches(events)).toEqual([
      { t: 30, from: 'a.bilivideo.com', to: 'b.mcdn.bilivideo.com' },
    ]);
  });

  it('多次切换逐一产出，顺序与事件顺序一致', () => {
    const events = buildTimeline([
      ev(10, 'seg-req', 'a'),
      ev(20, 'seg-req', 'b'),
      ev(30, 'seg-req', 'a'),
    ]).events;

    expect(detectSwitches(events)).toEqual([
      { t: 20, from: 'a', to: 'b' },
      { t: 30, from: 'b', to: 'a' },
    ]);
  });

  it('host 一直不变 → 无切换', () => {
    const events = buildTimeline([
      ev(10, 'seg-req', 'a.bilivideo.com'),
      ev(20, 'seg-req', 'a.bilivideo.com'),
    ]).events;

    expect(detectSwitches(events)).toEqual([]);
  });

  it('空输入 / 只有一条 seg-req → 空数组', () => {
    expect(detectSwitches([])).toEqual([]);
    expect(detectSwitches([ev(10, 'seg-req', 'a.bilivideo.com')])).toEqual([]);
  });

  it('没有 seg-req（只有别的阶段）→ 空数组', () => {
    expect(detectSwitches([ev(10, 'playurl-res', 'a'), ev(20, 'canplay')])).toEqual([]);
  });

  it('没有 host 的 seg-req 被跳过，且不把切换切断成两次', () => {
    const events = buildTimeline([
      ev(10, 'seg-req', 'a'),
      ev(20, 'seg-req'),
      ev(30, 'seg-req', 'a'),
    ]).events;

    expect(detectSwitches(events)).toEqual([]);
  });
});

/**
 * `pairSegments()`：把 `seg-req` / `seg-res` 按 host 各自 FIFO 配成对。
 *
 * ## 这一组守的是什么
 *
 * 真机截图里 B站 **同时**向两条线路发分片请求（竞速 / 预载），事件是交错的：
 *
 * ```text
 * 4.22s  seg-req  xy116…mcdn        ← 请求 A
 * 4.23s  seg-req  cn-zjih-ct-04-03  ← 请求 B
 * 4.39s  seg-res  xy116…mcdn        ← A 的返回
 * 4.97s  seg-res  cn-zjih-ct-04-03  ← B 的返回
 * ```
 *
 * 只要配对错了（例如"按出现顺序一对一"而不是"按 host 配对"），界面就会显示
 * `4.22s → 4.97s · 0.75s` 这种**根本不存在的耗时** —— 数字看着完全正常，
 * 却是错的。所以每一类边界都要有一条。
 */
describe('pairSegments：按 host 各自 FIFO 配对', () => {
  /** 造一条分片事件（可带 kind） */
  function seg(
    t: number,
    stage: 'seg-req' | 'seg-res',
    host: string,
    kind?: 'official' | 'pcdn',
  ): LoadEvent {
    return kind === undefined ? { t, stage, host } : { t, stage, host, kind };
  }

  it('正常配对：一条 req + 一条 res → doneAt / ms', () => {
    const pairs = pairSegments([seg(100, 'seg-req', 'a', 'official'), seg(250, 'seg-res', 'a')]);
    expect(pairs).toEqual([{ t: 100, doneAt: 250, ms: 150, host: 'a', kind: 'official' }]);
  });

  it('★ 两条线路交错：各自配各自的，绝不错配', () => {
    const pairs = pairSegments([
      seg(4220, 'seg-req', 'xy.mcdn.bilivideo.cn', 'pcdn'),
      seg(4230, 'seg-req', 'cn-zjih-ct-04-03.bilivideo.com', 'official'),
      seg(4390, 'seg-res', 'xy.mcdn.bilivideo.cn'),
      seg(4970, 'seg-res', 'cn-zjih-ct-04-03.bilivideo.com'),
    ]);

    expect(pairs.map((p) => [p.host, p.ms])).toEqual([
      ['xy.mcdn.bilivideo.cn', 170],
      ['cn-zjih-ct-04-03.bilivideo.com', 740],
    ]);
  });

  it('★ 同一 host 连续两条 req、只有一条 res → 配给**最早**那条', () => {
    const pairs = pairSegments([
      seg(100, 'seg-req', 'a'),
      seg(200, 'seg-req', 'a'),
      seg(300, 'seg-res', 'a'),
    ]);

    expect(pairs[0]).toMatchObject({ t: 100, doneAt: 300, ms: 200 });
    // 第二条还是"没等到返回"的状态
    expect(pairs[1]).toMatchObject({ t: 200, doneAt: null, ms: null });
  });

  it('只有 req 没有 res → 保留，doneAt / ms 为 null（不是错误，是没等到）', () => {
    const pairs = pairSegments([seg(100, 'seg-req', 'a', 'pcdn')]);
    expect(pairs).toEqual([{ t: 100, doneAt: null, ms: null, host: 'a', kind: 'pcdn' }]);
  });

  it('★ 只有 res 没有 req → 丢弃（对应请求在采集窗口外，不许凭空造一条）', () => {
    expect(pairSegments([seg(100, 'seg-res', 'a')])).toEqual([]);
  });

  it('没有 host 的事件不参与配对', () => {
    const pairs = pairSegments([
      { t: 10, stage: 'seg-req' },
      { t: 20, stage: 'seg-res' },
    ]);
    expect(pairs).toEqual([]);
  });

  it('别的阶段不参与（canplay / stall 之类）', () => {
    const pairs = pairSegments([
      ev(10, 'canplay'),
      seg(20, 'seg-req', 'a'),
      ev(30, 'stall'),
      seg(40, 'seg-res', 'a'),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.ms).toBe(20);
  });

  it('结果按**请求发出**的顺序，不是返回的顺序', () => {
    const pairs = pairSegments([
      seg(100, 'seg-req', 'slow'),
      seg(110, 'seg-req', 'fast'),
      seg(120, 'seg-res', 'fast'),
      seg(900, 'seg-res', 'slow'),
    ]);
    expect(pairs.map((p) => p.host)).toEqual(['slow', 'fast']);
  });

  it('kind 取自**请求**那一条（返回事件不带 kind 也能配对）', () => {
    const pairs = pairSegments([seg(100, 'seg-req', 'a', 'official'), seg(150, 'seg-res', 'a')]);
    expect(pairs[0]?.kind).toBe('official');
  });

  it('空输入 → 空数组', () => {
    expect(pairSegments([])).toEqual([]);
  });
});
