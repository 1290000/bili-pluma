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

/**
 * 写整份清理偏好。
 *
 * ## ⚠️ 两个写入函数，形状不同，**不能混用**（2026-10-31 verifier 指出）
 *
 * 存储容器是 `{ options: {...}, hideCategories: [...] }`，
 * 而 `normalizeCleanPreferences()` 按 `bag.options ?? bag` 读布尔项、
 * 按 `bag.hideCategories` 读分类集合。
 *
 * 曾经只有一个 `writeCleanOptions(options: Record<string, boolean>)`，
 * 它写进去的是**扁平**形状（`{adDebug:false, ...}`）——
 * 用它写分类会**把 `hideCategories` 整个丢掉**：
 *
 * - `normalizeCleanPreferences` 走 `bag.options ?? bag` 取默认值 → 布尔项读不到
 * - `bag.hideCategories` 得到 `[]` → **用户勾了分类等于没勾**
 *
 * 而且这个 bug 在两侧都验不出来：离线 jsdom 不碰 storage；
 * 真机手工写 storage 时是自己构造的形状，天然正确。
 *
 * 所以现在拆成两个函数，**写哪半就调哪个**，不要合成一个。
 */

/** 只写布尔选项（保留已有的 hideCategories） */
export async function writeCleanOptionFlags(options: Record<string, boolean>): Promise<void> {
  const bag = await chrome.storage.local
    .get(CLEAN_OPTIONS_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  const raw = bag[CLEAN_OPTIONS_KEY] as Record<string, unknown> | undefined;
  const prevCats = Array.isArray(raw?.hideCategories) ? raw.hideCategories : [];
  await chrome.storage.local.set({
    [CLEAN_OPTIONS_KEY]: { options, hideCategories: prevCats },
  });
}

/**
 * 取"现有布尔选项"，形状非法时回退空对象。
 *
 * ## ⚠️ 必须排除数组（2026-10-31 verifier 实测）
 *
 * 原写法是 `raw?.options && typeof raw.options === 'object' ? ... : (raw ?? {})`，
 * 有两个漏洞：
 *
 *   1. **`raw` 是字符串/数字时被原样透传** —— 存储值若被外部写成 `"garbage"` / `42`，
 *      写回时 `options` 就是字符串/数字而不是对象。
 *   2. **`typeof [] === 'object'`** —— 数组会被误判成合法对象
 *      （verifier 的用例里 `[]` 之所以"通过"正是这个误判）。
 *
 * 影响面实测（verifier）：分类仍能读回、布尔项回退默认值（不损坏）、
 * 下次拨开关即自愈。**不阻塞**，但形状本来就该收窄。
 */
function pickExistingOptions(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const bag = raw as Record<string, unknown>;
  const inner = bag.options;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, boolean>;
  }
  return bag as Record<string, boolean>;
}

/** 只写分类集合（保留已有的布尔选项） */
export async function writeCleanHideCategories(categories: string[]): Promise<void> {
  const bag = await chrome.storage.local
    .get(CLEAN_OPTIONS_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  const prevOptions = pickExistingOptions(bag[CLEAN_OPTIONS_KEY]);
  await chrome.storage.local.set({
    [CLEAN_OPTIONS_KEY]: { options: prevOptions, hideCategories: categories },
  });
}

/** 写整份偏好（设置页"恢复默认"用） */
export async function writeCleanPreferences(prefs: {
  options: Record<string, boolean>;
  hideCategories: string[];
}): Promise<void> {
  await chrome.storage.local.set({
    [CLEAN_OPTIONS_KEY]: { options: prefs.options, hideCategories: prefs.hideCategories },
  });
}
