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
 * 结构与通用判据不带条件；这几条**是否算广告**由用户开关决定。
 */
function buildToggleControlledJudgement(): string {
  return `
/* ── 活动横幅：受「保留活动横幅」开关控制（上游 preserveEventBanner）──
   ⚠️ 2026-10-31 补：视频详情页的活动推广位**不在** .activity-m 里，
   而是 .ad-report.ad-floor-exp（实测内容「来分享你的兴趣人生经营日志吧！」）。
   首版只写了首页那两条，所以用户在视频页关掉此开关**看不出任何变化**。
   现在把视频页的活动推广位也纳入同一开关。 */
body:not(.${BODY_CLASS.preserveEventBanner}) .activity-m,
body:not(.${BODY_CLASS.preserveEventBanner}) .activity-m-v1,
body:not(.${BODY_CLASS.preserveEventBanner}) .ad-report.ad-floor-exp {
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
 * 应用层 —— 由**模式类名**驱动（2026-10-31 重构）。
 *
 * ## 为什么改成模式驱动
 *
 * 用户要求把「显示占位文本」并进「完全隐藏」的联动，并让「调试模式」优先。
 * 若继续让 CSS 组合两个布尔类名，就会出现"两个类同时存在、靠特异性决胜"
 * 的脆弱结构（本项目在这一点上已经踩过两次）。
 *
 * 现在 `resolveAdRenderMode()` 先收敛成**唯一模式**，
 * body 上**恰好挂一个**模式类，CSS 只需匹配它：
 *
 * | 模式 | 效果 |
 * | --- | --- |
 * | `disabled` | 不挂任何模式类 → 一条规则都不命中，广告照常显示 |
 * | `debug` | 不隐藏 + 红框 |
 * | `hide` | 完全隐藏，不占位 |
 * | `placeholder` | 保留空位 + 占位文本 |
 *
 * **模式之间互斥不是靠书写顺序，而是靠"body 上只有其中一个类"。**
 */
const APPLY = `
/* ── 模式：调试 —— 不隐藏，红框标出命中元素 ──
   优先级最高：关掉「完全隐藏」后打开调试，用户要看到真实广告。 */
body.${BODY_CLASS.modeDebug} [data-pluma-ad="1"] {
  display: revert !important;
  visibility: visible !important;
  outline: 2px solid red !important;
  outline-offset: -2px !important;
}

/* ── 模式：完全隐藏 —— 卡片不占位 ── */
body.${BODY_CLASS.modeHide} [data-pluma-ad="1"] {
  display: none !important;
}

/* ── 模式：保留空位 + 占位文本 ──
   卡片保留在网格里（版面无空洞），内容清空，由 ::after 画占位块。 */
body.${BODY_CLASS.modePlaceholder} [data-pluma-ad="1"] {
  display: block !important;
  visibility: visible !important;
  pointer-events: none !important;
  min-height: 60px;
}

/*
 * 占位块本身。
 *
 * 注意：首版用 visibility:hidden 隐藏整张卡再让 ::after 可见 —— 那样
 * 卡片内容仍占位却不可见，尺寸忽大忽小。现在改为内容透明、占位块可见，
 * 版面尺寸由卡片自身高度决定，更稳定。
 */
body.${BODY_CLASS.modePlaceholder} [data-pluma-ad="1"] > * {
  visibility: hidden !important;
}

body.${BODY_CLASS.modePlaceholder} [data-pluma-ad="1"]::after {
  content: '🚫已屏蔽广告';
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 60px;
  height: 100%;
  color: #888;
  background-color: rgba(136, 136, 136, 0.13);
  font-size: 14px;
  visibility: visible !important;
}
`;

/**
 * ## 第 4 层：布局补偿
 *
 * 这是 M3 完全漏掉、导致用户看到排版错位的部分。**一条都不许删。**
 *
 * 只在**完全隐藏**模式下生效 —— 那是唯一会让卡片从网格消失的模式。
 * 占位模式下卡片仍在网格里，不需要补位，且补位反而会额外加载一批卡片。
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
/* ① 提前加载下一批卡片，补上因隐藏广告空出来的位置（仅 hide 模式） */
body.${BODY_CLASS.modeHide} .container > .load-more-anchor {
  position: fixed !important;
  top: -9999px !important;
}

/* ② 消除隐藏后残留的行间距（仅 hide 模式 —— 占位模式要保持原间距） */
body.${BODY_CLASS.modeHide} .recommended-container_floor-aside .container > * {
  margin: 0 !important;
}

/* ③ 透明业务卡不得占位 */
body.${BODY_CLASS.modeHide} .recommended-container .business-card {
  position: absolute !important;
  pointer-events: none !important;
  opacity: 0 !important;
}

/* ④ 被隐藏的横幅不应留下高度（仅 hide 模式） */
body.${BODY_CLASS.modeHide} .ad-report.strip-ad.left-banner:empty {
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
