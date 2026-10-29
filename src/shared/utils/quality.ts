/**
 * 画质标签 —— 分辨率 → 短语。
 *
 * ## 为什么放在 `shared/`
 *
 * 这段逻辑有两个使用者：页内角标（`src/content/isolated/badge-content.ts`）和
 * popup §2.3 的"主账号仅可用 X"（`src/core/playinfo/summary-view.ts`）。
 * 而 `core` **不许依赖** `content`（分层方向是 content → core），所以它只能待在 `shared`。
 *
 * 复制一份是最差的选择：这里的 8K / 4K 顺序曾经写反过（`height >= 2160` 排在
 * `height >= 4320` 前面，于是 4320p 被说成 4K，用户明确报过这个 bug）。
 * 两份实现意味着这个 bug 有机会只在一处复发。
 */

/**
 * 高度 → 画质短语。
 *
 * ⚠️ **8K 必须排在 4K 前面**（见文件头注释：写反过一次）。
 * ⚠️ 只接受**实际分辨率**，不接受 `accept_quality` 那类"视频支持的档位"数组。
 */
export function heightLabel(height: number): string {
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return '1080P';
  if (height >= 720) return '720P';
  if (height > 0) return `${String(height)}P`;
  return '';
}

/**
 * `quality id` → 短语。**只收真实观测到过的 id**，不凭文档补全。
 *
 * ## 为什么要有这张表（2026-10-29 加）
 *
 * `heightLabel()` 只能表达像素高度，而 B 站**在同一高度下分多个档**：
 *
 * | qid | 名称 | height | 真机观测 |
 * | --- | --- | --- | --- |
 * | 125 | HDR 真彩 | 1080 | ss34412，`dash.video[].id=125` + `support_formats` |
 * | 112 | 1080P 高码率 | 1080 | 同上，三条轨（AVC/AV1/HEVC） |
 * | 80 | 1080P 高清 | 1080 | 同上 |
 * | 64 | 720P 准高清 | 720 | 同上 |
 * | 32 | 480P 标清 | 480 | 同上 |
 * | 16 | 360P 流畅 | 360 | 同上 |
 * | 120 | 4K 超清 | 2160 | BV1jt421t7XH `dash.video[].id=120` |
 * | 116 | 1080P60 | 1080 | 同上 |
 * | 127 | 8K 超高清 | 4320 | 未观测到实轨，**只按 `accept_quality` 记录，不用于出徽章** |
 *
 * ## 纪律
 *
 * - **只用于"出徽章"和"写锚点"**，绝不用于判断"能不能拿到"——
 *   那个判据永远是 `dash.video[].height` / `id` 的**实际存在**
 * - 表里没有的 id → 返回空串，由调用方退回 `heightLabel(height)`
 * - `127`（8K）保留在表里但**标注未实测**：真出现 8K 轨时能正确显示名称，
 *   而不是靠 `heightLabel(4320)` 碰巧也对
 */
export const QUALITY_NAMES: Readonly<Record<number, string>> = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
};

/**
 * **值得做成徽章**的档位。比 `QUALITY_NAMES` 窄。
 *
 * ## 为什么单列一张表，而不是"全部照标"
 *
 * `Capability.topQualityIds` 现在收的是 dash 里**全部**真实 id
 * （那是数据层的如实描述），其中包含 `720P/480P/360P` 这些低档。
 * 全标出来会：
 *
 *   - 把 `MAX_BADGES`(6) 撑爆，把 `Hi-Res` / `60fps` 这类真正有信息量的挤掉
 *   - 让徽章区变成画质菜单的副本，用户看不出"哪个是重点"
 *
 * 所以展示层只保留**能体现"这个身份额外拿到了什么"的档**：
 * 8K / 杜比视界 / HDR / 4K / 1080P+。
 * 720 及以下不出徽章 —— 那些在 2026 年的 B 站，`accept_quality` 里谁都有。
 *
 * ## ⚠️ 2026-10-29 删掉了 `116`(1080P60) 与 `80`(1080P)（用户要求，B-09 后续）
 *
 * **两个删掉的理由不同，别混为一谈：**
 *
 * - **`116` 1080P60**：已被专门的帧数显示代替（popup 有 `60fps` 徽章，
 *   来自 `maxFrameRateAtTopHeight`）。同一件事标两遍，而且
 *   `1080P60` 这个名字和 `1080P+`（高码率）并排时，用户分不清哪个是"更多"。
 * - **`80` 1080P**：**不开大会员也能看**。它不是"这个身份额外拿到了什么"，
 *   标出来等于把"人人都有"说成"解锁成果"——正是本表要避免的事。
 *
 * ⚠️ 本节旧注释写着「1080P 在视频页要显示（那是主账号基线的对比锚点）」，
 * **那句话已作废**：对比锚点走的是 `anchorText()` → `heightLabel(cap.maxHeight)`
 * （`core/playinfo/summary-view.ts:182`），**不经过本表**，所以删掉 `80` 不影响锚点。
 *
 * ## 这张表不区分页面
 *
 * 视频页 / PGC 页的差异由 `summary-view.ts` 的 `PGC_HIDDEN_BADGES` 负责。
 */
export const BADGE_QUALITY_NAMES: Readonly<Record<number, string>> = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  112: '1080P+',
};

/**
 * 一组 `quality id` → 徽章短语。
 *
 * ## 为什么返回数组而不是一个字符串
 *
 * 同一高度可能有多个互不包含的档（`125` HDR / `120` 4K / `112` 1080P+
 * 在真机上会同时出现），用户能分别选，所以要分开标。
 *
 * ## 排序：**按 id 降序**（B 站自己的档位顺序）
 *
 * 不用"分辨率降序"——125/112/80 分辨率可能相同，用分辨率排不出稳定顺序。
 * 而 id 降序在真机上就是用户在画质菜单里看到的顺序。
 *
 * @param ids     `Capability.topQualityIds`（可能是全集，含低档）
 * @param maxHeight  只在 `ids` 一个可用档都没有时用于兜底
 * @returns 去重后的徽章数组
 */
export function qualityLabels(ids: readonly number[], maxHeight: number): string[] {
  if (ids.length === 0) {
    const fallback = heightLabel(maxHeight);
    return fallback ? [fallback] : [];
  }

  // 自己排序，不信任调用方（见下方注释）
  const sorted = [...ids].sort((a, b) => b - a);

  const out: string[] = [];
  for (const id of sorted) {
    const name = BADGE_QUALITY_NAMES[id];
    if (name && !out.includes(name)) out.push(name);
  }

  /**
   * 一个可做徽章的档都没有（比如只有 720/480，或 id 全是表外的）
   * → 退回高度标签，**不猜档位、也不让徽章区空着**。
   */
  if (out.length === 0) {
    const fallback = heightLabel(maxHeight);
    return fallback ? [fallback] : [];
  }
  return out;
}
