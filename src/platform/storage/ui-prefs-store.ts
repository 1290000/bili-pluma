/**
 * 界面偏好（目前只有一个：页内角标开关）。
 *
 * ## 为什么单独一个文件
 *
 * 这个值有**两个读者**：设置页的「显示」分区（写）和 content script（读，
 * 决定要不要渲染角标）。放在 `platform/storage/` 是因为它是"落盘 + 跨环境共享"，
 * 和 `stats-store` / `health-store` 同一性质。
 *
 * ## 默认值必须是"开"
 *
 * 只有**显式存过 `false`** 才算关。用 `=== false` 而不是 `!value`，
 * 否则第一次安装（键不存在）会把角标当成关掉的 —— 用户会以为功能坏了。
 */

const BADGE_KEY = 'pluma:badge-enabled';

/** 供 content script 监听 `storage.onChanged` 时比对键名 */
export const BADGE_ENABLED_KEY = BADGE_KEY;

/** 角标是否显示。默认 `true`（见文件头注释） */
export async function readBadgeEnabled(): Promise<boolean> {
  const bag = await chrome.storage.local
    .get(BADGE_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return bag[BADGE_KEY] !== false;
}

export async function writeBadgeEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [BADGE_KEY]: enabled });
}
