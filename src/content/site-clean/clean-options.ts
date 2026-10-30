/**
 * 页内视觉清理的**选项定义** —— 单一真相源。
 *
 * ## 为什么单独一个文件（2026-10-31，M3 教训）
 *
 * 第一版 M3 只搬了"选择器"，把上游的**选项表**整个丢了，结果：
 *   - 用户无法保留活动横幅 / 动态商品推荐
 *   - 没有占位文本、没有调试模式
 *   - 最严重的是**连 body 类名机制都没有**，选项即使加上也没有消费方
 *
 * 上游一个功能组件 = **选择器 + 选项表 + body 类名机制 + 布局补偿** 四层。
 * 只搬第一层的结果是"看起来做了，实际残缺"，比不做更糟。
 *
 * 本文件定义第 2 层（选项表）。第 3 层（body 类名）见 `body-classes.ts`，
 * 第 1、4 层（选择器与布局补偿）见 `ads-css.ts`。
 *
 * ## 选项来源
 *
 * 除特别注明外，全部取自 Bilibili-Evolved `utils/remove-promotions/index.ts`
 * 的 `options`（MIT，见仓库根 `NOTICE.md`）。`displayName` 保持上游原措辞，
 * 因为用户已经熟悉那套说法。
 *
 * **首页分类不来自上游**：上游那份 37 项清单在当前 B站 没有实测依据
 * （独立验证者指出分母本身不可信）。分类清单见 `home-selectors.ts`，
 * 来源是滚动 80 步的实测结果。
 */

import { isObservedCategory } from './home-selectors';

/** 所有清理选项的键 —— 用于类型安全地遍历 */
export const CLEAN_OPTION_KEYS = [
  'adPreserveEventBanner',
  'adPreserveFeedGoods',
  'adShowPlaceholder',
  'adHideContainer',
  'adDebug',
  /** 隐藏顶部大图推荐位（首页净化） */
  'homeHideSwipe',
] as const;

export type CleanOptionKey = (typeof CLEAN_OPTION_KEYS)[number];

/**
 * 布尔选项集合。
 *
 * ⚠️ **分类隐藏不在这里** —— 它是个多选集合，不是布尔。
 * 分类放在 `CleanPreferences.hideCategories`（见文件后半部分），
 * 因为把"集合"硬塞进 `Record<string, boolean>` 会让 UI 与存储都变形。
 */
export type CleanOptions = Record<CleanOptionKey, boolean>;

/**
 * 默认值。
 *
 * ⚠️ **`adPreserveEventBanner` / `adPreserveFeedGoods` 默认 `false`** ——
 * 与上游一致：默认是"删掉"。用户想保留才去勾。
 * 反过来（默认保留）会让"删除广告"这个功能名不副实。
 */
export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
  adPreserveEventBanner: false,
  adPreserveFeedGoods: false,
  /** 占位文本：显示「🚫已屏蔽广告」，让用户知道这里原本有广告、是被插件挡掉的 */
  adShowPlaceholder: true,
  /** 完全隐藏：true = 卡片不占位；false = 保留空位（上游的"自定义"态） */
  adHideContainer: true,
  /** 调试：不隐藏、加红框高亮。用于确认选择器命中情况 */
  adDebug: false,
  /**
   * 隐藏首页顶部大图推荐位 —— **默认 `false`**。
   *
   * 它占 473px 高，是首页最显眼的位置之一，但**那是内容推荐不是广告**。
   * 默认隐藏会改变用户的信息流，属于"用户没要求却被改"——本项目的原则是不做这种事。
   */
  homeHideSwipe: false,
};

/** 每个选项的展示信息 —— 设置页直接消费，不要在 UI 里另写一份文案 */
export interface CleanOptionMeta {
  key: CleanOptionKey;
  /** 开关标题（上游原措辞） */
  label: string;
  /** 一句话说明，说明"打开之后会发生什么" */
  hint: string;
}

export const CLEAN_OPTION_META: readonly CleanOptionMeta[] = [
  {
    key: 'adPreserveEventBanner',
    label: '保留活动横幅',
    hint: '关闭时活动横幅会被隐藏。想保留促销活动入口就打开',
  },
  {
    key: 'adPreserveFeedGoods',
    label: '保留动态商品推荐',
    hint: '关闭时动态里的商品推荐卡会被隐藏',
  },
  {
    key: 'adShowPlaceholder',
    label: '显示占位文本',
    hint: '被屏蔽的广告位显示「🚫已屏蔽广告」，而不是留一片空白',
  },
  {
    key: 'adHideContainer',
    label: '完全隐藏',
    hint: '打开则整块广告位不占位；关闭则保留空位（版面变化最小）',
  },
  {
    key: 'adDebug',
    label: '调试模式',
    hint: '不隐藏广告，改为红框标出命中的元素。排查选择器是否失效时用',
  },
  {
    key: 'homeHideSwipe',
    label: '隐藏顶部大图推荐',
    hint: '首页顶部那块大图（约 473px 高）。默认不隐藏——它是内容推荐不是广告',
  },
];

/**
 * 把 storage 里的原始值收敛成合法选项。
 *
 * **必须做白名单收敛**：`storage.local` 可被改成任意形状，
 * 直接信任会让 `undefined` 一路传到 `classList.toggle` 变成 `"undefined"` 类名。
 */
export function normalizeCleanOptions(raw: unknown): CleanOptions {
  const out = { ...DEFAULT_CLEAN_OPTIONS };
  if (!raw || typeof raw !== 'object') return out;
  const bag = raw as Record<string, unknown>;
  for (const key of CLEAN_OPTION_KEYS) {
    const v = bag[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

// ─────────────────────────── 首页分类（多选） ───────────────────────────

/**
 * 首页净化偏好 —— 布尔选项 + 分类集合。
 *
 * ## 为什么分类单独一个字段
 *
 * 分类是**多选集合**（用户可能想隐藏"番剧+电影+电视剧"），
 * 塞进 `Record<string, boolean>` 会让"有哪些分类"和"哪些被选中"混成一件事，
 * UI 端要从键名反推分类，必然出错。
 *
 * 所以：布尔项走 `CleanOptions`，分类走 `hideCategories: string[]`。
 */
export interface CleanPreferences {
  options: CleanOptions;
  /** 要隐藏的首页分类（来自 `OBSERVED_CATEGORIES`，白名单过滤） */
  hideCategories: string[];
}

export const DEFAULT_CLEAN_PREFERENCES: CleanPreferences = {
  options: { ...DEFAULT_CLEAN_OPTIONS },
  /** 默认**全不隐藏** —— 上游默认全开，等于替用户砍掉 9 类内容，本项目不做这事 */
  hideCategories: [],
};

/**
 * 收敛整份偏好（布尔项 + 分类集合）。
 *
 * 分类**必须**经 `isObservedCategory` 白名单：
 * - 防止 storage 被塞入任意字符串后拼进 CSS 选择器
 * - 防止 B站 已经不存在的分类残留在设置里，让用户以为它还在起作用
 */
export function normalizeCleanPreferences(raw: unknown): CleanPreferences {
  if (!raw || typeof raw !== 'object') {
    return { options: { ...DEFAULT_CLEAN_OPTIONS }, hideCategories: [] };
  }
  const bag = raw as Record<string, unknown>;
  const options = normalizeCleanOptions(bag.options ?? bag);
  const rawCats = Array.isArray(bag.hideCategories) ? bag.hideCategories : [];
  const hideCategories = [
    ...new Set(
      rawCats.filter((c): c is string => typeof c === 'string').filter(isObservedCategory),
    ),
  ];
  return { options, hideCategories };
}
