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
