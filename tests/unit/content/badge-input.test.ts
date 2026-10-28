/**
 * 角标输入的纯函数测试。
 *
 * 这两个坑都来自真机（2026-10-27 切画质时角标闪回「已接管」），
 * 但它们原先埋在 `entrypoints/content.ts` 的 350 行消息监听里，没有任何测试。
 * 抽出来的目的就是让它们**能被反向改红**（AGENTS.md §1.5）。
 */

import { describe, expect, it } from 'vitest';

import {
  applyHdrInput,
  describeHdrInput,
  describeHdrPlayback,
  describeTracks,
  type BadgeInputState,
} from '../../../src/content/isolated/badge-input';

function emptyState(): BadgeInputState {
  return {
    playingHeight: 0,
    videoFamily: '',
    audioFamily: '',
    frameRate: 0,
    videoDynamicRange: null,
    displayDynamicRange: null,
    hevcProfile: '',
  };
}

describe('applyHdrInput', () => {
  it('正常写入全部字段', () => {
    const s = emptyState();
    applyHdrInput(s, {
      h: 2160,
      w: 3840,
      family: 'HEVC',
      audioFamily: 'FLAC',
      profile: '2.4.L153.90',
      frameRate: 60,
      video: 'high',
      display: 'high',
    });

    expect(s.playingHeight).toBe(2160);
    expect(s.videoFamily).toBe('HEVC');
    expect(s.audioFamily).toBe('FLAC');
    expect(s.hevcProfile).toBe('2.4.L153.90');
    expect(s.frameRate).toBe(60);
    expect(s.videoDynamicRange).toBe(true);
    expect(s.displayDynamicRange).toBe(true);
  });

  /**
   * 回归：切画质瞬间主世界会连发多条 `hdr`，其中几条 `h` 是 0。
   * 无条件赋值会把 `playingHeight` 归零 → 角标闪回「已接管」。
   * 把 `if (nextH > 0)` 去掉，这条必须变红。
   */
  it('h 为 0 时保留原有高度，不清零', () => {
    const s = emptyState();
    applyHdrInput(s, { h: 2160, family: 'HEVC' });
    applyHdrInput(s, { h: 0, family: 'HEVC' });

    expect(s.playingHeight).toBe(2160);
  });

  it('h 缺失时同样保留原有高度', () => {
    const s = emptyState();
    applyHdrInput(s, { h: 1080 });
    applyHdrInput(s, {});

    expect(s.playingHeight).toBe(1080);
  });

  /**
   * `'?'` 是"读不到"，`'standard'` 才是"确认不是 HDR"。
   * 把三元退化成 `h.video === 'high'`（丢掉 standard 分支）不影响这条，
   * 但把 `'?'` 当成 false 会 —— 那会让角标断言"这不是 HDR"。
   */
  it("dynamic-range 的 '?' 映射成 null 而不是 false", () => {
    const s = emptyState();
    applyHdrInput(s, { video: '?', display: '?' });

    expect(s.videoDynamicRange).toBeNull();
    expect(s.displayDynamicRange).toBeNull();
  });

  it("dynamic-range 的 'standard' 映射成 false", () => {
    const s = emptyState();
    applyHdrInput(s, { video: 'standard', display: 'standard' });

    expect(s.videoDynamicRange).toBe(false);
    expect(s.displayDynamicRange).toBe(false);
  });

  it('frameRate 缺失时归零，不写 NaN', () => {
    const s = emptyState();
    // 主世界理论上不会发非数字，但消息来自页面侧，按不可信处理
    applyHdrInput(s, { h: 1080 });

    expect(s.frameRate).toBe(0);
  });
});

describe('describeHdrInput / describeHdrPlayback', () => {
  it('缺失字段用 ? 占位，不写 undefined', () => {
    const line = describeHdrInput({}, false);

    expect(line).toContain('h=0');
    expect(line).toContain('family=?');
    expect(line).toContain('dv=false');
    expect(line).not.toContain('undefined');
  });

  it('播放统计把缺失的 vsb/asb 当 0', () => {
    const line = describeHdrPlayback({ w: 3840, h: 2160 });

    expect(line).toContain('画面 3840x2160');
    expect(line).toContain('视频0/0');
    expect(line).not.toContain('undefined');
  });
});

describe('describeTracks', () => {
  it('列出视频/音频/FLAC/杜比/杜比视界', () => {
    const line = describeTracks({
      audio: [{ id: 30280, bw: 192000 }],
      video: [{ id: 80, h: 1080, codecid: 12, bw: 2000000 }],
      flac: { id: 30251, bw: 1500000, sampleRate: 96000 },
      dolby: [{ id: 30250, bw: 448000, type: 1 }],
      dolbyVision: true,
    });

    expect(line).toContain('1080p/cc12');
    expect(line).toContain('30280(192k)');
    expect(line).toContain('FLAC id=30251 1500k 96000Hz');
    expect(line).toContain('杜比=30250(448k)');
    expect(line).toContain('杜比视界=有');
  });

  it('没有 FLAC / 杜比时写「无」，不是空串', () => {
    const line = describeTracks({ video: [{ id: 80, h: 1080, codecid: 7, bw: 1 }] });

    expect(line).toContain('Hi-Res=无');
    expect(line).toContain('杜比=无');
    expect(line).toContain('杜比视界=无');
  });

  it('同一高度多个 codecid 去重后只列一次高度段', () => {
    const line = describeTracks({
      video: [
        { id: 80, h: 1080, codecid: 7, bw: 1 },
        { id: 80, h: 1080, codecid: 12, bw: 1 },
      ],
    });

    expect(line).toContain('1080p/cc7,1080p/cc12');
  });
});
