/**
 * 首页广告清理 —— 纯 CSS，判据来自**实测**而非上游抄写（ADR 0031）。
 *
 * ## ⚠️ 为什么没有照抄 Bilibili-Evolved 的选择器表
 *
 * 上游 `remove-promotions.scss` 有约 40 个选择器（`#slide_ad` / `.gg-pic` /
 * `.bypb-icon` / `[data-be-promotion-mark]` / `.adcard` …）。
 *
 * **2026-10-31 在真实首页逐条实测：45 个选择器里 43 个命中 0。**
 * 页面是完整加载的（推荐容器 36 个子节点、30 个 `.bili-video-card`、10 个 `.feed-card`），
 * 不存在"没加载完"的解释。页面上**一个** `ad` / `promotion` / `gg-` / `bypb` 类名都没有。
 *
 * 照抄的后果是"写一堆永不命中的死规则"——不报错、不告警，看着像实现了，实际什么都没做。
 * 这正是 `AGENTS.md` §1.5「能实测就不要推理」要防的那类错误。
 *
 * ## 实测到的真实判据
 *
 * 当前首页的广告卡片与正常卡片的**类名完全相同**（`feed-card` / `bili-feed-card`），
 * 内部**没有任何含 `ad` 字样的类名**。唯一稳定特征是：
 *
 *   **卡片内存在指向 `cm.bilibili.com` 的链接**（B站广告投放/计费系统）
 *
 * 实测样本：66 张卡片中 24 个链接指向 `cm.bilibili.com`，覆盖 3 张独立广告卡片；
 * 正常视频卡片（`www.bilibili.com` / `space.bilibili.com`）**无一命中**；
 * 子串误命中 **0**（不存在 `...?x=cm.bilibili.com` 这类 URL）。
 *
 * 所以判据用纯 CSS 的 `:has(a[href*="cm.bilibili.com"])` —— **不需要 JS、不需要
 * MutationObserver**，浏览器原生处理动态插入的卡片。
 *
 * ## 为什么用 `:has()`
 *
 * Chrome/Edge 105+ 支持；本项目 `minimum_chrome_version: '120'` → 安全。
 */

/** 首页广告卡片 —— 与正常卡片同 class，只能靠链接域名区分 */
export const HOME_AD_CSS = `
/* 首页 / 分区页推荐流里的广告卡片（链接指向 cm.bilibili.com 投放系统） */
.feed-card:has(a[href*="cm.bilibili.com"]),
.bili-feed-card:has(a[href*="cm.bilibili.com"]),
.bili-video-card:has(a[href*="cm.bilibili.com"]) {
  display: none !important;
}

/* 侧栏 / 横幅类广告位（当前首页实测为 0 命中，保留是因为它们在其它 B站 页面仍可能出现；
   失效时不会造成任何影响 —— 这是**唯一**允许保留"可能已死"规则的地方，
   因为它们不依赖结构，只依赖 B站 通用的广告命名惯例） */
#slide_ad,
.ad-report,
.bilibili-player-promote-wrap,
.desktop-download-tip { display: none !important; }
`;

/** 样式节点 id */
export const HOME_AD_STYLE_ID = 'pluma-home-ads';

/**
 * 插入样式。
 *
 * ⚠️ **不进 Shadow DOM**：要隐藏的是 B站自己的元素，shadow root 里的选择器命不中文档树
 * （ADR 0031 决定四）。
 */
export function applyHomeAdClean(doc: Document = document): boolean {
  if (doc.getElementById(HOME_AD_STYLE_ID)) return true;
  const style = doc.createElement('style');
  style.id = HOME_AD_STYLE_ID;
  style.textContent = HOME_AD_CSS;
  const target = doc.head ?? doc.documentElement;
  if (!target) return false;
  target.appendChild(style);
  return true;
}
