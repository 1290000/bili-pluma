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

/**
 * 视觉清理选项（ADR 0031 / 0032）。
 *
 * ## 为什么这里只做"存取"，不做校验
 *
 * 选项的**合法形状**定义在 `src/content/site-clean/clean-options.ts`
 * （`DEFAULT_CLEAN_OPTIONS` / `normalizeCleanOptions`）。
 * 本文件若再写一份默认值，两处必然漂移 —— `AGENTS.md` §6.1 的教训。
 *
 * 但 `platform/` 不能 import `content/`（依赖方向：content → platform 才合法）。
 * 所以这里**只返回原始对象**，收敛交给消费方调用 `normalizeCleanOptions()`。
 */
const CLEAN_OPTIONS_KEY = 'pluma:clean-options';

/** 供 content script 监听 `storage.onChanged` 时比对键名 */
export const CLEAN_OPTIONS_CHANGED_KEY = CLEAN_OPTIONS_KEY;

/** 读原始值（**未收敛**，消费方必须过一次 `normalizeCleanOptions`） */
export async function readRawCleanOptions(): Promise<unknown> {
  const bag = await chrome.storage.local
    .get(CLEAN_OPTIONS_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return bag[CLEAN_OPTIONS_KEY];
}

/** 写整份选项 */
export async function writeCleanOptions(options: Record<string, boolean>): Promise<void> {
  await chrome.storage.local.set({ [CLEAN_OPTIONS_KEY]: options });
}
