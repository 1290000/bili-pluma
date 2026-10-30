/**
 * 广告清理样式 —— 由**数据**生成（第 1 层选择器 + 第 4 层布局补偿）。
 *
 * ## 判据选择器不在本文件（2026-10-31 重构）
 *
 * 选择器全部住在 `ad-selectors.ts` 的 `AD_SELECTORS`。本文件只负责**拼装**。
 * 原因见那个文件的文件头：本轮因为"CSS 与 JS 各维护一份选择器"栽了三回，
 * 漏掉的选择器会让广告**永不隐藏且不报错**。
 *
 * ## ⚠️ 布局补偿是 M3 被回退的直接原因，别再砍掉
 *
 * 第一版只写了 `display: none`，结果：广告卡片消失但**网格不重排**，
 * 用户看到右上角空洞、第二行错位（2026-10-31 截图证实，用户发现）。
 *
 * 上游为此专门写了补偿规则，本文件全部保留（第 4 层）：
 *   - `.load-more-anchor` 顶到视口外 → 骗页面认为已滚到底，**提前加载下一批卡片补位**
 *   - 容器子元素 `margin: 0` → 消除隐藏后残留的间距
 */

import { BODY_CLASS } from './body-classes';
import { buildJudgementCss } from './ad-selectors';

/**
 * 受开关控制的判据 —— 不在 `AD_SELECTORS` 里，因为它们依赖 body 类名。
 *
 * 结构与通用判据不带条件；这两条**是否算广告**由用户开关决定。
 */
function buildToggleControlledJudgement(): string {
  return `
/* ── 活动横幅：受「保留活动横幅」开关控制（上游 preserveEventBanner）── */
body:not(.${BODY_CLASS.preserveEventBanner}) .activity-m,
body:not(.${BODY_CLASS.preserveEventBanner}) .activity-m-v1 {
  --pluma-ad-card: 1;
}

/* ── 动态商品推荐：受「保留动态商品推荐」开关控制（上游 preserveFeedGoods）── */
body:not(.${BODY_CLASS.preserveFeedGoods}) .dyn-goods,
body:not(.${BODY_CLASS.preserveFeedGoods}) .bili-dyn-content__orig__additional:has(.dyn-goods) {
  --pluma-ad-card: 1;
}
`;
}

/**
 * 应用层 —— 由 body 类名决定"怎么隐藏"。
 *
 * 三种结局：
 *   - 默认（hideContainer 开）：`display:none`，卡片不占位
 *   - hideContainer 关（keepSpace 类）：保留空位，只隐藏内容（版面最稳定）
 *   - debug 开：不隐藏，加红框
 */
const APPLY = `
/* 调试模式：全部显示并加红框，用于确认选择器命中情况 */
body.${BODY_CLASS.debug} [data-pluma-ad="1"] {
  display: revert !important;
  visibility: visible !important;
  outline: 2px solid red !important;
  outline-offset: -2px !important;
}

/*
 * 默认隐藏。
 *
 * ## 为什么写成「不是 debug 也不是 keep-space」
 *
 * 这样它与下面「保留空位」那条**在条件上互斥**，
 * 不需要依赖书写顺序或特异性大小 —— 两条规则永远不会同时命中同一元素。
 *
 * 2026-10-31 两次踩到同一类问题：
 *   1. 首版用 :not(.debug):not(.hideContainer)，特异性比默认隐藏高，
 *      在 body 缺该类时反过来压过 display:none → 元素照样显示。
 *   2. 改成正向类名后特异性与默认隐藏相同，改由书写顺序决胜 ——
 *      verifier 独立指出这是脆弱的，且当时 keep-space 命中 0，无法靠实测排除。
 *
 * 现在用条件互斥替代这两种做法：默认隐藏排除 keep-space，
 * 两条规则的作用域不重叠，顺序与特异性都不再是正确性的前提。
 */
body:not(.${BODY_CLASS.debug}):not(.${BODY_CLASS.keepSpace}) [data-pluma-ad="1"] {
  display: none !important;
}

/*
 * 「完全隐藏」关闭时：卡片保留占位，只清空内容。
 *
 * 条件与上一条互斥（上一条已排除 keep-space），所以这里不需要更高特异性。
 */
body.${BODY_CLASS.keepSpace} [data-pluma-ad="1"] {
  display: block !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

/* 占位文本：被屏蔽的广告位显示「已屏蔽广告」（上游 showPlaceholder） */
body.${BODY_CLASS.showPlaceholder}:not(.${BODY_CLASS.debug}) [data-pluma-ad="1"]::after {
  content: '🚫已屏蔽广告';
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 60px;
  color: #888;
  background-color: rgba(136, 136, 136, 0.13);
  font-size: 14px;
  visibility: visible;
}
`;

/**
 * ## 第 4 层：布局补偿
 *
 * 这是 M3 完全漏掉、导致用户看到排版错位的部分。**一条都不许删。**
 *
 * 逐条说明理由：
 *
 * 1. `.load-more-anchor` 顶出视口
 *    —— 隐藏广告卡后，首页下半部分会空出一截。B站 的"加载更多"
 *    依赖这个锚点是否进入视口，把它临时移到视口上方会让页面
 *    以为自己已经滚到底，从而**立刻加载下一批卡片补位**。
 *    没有这条，用户会看到一大片空白（实测截图已证实）。
 *
 * 2. 容器子元素 margin 归零
 *    —— 隐藏某一列后，相邻卡片残留的 margin 会让行高不齐。
 *
 * 3. 透明业务卡不得占位
 *    —— 首页推荐流里有一种透明业务卡，隐藏后仍占位。
 */
const COMPENSATION = `
/* ① 提前加载下一批卡片，补上因隐藏广告空出来的位置 */
body.${BODY_CLASS.hideContainer} .container > .load-more-anchor {
  position: fixed !important;
  top: -9999px !important;
}

/* ② 消除隐藏后残留的行间距 */
.recommended-container_floor-aside .container > * {
  margin: 0 !important;
}

/* ③ 透明业务卡不得占位 */
.recommended-container .business-card {
  position: absolute !important;
  pointer-events: none !important;
  opacity: 0 !important;
}

/* ④ 被隐藏的横幅不应留下高度 */
.ad-report.strip-ad.left-banner:empty {
  height: 0 !important;
}
`;

/**
 * 完整样式文本。
 *
 * ⚠️ 注意 `--pluma-ad-card` 只是**标记变量**，真正生效的是
 * `[data-pluma-ad="1"]` —— 由 JS 把命中元素打上该属性。
 * 这样做的原因：`debug` 模式需要把已隐藏元素**恢复显示**，
 * 纯 CSS 无法可靠地"撤销自己"。
 */
export const AD_CLEAN_CSS = [
  '/* ── 判据（由 ad-selectors.ts 生成）── */',
  buildJudgementCss(),
  buildToggleControlledJudgement(),
  '/* ── 应用层（由 body 类名驱动）── */',
  APPLY,
  '/* ── 布局补偿（第 4 层，删除即导致版面错位）── */',
  COMPENSATION,
].join('\n');

/** JS 写入的标记属性 —— CSS 用它来命中 */
export const AD_MARK_ATTR = 'data-pluma-ad';
