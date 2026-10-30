/**
 * 广告判据选择器 —— **单一真相源**，CSS 与 JS 都从这里生成。
 *
 * ## 为什么必须是数据而不是散落在 CSS 文本里（2026-10-31 三次踩坑）
 *
 * 本轮在这个问题上栽了三回：
 *
 * | 版本 | 做法 | 后果 |
 * | --- | --- | --- |
 * | v1 | 选择器只写在 CSS 字符串里，JS 另维护一张"候选类名"清单 | 两张表**必然漂移**，漏了约 20 个选择器 → 那些广告永不隐藏、**不报错** |
 * | v2 | JS 改成全文档扫 | 正确但慢（首页 2000+ 元素 / 每次 DOM 变动） |
 * | v3 | JS 预筛 + 用**正则从 CSS 源码抽类名**做一致性检查 | 正则把 import、注释、复合选择器全拆错，**检查结论本身不可信** |
 *
 * v4（本文件）：**判据选择器是这里的数据**。
 *   - CSS 文本由 `buildAdCss()` 从数据拼出
 *   - JS 预筛由 `prescreenSelector()` 从同一份数据算出
 *   - 一致性是**构造上保证的**，不需要运行时猜测
 *
 * ## 加选择器的正确姿势
 *
 * 只改 `AD_SELECTORS` 一个数组。CSS 与预筛自动跟上。
 * **不要在别处再写第二份选择器清单。**
 */

/** 一条判据规则 */
export interface AdSelectorRule {
  /** CSS 选择器（可含 `:has()`） */
  selector: string;
  /** 说明来源与实测依据 —— 写清"为什么这条在表里" */
  note: string;
}

/**
 * ## 第一组：结构判据（实测有效，功能主体）
 *
 * 依据 2026-10-31 真机实测。
 */
export const STRUCTURAL_RULES: readonly AdSelectorRule[] = [
  {
    selector: '.feed-card:has(a[href*="cm.bilibili.com"])',
    note: '首页推荐流广告：卡片类名与正常卡相同，只能靠链接域名区分（实测唯一可靠判据）',
  },
  {
    selector: '.bili-feed-card:has(a[href*="cm.bilibili.com"])',
    note: '同上，另一种卡片类名',
  },
  {
    selector: '.bili-video-card:has(a[href*="cm.bilibili.com"])',
    note: '同上，嵌套在 feed-card 内的卡片',
  },
  {
    selector: '.ad-report',
    note: '视频详情页广告单元（实测 350×104 / 350×175 两个可见）',
  },
  {
    selector: '.ad-floor-exp',
    note: '视频页右下方楼层推广（实测 350×175）',
  },
  {
    selector: '.strip-ad.left-banner',
    note: '视频页左栏横幅（实测 668×56）',
  },
  {
    selector: '.right-bottom-banner',
    note: '视频页右下角横幅',
  },
];

/**
 * ## 第二组：通用广告位（上游选择器表，MIT）
 *
 * ⚠️ 这些在当前**首页**多数已失效（实测 45 个里 43 个命中 0），
 * 但**视频页仍在用**（如 `.gg-pic` 实测存在）。保留理由：
 * 它们只依赖 B站 通用的广告命名惯例，失效时无害。
 */
export const GENERIC_RULES: readonly AdSelectorRule[] = [
  { selector: '#slide_ad', note: 'B站通用侧栏广告位' },
  { selector: '.v-wrap .vcd', note: '播放器广告覆盖层' },
  { selector: '#home_popularize .l-con', note: '首页推广楼层' },
  { selector: '#home_popularize .adpos', note: '首页推广位' },
  { selector: '.gg-floor-module', note: '广告楼层模块' },
  { selector: '.gg-pic', note: '广告图（视频页实测存在）' },
  { selector: '.home-app-download', note: '首页 App 下载推广' },
  { selector: '.bilibili-player-promote-wrap', note: '播放器推广容器' },
  { selector: '.bili-header-m .nav-menu .nav-con .nav-item .text-red', note: '顶部导航红字推广' },
  { selector: '.mobile-link-l', note: '移动端引流' },
  { selector: '.international-home .banner-card', note: '国际版首页横幅' },
  { selector: '.bypb-window .operate-card', note: '运营弹窗卡' },
  { selector: '.gg-window .operate-card', note: '广告弹窗卡' },
  { selector: '#reportFirst2 .extension', note: '举报楼层扩展位' },
  { selector: '.video-page-special-card', note: '视频页专题卡' },
  { selector: '.mascot', note: '吉祥物挂件（广告位）' },
  { selector: '.rank-container .cm-module', note: '排行区推广模块' },
  { selector: '.bili-dyn-home--member .bili-dyn-ads', note: '动态页广告' },
  { selector: '.video-page-special-card-small .card-box', note: '视频页专题小卡' },
  { selector: '.video-page-game-card-small .card-box', note: '视频页游戏小卡' },
  { selector: '.video-page-operator-card-small .card-box', note: '视频页运营小卡' },
  { selector: '[data-be-promotion-mark]', note: '上游标记属性（兼容 Bilibili-Evolved 的标记）' },
  { selector: '.desktop-download-tip', note: '桌面端下载提示' },
  { selector: '.adcard', note: '广告卡' },
  { selector: '.palette-button-adcard', note: '右侧悬浮广告卡' },
  { selector: '.palette-button-wrap .adcard-content', note: '悬浮广告内容' },
  { selector: '.video-card-ad-small', note: '小广告卡' },
];

/** 全部判据（两组拼接，供检查与调试用） */
export const ALL_AD_RULES: readonly AdSelectorRule[] = [...STRUCTURAL_RULES, ...GENERIC_RULES];

/**
 * 生成 JS 侧预筛选择器。
 *
 * **构造保证**：`ALL_AD_RULES` 里每条选择器的"叶子"（最后一个 id/class）都会被包含，
 * 于是不存在"CSS 有判据但预筛漏掉"的情况 —— 这是 v4 相对 v1-v3 的核心改进。
 *
 * `:has()` 部分被剥掉：预筛只需要"这个元素值得看一眼"，
 * 真正的判定仍交给 CSS 变量。
 */
export function prescreenSelector(rules: readonly AdSelectorRule[] = ALL_AD_RULES): string {
  const parts = new Set<string>();

  for (const r of rules) {
    // 剥掉 :has() 与 :not()，只取主选择器的最后一个简单选择器
    const stripped = r.selector.replace(/:has\([^)]*\)/g, '').replace(/:not\([^)]*\)/g, '');
    const tokens = stripped.split(/\s+/).filter(Boolean);
    const last = tokens[tokens.length - 1] ?? '';
    if (!last) continue;
    // 保留 id 与 class 两种形态
    parts.add(last);
  }

  return [...parts].join(',');
}

/**
 * 生成 CSS 判据段。
 */
export function buildJudgementCss(): string {
  const block = (rules: readonly AdSelectorRule[]): string =>
    rules.map((r) => `${r.selector} { --pluma-ad-card: 1; }`).join('\n');

  return `
/* ── 结构判据（实测有效）── */
${block(STRUCTURAL_RULES)}

/* ── 通用广告位（上游选择器表，MIT）── */
${block(GENERIC_RULES)}
`;
}
