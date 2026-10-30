/**
 * 首页净化 —— 按实测重做（ADR 0031）。
 *
 * ## 与广告清理的分工
 *
 * | 模块 | 管什么 | 判据 |
 * | --- | --- | --- |
 * | `ads.ts` | **广告**（链接指向 `cm.bilibili.com`） | 商业推广 |
 * | **本文件** | **专题推荐位**（`.floor-single-card` 的 `.badge` 分类） | 内容推荐，不是广告 |
 *
 * 两者都作用于首页，但语义不同：广告是"不该出现的内容"，
 * 分类推荐是"用户可能不想要的内容"。因此分类**默认全不隐藏**。
 *
 * ## 为什么 JS + CSS 两层
 *
 * 分类只能靠 `.badge` 的**文本**判断（B站 的卡片本身不带分类标识），
 * CSS 无法按文本选中元素。所以：
 *   - **JS**：读 badge 文本 → 打 `data-pluma-cat="番剧"` 标记
 *   - **CSS**：按 `hideCategories` 生成 `[data-pluma-cat="番剧"] { display:none }`
 *
 * 隐藏用 `display:none` 而非删节点：不干扰 B站 自己的分页计数。
 *
 * ## 分类清单的来源
 *
 * 见 `home-selectors.ts` 文件头：**实测**（滚动 80 步、448 张卡片、两个独立 session）。
 * **不要**改回上游那份 37 项清单。
 */

import type { CleanPreferences } from './clean-options';
import {
  CATEGORY_MARK_ATTR,
  FEED_CONTAINER_SELECTOR,
  FLOOR_CARD_SELECTOR,
  HOME_CLEAN_STYLE_ID,
  isObservedCategory,
  SWIPE_SELECTOR,
} from './home-selectors';

/**
 * 给专题推荐位打上分类标记。
 *
 * 只读 `.badge` 文本、只写 `data-pluma-cat`，**不删除任何节点**。
 *
 * @returns 本次新标记的卡片数
 */
export function markCategoryCards(doc: Document = document): number {
  let marked = 0;
  for (const card of doc.querySelectorAll<HTMLElement>(FLOOR_CARD_SELECTOR)) {
    const badge = card.querySelector('.badge')?.textContent?.trim();
    if (!isObservedCategory(badge)) continue;
    if (card.getAttribute(CATEGORY_MARK_ATTR) === badge) continue;
    card.setAttribute(CATEGORY_MARK_ATTR, badge);
    marked += 1;
  }
  return marked;
}

/**
 * 生成首页净化样式。
 *
 * ## 分类值只从白名单出，不再拼用户输入
 *
 * `hideCategories` 已经过 `normalizeCleanPreferences` 的白名单过滤，
 * 但本函数**再过滤一次** —— 因为它是导出函数，可能被其它调用方直接调用。
 * 双重过滤的代价是一次 `includes`，换来"绝不把任意字符串拼进选择器"。
 */
export function buildHomeCleanCss(prefs: CleanPreferences): string {
  const rules: string[] = [];

  if (prefs.options.homeHideSwipe) {
    rules.push(`${SWIPE_SELECTOR} { display: none !important; }`);
  }

  for (const cat of prefs.hideCategories) {
    if (!isObservedCategory(cat)) continue;
    rules.push(`[${CATEGORY_MARK_ATTR}="${cat}"] { display: none !important; }`);
  }

  return rules.join('\n');
}

/** 应用/更新首页净化样式（幂等） */
export function applyHomeClean(prefs: CleanPreferences, doc: Document = document): void {
  let style = doc.getElementById(HOME_CLEAN_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = HOME_CLEAN_STYLE_ID;
    (doc.head ?? doc.documentElement)?.appendChild(style);
  }
  style.textContent = buildHomeCleanCss(prefs);
}

/**
 * 安装动态监听 —— 推荐流无限滚动，卡片持续插入。
 *
 * ## ⚠️ 必须等容器出现（2026-10-31 实测踩到）
 *
 * 入口是 `document_start`，那时 `.container` **必然还不存在**。
 * 首版只查一次就放弃，结果**一张卡都没标记**，且只在控制台留一行警告。
 * 现在改成：查不到就挂 document 级 observer 等它出现。
 *
 * @param getPrefs 读取当前偏好（供重扫时判断，避免无谓工作）
 * @param onGiveUp 15 秒仍未见容器时回调（ADR 0031：失效不许静默）
 */
export function installCleanObserver(
  getPrefs: () => CleanPreferences,
  doc: Document = document,
  onGiveUp?: () => void,
): { stop: () => void } {
  const observers: MutationObserver[] = [];

  let pending = false;
  const schedule = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      markCategoryCards(doc);
    });
  };

  const attachTo = (root: Element): void => {
    const ob = new MutationObserver(schedule);
    ob.observe(root, { childList: true, subtree: true });
    observers.push(ob);
  };

  // 初扫（容器可能已经在，也可能没有）
  markCategoryCards(doc);

  const container = doc.querySelector(FEED_CONTAINER_SELECTOR);
  if (container) {
    attachTo(container);
    return { stop: () => observers.forEach((o) => o.disconnect()) };
  }

  /**
   * 容器未就绪：在 body 上等。
   *
   * 保留 body 级 observer 而不切换掉：其它页面也可能有 `.floor-single-card`。
   * `getPrefs` 目前未用到，保留参数是为了将来做"只在有隐藏项时才监听"的优化。
   */
  void getPrefs;
  const root = doc.body ?? doc.documentElement;
  if (root) attachTo(root);

  let timer: ReturnType<typeof setTimeout> | null = null;
  timer = setTimeout(() => {
    if (!doc.querySelector(FEED_CONTAINER_SELECTOR)) {
      onGiveUp?.();
    }
  }, 15000);

  return {
    stop: () => {
      observers.forEach((o) => o.disconnect());
      if (timer) clearTimeout(timer);
    },
  };
}

/** 供调试：当前已标记的卡片数 */
export function countMarkedCategories(doc: Document = document): number {
  return doc.querySelectorAll(`[${CATEGORY_MARK_ATTR}]`).length;
}

/**
 * 读取当前页面上**实际存在**的分类 —— 供设置页展示用。
 *
 * 设置页不应该列出"可能不存在的分类"让用户勾：那样勾了没效果，
 * 用户会以为功能坏了。只展示此刻真实存在的。
 */
export function listPresentCategories(doc: Document = document): string[] {
  const seen = new Set<string>();
  for (const card of doc.querySelectorAll(FLOOR_CARD_SELECTOR)) {
    const badge = card.querySelector('.badge')?.textContent?.trim();
    if (isObservedCategory(badge)) seen.add(badge);
  }
  return [...seen];
}
