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

  /**
   * **dash 里出现过的、有意义的所有 `quality id`**（降序去重）。
   *
   * ## 演进史（两次都栽在"想用高度去收敛"上）
   *
   * | 版本 | 做法 | 真机暴露的问题 |
   * | --- | --- | --- |
   * | v1 | 只收 `height === maxHeight` 的轨 | 4K 视频里 `112`(1080P+) 明明能选，却没标（用户当场问「怎么不显示 1080P+」） |
   * | v2 | 每个高度取最高 id | 2160 档里 `125`(HDR) 和 `120`(4K) **同高**，取最大把 `120` 丢了 → **4K 徽章消失** |
   * | v3 | **全部收，按 id 降序**，由 UI 层决定显示哪些 | —— |
   *
   * **教训：`height` 不能用来做"档位优先级"的判断。** 同一高度下有多个互不包含的档
   * （HDR / 4K / 1080P+ 都是独立的、用户能分别选的东西），任何"每个高度只留一个"
   * 的收敛都会丢掉真实存在的选项。
   *
   * ## 那低档（720/480/360）怎么办
   *
   * 它们也收进来，但**由 UI 层的 `MAX_BADGES` 和 PGC 的 `PGC_HIDDEN_BADGES` 处理**。
   * 收全的原因：`capability` 是**数据层**，它该如实描述"拿到了什么"；
   * "哪些值得显示"是展示决策，属于 `summary-view.ts`。
   * 把展示偏好塞进数据层，就会出现 v1/v2 那种"数据为了 UI 好看而被裁剪"的错误。
   *
   * 排序按 id 降序 = B 站画质菜单的顺序。
   */
  const idSet = new Set<number>();
  for (const t of withHeight) {
    if (t.id > 0) idSet.add(t.id);
  }
  const topQualityIds = [...idSet].sort((a, b) => b - a);

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
    topQualityIds,
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
