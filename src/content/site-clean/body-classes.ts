/**
 * body 类名开关机制 —— 由**渲染模式**驱动，而不是由布尔选项直接驱动。
 *
 * ## 为什么需要它（而不是把选项直接拼进 CSS）
 *
 * 选项变化时，往 `<body>` 上 `classList.toggle` 类名，由**静态 CSS** 消费。
 *
 * 好处是三条：
 *   1. **样式表只插一次**，开关变化时只改类名 —— 不重建 `<style>`，不引起重排风暴
 *   2. CSS 可以**嵌套表达**"仅在开 X 时才隐藏 Y"
 *   3. 调试时只要看 `document.body.className` 就知道当前所有开关状态
 *
 * ## 2026-10-31 重构：从「布尔直驱」改为「模式驱动」
 *
 * 若让 CSS 直接消费多个布尔类名，就会出现"两个类同时存在、靠特异性决胜"的
 * 脆弱结构（本项目已踩过两次）。
 *
 * 现在改为：**`resolveAdRenderMode()` 先收敛成唯一模式**，
 * 再把**恰好一个**模式类名挂到 body 上。CSS 只需匹配模式类，不再组合布尔。
 *
 * | 模式 | body 类名 | 效果 |
 * | --- | --- | --- |
 * | `disabled` | （无） | 广告照常显示，一条规则都不生效 |
 * | `debug` | `pluma-clean-mode-debug` | 不隐藏，红框标出 |
 * | `hide` | `pluma-clean-mode-hide` | 完全隐藏 |
 *
 * ## 命名前缀
 *
 * 全部以 `pluma-clean-` 开头。上游用的是 `remove-promotions-*`，
 * 不能沿用 —— 若用户同时装了 Bilibili-Evolved，两边的 body 类名会互相污染。
 */

import { resolveAdRenderMode, type CleanOptions, type AdRenderMode } from './clean-options';

/** body 上的类名常量 —— CSS 与 JS 共用，改这里即可 */
export const BODY_CLASS = {
  /** 保留活动横幅（独立于模式，只影响"哪些算广告"） */
  preserveEventBanner: 'pluma-clean-preserve-event-banner',
  /** 保留动态商品推荐（同上） */
  preserveFeedGoods: 'pluma-clean-preserve-feed-goods',
  /** 隐藏首页顶部大图（首页净化） */
  homeHideSwipe: 'pluma-clean-home-hide-swipe',
  /** 渲染模式：完全隐藏 */
  modeHide: 'pluma-clean-mode-hide',
  /** 渲染模式：调试（不隐藏 + 红框） */
  modeDebug: 'pluma-clean-mode-debug',
} as const;

/**
 * 模式 → 类名。
 *
 * ⚠️ `placeholder`（保留空位 + 占位块）已于 2026-10-31 按用户要求**删除**。
 * 不要再加回来 —— 那套实现为了"版面不动"改过两轮，
 * 还出过嵌套元素被 `position: relative` 撑高 22px 的 bug。
 */
const MODE_CLASSES: Record<AdRenderMode, string | null> = {
  disabled: null,
  hide: BODY_CLASS.modeHide,
  debug: BODY_CLASS.modeDebug,
};

/**
 * 把选项同步到 `<body>` 的类名。
 *
 * **幂等**：重复调用同一份选项不会产生变化。
 * **模式类名恰好挂一个**：先全部移除，再挂当前模式那一个 ——
 * 这样不存在"两个模式类同时存在"的状态，CSS 无需靠特异性决胜。
 *
 * @returns 实际发生变化的类名数量（0 表示没有任何变化）
 */
export function applyBodyClasses(opts: CleanOptions, body: Element | null = document.body): number {
  if (!body) return 0;

  const mode = resolveAdRenderMode(opts);
  const modeClass = MODE_CLASSES[mode];

  const want: Array<[string, boolean]> = [
    [BODY_CLASS.preserveEventBanner, opts.adPreserveEventBanner],
    [BODY_CLASS.preserveFeedGoods, opts.adPreserveFeedGoods],
    [BODY_CLASS.homeHideSwipe, opts.homeHideSwipe],
  ];
  /** 三个模式类都参与"是否变化"的比较，保证先清后挂 */
  for (const cls of Object.values(MODE_CLASSES)) {
    if (cls) want.push([cls, cls === modeClass]);
  }

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

/** 供调试：读取当前挂着的模式 */
export function readRenderMode(body: Element | null = document.body): AdRenderMode {
  if (!body) return 'disabled';
  if (body.classList.contains(BODY_CLASS.modeDebug)) return 'debug';
  if (body.classList.contains(BODY_CLASS.modeHide)) return 'hide';
  return 'disabled';
}
