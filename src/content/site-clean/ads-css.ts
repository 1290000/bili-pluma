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
 * ## 受开关控制的判据：**现已移回 `ad-selectors.ts`**（2026-11-01 修真 bug）
 *
 * 这段判据曾写在本文件里（硬编码 `body:not(...)` + 选择器）。
 * 后果很隐蔽：
 *
 * - **CSS 正确**、判据也确实命中（`--pluma-ad-card` = `"1"`）
 * - 但 JS 预筛来自 `prescreenSelector(ALL_AD_RULES)`，那份数据**只含
 *   STRUCTURAL + GENERIC 两组** → `.activity-m-v1` 不在预筛里 → **元素从不被扫描**
 * - 于是「保留活动横幅」开关**完全无效**，而两边代码各自看都"对"
 *
 * verifier 实测证据：`elementInPrescreen: false`、
 * 判据命中但 `marked: null`、四条链路分离验证证明只有预筛这一环断了。
 *
 * 现在选择器叶子在 `ad-selectors.ts` 的 `TOGGLE_RULES` 里，
 * 由 `buildJudgementCss(toggleCondition)` 与 `prescreenSelector()` **同源生成**。
 * **不要再把判据选择器写回本文件。**
 */

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
/*
 * ── 模式：调试 —— 只加红框，**完全不碰 display / visibility** ──
 *
 * ## 2026-10-31 第二次修正（verifier 实测发现两个副作用）
 *
 * 首版写的是：
 *
 * <pre>
 * display: revert !important;      → 把 vcd 从 flex 还原成 block，高度 +59px
 * visibility: visible !important;  → 把 B站 自己 display:none 的卡强行显示
 * </pre>
 *
 * 两条都是**没必要**的：
 *
 * - debug 模式下我们本就不隐藏元素（mode-hide 的规则根本不会命中），
 *   所以不需要"还原显示"——广告本来就是可见的
 * - 强制 display: revert 反而会**破坏 B站 自己的布局**（flex → block）
 *   和**显示不该出现的内容**（B站 自己藏起来的卡）
 *
 * 现在只做一件事：画红框。**其余一律不干预。**
 *
 * 这也让 debug 模式成为真正"零侵入"的观察工具 ——
 * 打开它页面不该有任何变化，除了命中元素多一圈红边。
 */
body.${BODY_CLASS.modeDebug} [data-pluma-ad="1"] {
  outline: 2px solid red !important;
  outline-offset: -2px !important;
}

/* ── 模式：完全隐藏 —— 卡片不占位 ── */
body.${BODY_CLASS.modeHide} [data-pluma-ad="1"] {
  display: none !important;
}
`;

/**
 * ## 第 4 层：布局补偿
 *
 * 这是 M3 完全漏掉、导致用户看到排版错位的部分。**一条都不许删。**
 *
 * 只在**完全隐藏**模式下生效 —— 那是唯一会让卡片从网格消失的模式。
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
  '/* ── 判据（由 ad-selectors.ts 生成，含受开关控制的部分）── */',
  /**
   * `body:not(.preserve-event-banner)` —— 反向语义：
   * body 上**没有**这个类时才把活动横幅算作要删除的广告。
   *
   * 这个前置条件由本文件提供（它持有 `BODY_CLASS` 常量），
   * 但**选择器叶子来自 `ad-selectors.ts` 的 `TOGGLE_RULES`**，
   * 这样 `prescreenSelector()` 才能自动包含它们。
   */
  buildJudgementCss(`body:not(.${BODY_CLASS.preserveEventBanner}) `),
  '/* ── 应用层（由 body 类名驱动）── */',
  APPLY,
  '/* ── 布局补偿（第 4 层，删除即导致版面错位）── */',
  COMPENSATION,
].join('\n');

/** JS 写入的标记属性 —— CSS 用它来命中 */
export const AD_MARK_ATTR = 'data-pluma-ad';
