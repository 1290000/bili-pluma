/**
 * 把 `PlayInfo` 归纳成"能力"，并比较两个身份的能力差异。
 *
 * 分层：`core/` 纯函数，零 IO。用于 popup §2.3 的"已解锁 / 主账号仅可用 X"
 * 与 options 画质体检表。
 *
 * ## 判据纪律（比代码本身更重要）
 *
 * 只用 `dash` 里的轨道字段。**不用 `acceptQuality`** —— 未登录时它返回含 8K 的假数组
 * （`poc/verify/RESULT.md` §四），拿它算"能力"会得出"主账号也有 4K"的荒谬结论。
 *
 * **不从 quality id 反推动态范围。** HDR 无可靠判据，已从产品里砍掉
 * （`docs/decisions/0014-quality-compare-from-page-data.md`）。杜比视界只用服务端布尔值，
 * 且语义是"本视频**提供**"。
 */

import type { Capability, CapabilityDiff, PlayInfo, VideoTrack } from '@shared/types/playinfo';

export type { Capability, CapabilityDiff } from '@shared/types/playinfo';

/**
 * 归纳能力。
 *
 * @returns `null` 表示**无法判断**（没有 dash / 没有带高度的视频轨）。
 *
 * ⚠️ 这里返回 `null` 而不是"全 0 的能力对象"是有意的：
 * `null` = 不知道，全 0 = 确认什么都没有。UI 必须区别对待，
 * 否则"页面还没加载完"会被画成"这个账号拿不到任何画质"。
 */
export function capabilityOf(info: PlayInfo | null): Capability | null {
  const dash = info?.dash;
  if (!dash) return null;

  const withHeight = dash.video.filter((t) => t.height > 0);
  if (withHeight.length === 0) return null;

  let maxHeight = 0;
  for (const t of withHeight) if (t.height > maxHeight) maxHeight = t.height;

  let topTrack: VideoTrack | null = null;
  for (const t of withHeight) {
    if (t.height !== maxHeight) continue;
    // 同高度取码率更大的那条：它是"这一档的主轨"，其余多是编码变体
    if (!topTrack || t.bandwidth > topTrack.bandwidth) topTrack = t;
  }

  let maxFrameRate = 0;
  for (const t of withHeight) if (t.frameRate > maxFrameRate) maxFrameRate = t.frameRate;

  let maxFrameRateAtTopHeight = 0;
  for (const t of withHeight) {
    if (t.height !== maxHeight) continue;
    if (t.frameRate > maxFrameRateAtTopHeight) maxFrameRateAtTopHeight = t.frameRate;
  }

  return {
    maxHeight,
    maxFrameRate,
    maxFrameRateAtTopHeight,
    hasHiRes: dash.flacAudio !== null,
    hasDolbyAudio: dash.dolbyAudio.length > 0,
    providesDolbyVision: dash.dolbyVision,
    topTrack,
    videoCount: dash.video.length,
    audioCount: dash.audio.length,
  };
}

/**
 * 比较两个身份的能力。
 *
 * @returns `null` 表示**无法比较**（任一侧是 `null`）。
 * 此时 UI 必须显示"未知"，不许用单边数据假装对比 —— 那正是"主账号也有 4K"那类谎报的来源。
 */
export function diffCapability(
  primary: Capability | null,
  playback: Capability | null,
): CapabilityDiff | null {
  if (!primary || !playback) return null;

  const heightGain = playback.maxHeight - primary.maxHeight;
  const frameRateGain = playback.maxFrameRate - primary.maxFrameRate;
  const hiResGained = playback.hasHiRes && !primary.hasHiRes;
  const dolbyAudioGained = playback.hasDolbyAudio && !primary.hasDolbyAudio;
  const dolbyVisionGained = playback.providesDolbyVision && !primary.providesDolbyVision;

  return {
    heightGain,
    frameRateGain,
    hiResGained,
    dolbyAudioGained,
    dolbyVisionGained,
    improved:
      heightGain > 0 || frameRateGain > 0 || hiResGained || dolbyAudioGained || dolbyVisionGained,
  };
}
