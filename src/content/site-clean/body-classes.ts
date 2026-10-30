/**
 * body 类名开关机制 —— 上游的**第 3 层**，M3 完全漏掉的一层。
 *
 * ## 为什么需要它（而不是把选项直接拼进 CSS）
 *
 * 上游的做法是：选项变化时，往 `<body>` 上 `classList.toggle` 一个类名，
 * 由**静态 CSS** 用 `body:not(.preserve-event-banner) .activity-m` 这样的选择器去消费。
 *
 * 好处是三条：
 *   1. **样式表只插一次**，开关变化时只改一个类名 —— 不重建 `<style>`，不引起重排风暴
 *   2. CSS 可以**嵌套表达**"仅在开 X 时才隐藏 Y"，纯文本拼接很难维护
 *   3. 调试时只要看 `document.body.className` 就知道当前所有开关状态
 *
 * ## 命名前缀
 *
 * 全部以 `pluma-clean-` 开头。上游用的是 `remove-promotions-*`，
 * 不能沿用 —— 若用户同时装了 Bilibili-Evolved，两边的 body 类名会互相污染。
 */

import type { CleanOptions } from './clean-options';

/** body 上的类名常量 —— CSS 与 JS 共用，改这里即可 */
export const BODY_CLASS = {
  /** 保留活动横幅 */
  preserveEventBanner: 'pluma-clean-preserve-event-banner',
  /** 保留动态商品推荐 */
  preserveFeedGoods: 'pluma-clean-preserve-feed-goods',
  /** 完全隐藏（不占位） */
  hideContainer: 'pluma-clean-hide-container',
  /**
   * 「保留空位」—— **`hideContainer` 的反向标记**，必须有实际类名。
   *
   * ⚠️ 为什么不让 CSS 直接写 `body:not(.hide-container)`（2026-10-31 踩到）：
   * `body:not(.debug):not(.hideContainer)` 的特异性比 `body:not(.debug)` **高**，
   * 于是在 body 缺这个类时反而压过 `display:none`，元素照样显示。
   * 正向类名让两条规则的生效条件互斥，不再依赖书写顺序与特异性计算。
   */
  keepSpace: 'pluma-clean-keep-space',
  /** 显示占位文本 */
  showPlaceholder: 'pluma-clean-show-placeholder',
  /** 调试模式 */
  debug: 'pluma-clean-debug',
} as const;

/**
 * 把选项同步到 `<body>` 的类名。
 *
 * **幂等**：重复调用同一份选项不会产生变化（`classList.toggle` 第二个参数是布尔）。
 *
 * @returns 实际发生变化的类名数量（0 表示没有任何变化，便于调用方决定要不要重算布局）
 */
export function applyBodyClasses(opts: CleanOptions, body: Element | null = document.body): number {
  if (!body) return 0;
  const want: Array<[string, boolean]> = [
    [BODY_CLASS.preserveEventBanner, opts.adPreserveEventBanner],
    [BODY_CLASS.preserveFeedGoods, opts.adPreserveFeedGoods],
    [BODY_CLASS.hideContainer, opts.adHideContainer],
    /** 与 hideContainer **互斥**：关掉「完全隐藏」才保留空位 */
    [BODY_CLASS.keepSpace, !opts.adHideContainer],
    [BODY_CLASS.showPlaceholder, opts.adShowPlaceholder],
    [BODY_CLASS.debug, opts.adDebug],
  ];

  let changed = 0;
  for (const [cls, on] of want) {
    if (body.classList.contains(cls) === on) continue;
    body.classList.toggle(cls, on);
    changed += 1;
  }
  return changed;
}

/** 移除全部类名 —— 扩展停用 / 脚本失效时调用，避免残留影响页面 */
export function clearBodyClasses(body: Element | null = document.body): void {
  if (!body) return;
  for (const cls of Object.values(BODY_CLASS)) body.classList.remove(cls);
}
