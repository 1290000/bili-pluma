import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parsePlayurl } from '@core/playinfo/parse';
import { capabilityOf, diffCapability } from '@core/playinfo/rank';

/**
 * 守的是"对比结论不许编"。
 *
 * 两个最容易犯的错：
 *   1. 用 `acceptQuality` 算能力 → 未登录也会得出"有 4K"
 *   2. 任一侧拿不到数据时用单边顶替 → 用户看到"主账号也是 4K"，功能等于白做
 *
 * fixture 来源见 `parse.test.ts` 顶部注释（真实观测值转录 + 一个结构边界样本）。
 */

function load(name: string): unknown {
  const url = new URL(`../../../fixtures/playinfo/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

const playback = capabilityOf(parsePlayurl(load('playback-4k.json')));
const guest = capabilityOf(parsePlayurl(load('guest-480p.json')));

describe('capabilityOf：真实样本', () => {
  it('播放账号：2160p / 120fps / Hi-Res / 杜比全景声', () => {
    expect(playback).not.toBeNull();
    expect(playback?.maxHeight).toBe(2160);
    expect(playback?.maxFrameRate).toBe(120);
    expect(playback?.maxFrameRateAtTopHeight).toBe(120);
    expect(playback?.hasHiRes).toBe(true);
    expect(playback?.hasDolbyAudio).toBe(true);
    expect(playback?.providesDolbyVision).toBe(false);
  });

  it('播放账号：topTrack 是同高度里码率最大的那条', () => {
    // 2160p 有四条变体，最高码率 17.5Mbps 是 AV1(codecid 12)
    expect(playback?.topTrack?.bandwidth).toBe(17500000);
    expect(playback?.topTrack?.codecid).toBe(12);
    expect(playback?.videoCount).toBe(9);
  });

  it('未登录：480p / 30fps / 无 Hi-Res / 无杜比', () => {
    expect(guest?.maxHeight).toBe(480);
    expect(guest?.maxFrameRate).toBe(30);
    expect(guest?.hasHiRes).toBe(false);
    expect(guest?.hasDolbyAudio).toBe(false);
  });

  it('未登录的 acceptQuality 里有 8K，但能力只看 dash —— 不得受影响', () => {
    const info = parsePlayurl(load('guest-480p.json'));
    expect(info?.acceptQuality).toContain(127);
    expect(guest?.maxHeight).toBe(480);
  });
});

describe('capabilityOf：拿不到数据时返回 null（不是全 0）', () => {
  it('null 输入 → null', () => {
    expect(capabilityOf(null)).toBeNull();
  });

  it('只有 durl 的番剧响应 → null', () => {
    expect(capabilityOf(parsePlayurl(load('durl-only.json')))).toBeNull();
  });

  it('dash 存在但没有视频轨 → null', () => {
    expect(capabilityOf(parsePlayurl({ data: { dash: { video: [] } } }))).toBeNull();
  });

  it('视频轨全都没有高度 → null', () => {
    const info = parsePlayurl({ data: { dash: { video: [{ id: 120, base_url: 'x' }] } } });
    expect(capabilityOf(info)).toBeNull();
  });
});

describe('maxFrameRate 与 maxFrameRateAtTopHeight 是两个量', () => {
  it('1080p120 + 2160p60：全轨最高 120，但 4K 只有 60', () => {
    const info = parsePlayurl({
      data: {
        dash: {
          video: [
            { id: 120, height: 2160, frame_rate: '60.000', bandwidth: 5000000 },
            { id: 116, height: 1080, frame_rate: '120.000', bandwidth: 3000000 },
          ],
        },
      },
    });
    const cap = capabilityOf(info);
    expect(cap?.maxFrameRate).toBe(120);
    // 要回答"4K 能不能 60fps"，只能用这个
    expect(cap?.maxFrameRateAtTopHeight).toBe(60);
  });
});

describe('diffCapability：真实对比', () => {
  it('未登录 → 播放账号：涨 1680 像素 + 90fps + Hi-Res + 杜比', () => {
    const diff = diffCapability(guest, playback);
    expect(diff).not.toBeNull();
    expect(diff?.heightGain).toBe(1680);
    expect(diff?.frameRateGain).toBe(90);
    expect(diff?.hiResGained).toBe(true);
    expect(diff?.dolbyAudioGained).toBe(true);
    expect(diff?.dolbyVisionGained).toBe(false);
    expect(diff?.improved).toBe(true);
  });

  it('任一侧为 null → null（不许用单边数据假装对比）', () => {
    expect(diffCapability(null, playback)).toBeNull();
    expect(diffCapability(guest, null)).toBeNull();
    expect(diffCapability(null, null)).toBeNull();
  });

  it('反着比：播放账号更弱 → improved 为 false，heightGain 为负', () => {
    const diff = diffCapability(playback, guest);
    expect(diff?.heightGain).toBe(-1680);
    expect(diff?.improved).toBe(false);
    expect(diff?.hiResGained).toBe(false);
  });

  it('两边完全一样 → improved 为 false', () => {
    const diff = diffCapability(playback, playback);
    expect(diff).toEqual({
      heightGain: 0,
      frameRateGain: 0,
      hiResGained: false,
      dolbyAudioGained: false,
      dolbyVisionGained: false,
      improved: false,
    });
  });

  it('高度帧率都相同、只多了 Hi-Res → 仍算有提升', () => {
    const plain = capabilityOf(
      parsePlayurl({
        data: { dash: { video: [{ id: 80, height: 1080, frame_rate: '60.000' }], flac: null } },
      }),
    );
    const withFlac = capabilityOf(
      parsePlayurl({
        data: {
          dash: {
            video: [{ id: 80, height: 1080, frame_rate: '60.000' }],
            flac: { audio: { id: 30251, bandwidth: 1500000 } },
          },
        },
      }),
    );

    const diff = diffCapability(plain, withFlac);
    expect(diff?.heightGain).toBe(0);
    expect(diff?.frameRateGain).toBe(0);
    expect(diff?.hiResGained).toBe(true);
    expect(diff?.improved).toBe(true);
  });
});
