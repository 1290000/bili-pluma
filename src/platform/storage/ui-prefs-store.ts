/**
 * 界面偏好（页内角标开关、页内侧栏面板入口开关）。
 *
 * ## 为什么单独一个文件
 *
 * 这些值有**多个读者**：popup / 设置页（写）和 content script（读，
 * 决定要不要渲染）。放在 `platform/storage/` 是因为它是"落盘 + 跨环境共享"，
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
 * 页内侧栏面板入口（左侧贴边条）的开关 —— ADR 0033 决定三。
 *
 * ## 为什么与角标开关分成两个键，而不是共用一个"页内控件"开关
 *
 * 两者回答的是不同问题：角标是**状态回显**（"现在画质是多少"），
 * 面板是**操作入口**（"我要改设置"）。用户完全可能想留面板、讨厌角标，
 * 或反之。合成一个键就得二选一，那是把两个偏好硬绑在一起。
 *
 * ## 默认值同样是"开"
 *
 * 理由与角标完全相同：面板是 1.1.0 的主操作界面，第一次安装若被当成关掉的，
 * 用户会以为功能没做出来。所以仍然是 `!== false` 语义。
 */
const PANEL_ENTRY_KEY = 'pluma:panel-entry-enabled';

/** 供 content script 监听 `storage.onChanged` 时比对键名 */
export const PANEL_ENTRY_ENABLED_KEY = PANEL_ENTRY_KEY;

/** 页内悬浮入口是否显示。默认 `true` */
export async function readPanelEntryEnabled(): Promise<boolean> {
  const bag = await chrome.storage.local
    .get(PANEL_ENTRY_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return bag[PANEL_ENTRY_KEY] !== false;
}

export async function writePanelEntryEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [PANEL_ENTRY_KEY]: enabled });
}

/**
 * ## ❌ 这里**曾有** `pluma:feed-boundary-enabled`（2026-11-11 删除）
 *
 * 它控制"首页推荐流来源分界线"显不显示。那条线**整体不再做**：
 *
 * | 阶段 | 状态 |
 * | --- | --- |
 * | 原设计 | 在第 10 个 `.is-rcmd` 卡后插一条线，说明"以下来自取流账号" |
 * | 第二阶段（缺陷） | 锚点判据无几何过滤 → 第 10 个可能是 `height=0` 骨架卡 → 线落在首页顶部 → **陈述错误事实** |
 * | 第三阶段（用户裁决） | **不做分界线**。设完取流账号后直接隐藏 `.feed-card`，首屏就是取流账号的，线没有意义 |
 * | 现在 | 隐藏方案也因**选择器与身份两层都未验证**（父子嵌套 / M1）而冻结 |
 *
 * **所以这个键、它的读写函数、面板上的开关全部删除。**
 *
 * ⚠️ **删的理由不是"没用了"，是"留着会制造三个错误印象"**：
 *   1. 存储里有个键，但**永远没有 UI 会去写它**
 *   2. 有测试在为**一个已取消的功能**守默认值
 *   3. 下一个人看到它，会以为"分界线还在做，只是默认关"
 *
 * 🔗 **判据本身没有丢**：`src/core/feed-identity/` 保留了
 * `resolveFeedIdentity` / `shouldSwitchFeed` ——
 * 那套「取流账号是否真的 ≠ 页面账号」的六态判据，正是任何
 * "按身份做条件渲染"的功能都要用的东西。
 */
/**
 * 首页推荐流「使用取流账号」开关（2026-11-11，用户最终需求）。
 *
 * ## 它与取流身份**完全独立**
 *
 * 用户原话：「首页推荐流的变化与取流身份是完全独立的两个功能」。
 *
 * | 开关 | 管什么 | 依赖 |
 * | --- | --- | --- |
 * | 取流身份（`pluma:streaming-identity`） | playurl 族用谁的凭据 | vault 有凭据 |
 * | **本开关**（`pluma:feed-account-enabled`） | **首页推荐流用谁的凭据** | vault 有凭据 |
 *
 * **改一个不影响另一个。** 所以本键**绝不能**被当成取流身份的派生值，
 * 也不能在切取流身份时顺带清掉。
 *
 * ## 默认 `false`
 *
 * 这是**新增功能**，默认关闭。用户不主动打开就保持原样（全是浏览器账号的推荐）。
 * 语义是 `=== true`。
 *
 * ## 可点性由 `hasCredential` 决定（**不是**本键）
 *
 * 没有扫码登录扩展账号时，面板上的开关应灰掉点不动 ——
 * 那个判据读的是 `proxy/status.hasCredential`，与存储里这个布尔无关。
 * 本键只记录"用户希望它是开的"，**能不能开由凭据决定**。
 */
const FEED_ACCOUNT_KEY = 'pluma:feed-account-enabled';

/** 供 content script 监听 `storage.onChanged` 时比对键名 */
export const FEED_ACCOUNT_ENABLED_KEY = FEED_ACCOUNT_KEY;

/** 首页推荐流是否使用取流账号。默认 `false` */
export async function readFeedAccountEnabled(): Promise<boolean> {
  const bag = await chrome.storage.local
    .get(FEED_ACCOUNT_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return bag[FEED_ACCOUNT_KEY] === true;
}

export async function writeFeedAccountEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [FEED_ACCOUNT_KEY]: enabled });
}

/**
 * 候选过滤开关（ADR 0038）—— 从取流的候选 URL 里剔除 PCDN。
 *
 * ## 为什么放在本文件（它其实不是"界面偏好"）
 *
 * 形态与 `FEED_ACCOUNT_ENABLED_KEY` 完全相同：布尔、**默认 `false`**、
 * content 侧读 + 设置页写、content 侧监听变化。为它单开一个 store 文件只是
 * 把同一套五行代码换个地方放。⚠️ 但它改的是**取流行为**（会改写响应体的
 * `dash[].base_url` / `backup_url`），不是"页面长什么样" —— 所以：
 *
 * - **默认必须是 `false`**（`=== true` 语义），fail-closed。这是新增能力，
 *   用户不主动打开就保持原样；打开后改的是服务端下发的候选，属于"只减不增"
 *   的减法（ADR 0038）。
 * - 它的判据在 `core/cdn/filter.ts`，**不在本文件**：这里只存"用户想不想开"。
 *
 * ## 为什么要能被 `storage.onChanged` 热更新
 *
 * 关掉开关后刷新页面，主世界若还按旧值过滤，用户会看到"开关关了 PCDN 还在变少"
 * 或者反过来 —— 与 ADR 0028 那次「关开关后画质不回落」同类。所以
 * `content.ts` 监听本键并**重发一次 `cfg`**（不是靠"刷新生效"）。
 */
const PCDN_FILTER_KEY = 'pluma:pcdn-filter-enabled';

/** 供 content script 监听 `storage.onChanged` 时比对键名 */
export const PCDN_FILTER_ENABLED_KEY = PCDN_FILTER_KEY;

/** 是否剔除 PCDN 候选。默认 `false`（新增能力，用户不打开就不改行为） */
export async function readPcdnFilterEnabled(): Promise<boolean> {
  const bag = await chrome.storage.local
    .get(PCDN_FILTER_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return bag[PCDN_FILTER_KEY] === true;
}

export async function writePcdnFilterEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [PCDN_FILTER_KEY]: enabled });
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
