/**
 * `watchPlaybackQuality` 的行为测试（S3.1）
 *
 * 这段逻辑原先内联在 `entrypoints/content.ts` 里，**零测试**。
 * 下沉到 `src/content/isolated/` 并注入 `getVideo` 之后才第一次可测。
 *
 * 守三件事：
 *   1. 只在画质**变化**时上报（防日志被同一条刷满）
 *   2. 没有 video / videoHeight 为 0 时不上报
 *   3. 用**有限次** `setTimeout`，不用 `setInterval`
 *      （2026-10-25 "挂后台白屏"的根因之一就是持续定时器）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  QUALITY_SAMPLE_DELAYS_MS,
  watchPlaybackQuality,
  type QualityPayload,
} from '@/src/content/isolated/quality-watch';

describe('watchPlaybackQuality（S3.1 下沉后新增覆盖）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(heights: number[]) {
    const sent: QualityPayload[] = [];
    let i = 0;
    // 每次取 video 时返回列表里的下一个高度；用完了就一直返回最后一个
    const getVideo = () => {
      const h = heights[Math.min(i, heights.length - 1)];
      i += 1;
      return { videoHeight: h ?? 0 };
    };
    watchPlaybackQuality((p) => sent.push(p), getVideo);
    return { sent, advanceAll: () => vi.advanceTimersByTime(30000) };
  }

  it('画质变化时上报新高度', () => {
    const { sent, advanceAll } = setup([1080, 1080, 2160, 2160]);
    advanceAll();

    expect(sent.map((s) => s.height)).toEqual([1080, 2160]);
  });

  it('画质不变时不重复上报（防日志刷屏）', () => {
    const { sent, advanceAll } = setup([1080, 1080, 1080, 1080]);
    advanceAll();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.height).toBe(1080);
  });

  it('videoHeight 为 0 时不上报（播放器还没起来）', () => {
    const { sent, advanceAll } = setup([0, 0, 1080, 1080]);
    advanceAll();

    expect(sent.map((s) => s.height)).toEqual([1080]);
  });

  it('规则：采样点数量与 QUALITY_SAMPLE_DELAYS_MS 一致', () => {
    const { sent, advanceAll } = setup([100, 200, 300, 400]);
    advanceAll();
    expect(sent.length).toBeLessThanOrEqual(QUALITY_SAMPLE_DELAYS_MS.length);
  });

  it('用有限次 setTimeout，不是 setInterval（防"挂后台持续耗 CPU"）', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    setup([1080, 1080, 1080, 1080]);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(QUALITY_SAMPLE_DELAYS_MS.length);

    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it('到点后不再有新的定时器（跑完即止）', () => {
    const { advanceAll } = setup([1080, 1080, 1080, 1080]);
    advanceAll();
    // 再推进很久也不该有新的调度
    expect(vi.getTimerCount()).toBe(0);
  });
});
