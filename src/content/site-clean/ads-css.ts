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

/*
 * ── 模式：保留空位 + 占位文本 ──
 *
 * ## 设计目标：**版面一点都不能动**
 *
 * 这一节改过两轮，两次错因都记在这里，别再犯。
 *
 * ### 第一版错误（用户第一次反馈"排版明显不对"）
 *
 * | 做法 | 为什么错 |
 * | --- | --- |
 * | display: block !important | 首页广告卡是**网格项**，强制改成 block 直接破坏网格布局 |
 * | 子元素 visibility: hidden | 卡片高度仍由被隐藏内容决定，占位块又加 min-height，两者打架 |
 * | ::after height: 100% | 卡片高度是 auto 时百分比高度无效 |
 *
 * ### 第二版错误（verifier 逐元素比对抓出：视频页 +21.99px）
 *
 * 第二版给**所有**被标记元素都加 position: relative。
 * 但广告是**嵌套**的：.gg-pic 在 .ad-report 内部，**两个都带标记**。
 * .gg-pic 原生 position: absolute —— 被改成 relative 后
 * **重新参与父元素高度计算**：
 *
 * <pre>
 * 原生          : .ad-report-inner 高 0     → 卡片 668x55.65
 * 强制 relative : .ad-report-inner 高 21.99 → 卡片 668x77.64
 * </pre>
 *
 * **聚合指标完全看不出来**（行间距仍 20px、>100px 空隙仍 0），
 * 只有"逐元素比尺寸与原生差值"才能发现。
 *
 * ### 第三版（现在）
 *
 * 只让**最外层**被标记元素当占位容器，嵌套的**完全不碰** —— 保持原生定位与尺寸。
 * 判据：该元素**没有**带标记的祖先（即不是"标记元素里的标记元素"）。
 *
 * 占位块也只画在最外层 —— 语义上更对：用户看到的"这里有个广告位"是一整块，
 * 不是内部每个零件各贴一张标签。
 */
body.${BODY_CLASS.modePlaceholder} [data-pluma-ad="1"]:not([data-pluma-ad] [data-pluma-ad]) {
  position: relative !important;
  pointer-events: none !important;
}

/* 最外层的内容透明但**保留占位** —— 这是"尺寸不变"的关键 */
body.${BODY_CLASS.modePlaceholder}
  [data-pluma-ad="1"]:not([data-pluma-ad] [data-pluma-ad])
  > * {
  opacity: 0 !important;
}

/* 占位块：绝对定位铺满，不参与布局计算 */
body.${BODY_CLASS.modePlaceholder} [data-pluma-ad="1"]:not([data-pluma-ad] [data-pluma-ad])::after {
  content: '🚫已屏蔽广告';
  position: absolute !important;
  inset: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #888;
  background-color: rgba(136, 136, 136, 0.13);
  font-size: 14px;
  border-radius: 6px;
  overflow: hidden;
  z-index: 1;
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
