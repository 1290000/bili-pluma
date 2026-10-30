/**
 * 「当前页属于哪一类」—— popup / 视觉清理共用的页面归类。
 *
 * ## 为什么单独一个文件（2026-10-31）
 *
 * 首次实现 popup 的「净化」Tab 时，我在 `main.tsx` 里手写了
 * `u.pathname.startsWith('/video/')` 来判"是不是视频页"，
 * 被 `scripts/check-page-gate.mjs` 当场拦下 ——
 * 那正是它设计要防的事（2026-10-28 番剧页因为同类手写正则被判成"未生效"）。
 *
 * 规矩不变：**播放页判据只许走 `parsePlayPage()`**。
 * 而"首页 / 直播间"这两类是视觉清理才需要的概念，也应该有唯一住处，不能散在 UI 里。
 *
 * ## 与 `parsePlayPage()` 的分工
 *
 * | 函数 | 回答 |
 * | --- | --- |
 * | `parsePlayPage()` | 「这是不是**受支持的播放页**」（取流链路用，只认视频页 / 番剧页） |
 * | 本文件的 `classifyBiliPage()` | 「这个页面**属于哪类清理场景**」（视觉清理 + popup 展示用） |
 *
 * 前者是取流的准入判据，后者是"能清理什么"的分派判据。**两者语义不同，不要合并。**
 */

import { parsePlayPage } from './video-page';

/** 页面归类 —— 顺序即优先级 */
export type BiliPageKind =
  /** 首页及其分区页（`/`、`/index.html`、`/v/*`） */
  | 'home'
  /**
   * 受支持的播放页（`/video/BV…`、`/bangumi/play/ep…`）。
   *
   * ⚠️ 判据是 `parsePlayPage()`，**不是**手写路径前缀。
   */
  | 'video'
  /** 直播间 `live.bilibili.com`（视觉清理支持，但**不做取流**） */
  | 'live'
  /** 其它（空间、搜索、动态…）—— 视觉清理不动作 */
  | 'other';

/**
 * 把 URL 归类。
 *
 * ⚠️ **不认 `*.bilibili.com` 之外的域名**：`live.bilibili.com` 与 `www.bilibili.com`
 * 是两类完全不同的处理，不能因为都含 `bilibili.com` 就合并。
 */
export function classifyBiliPage(url: string): BiliPageKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }

  // 直播间：独立域名，且不做取流（ADR 0031）
  if (u.hostname === 'live.bilibili.com') return 'live';
  if (u.hostname !== 'www.bilibili.com' && u.hostname !== 'bilibili.com') return 'other';

  // 播放页：判据走统一入口（check-page-gate 规则 1 的要求）
  if (parsePlayPage(url) !== null) return 'video';

  // 首页与分区页
  if (u.pathname === '/' || u.pathname === '/index.html') return 'home';
  if (u.pathname.startsWith('/v/')) return 'home';

  return 'other';
}
