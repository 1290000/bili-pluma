/**
 * `www.bilibili.com` 全站的**视觉清理**入口（ADR 0031 决定二）。
 *
 * ## 边界：能力划分，不是站点划分
 *
 * 本入口只管「改页面长什么样」，**绝不**做取流相关的事：
 * 不读 cookie、不发请求、不改响应、不碰播放器内部节点。
 *
 * 取流由 `entrypoints/content.ts` 负责（只注入 `/video/*` 与 `/bangumi/play/*`）。
 * 两者**互不调用、互不读对方状态**，各自独立失效。
 *
 * ## 为什么 matches 是全站而不是只写首页
 *
 * 2026-10-31 实测：**视频详情页同样有 3 个可见广告单元**
 * （`.ad-report.strip-ad.left-banner` 668×56、`.ad-report` 350×104、
 * `.ad-report.ad-floor-exp` 350×175）。只在首页注入会漏掉它们。
 *
 * 所以 matches 放宽到整站，**由下面的 URL 分支决定做什么** ——
 * 这是"能力范围"的放宽（已在 ADR 0031 记录），不是权限放宽
 * （`host_permissions` 本来就有 `*://*.bilibili.com/*`）。
 *
 * ## ⚠️ 硬约束（ADR 0031）
 *
 * 1. **不认识的页面直接 return**，不许"顺手也清一下"
 * 2. **绝不碰播放器内部节点**（`.bpx-player-*`、`video`）
 * 3. 新增作用面必须先改 ADR
 */

import {
  applyAdClean,
  ensureAdStyle,
  installAdObserver,
  markAdElements,
} from '@/src/content/site-clean/ads';
import { normalizeCleanOptions, type CleanOptions } from '@/src/content/site-clean/clean-options';
import { CLEAN_OPTIONS_CHANGED_KEY, readRawCleanOptions } from '@platform/storage/ui-prefs-store';

/** 本页要做什么 */
type PageKind = 'home' | 'video' | 'other';

/**
 * 判断当前页属于哪一类。
 *
 * ⚠️ **不复用 `parsePlayPage()`**：那是"这是不是受支持的播放页"的判据（只认
 * `/video/BV…` 与 `/bangumi/play/ep…`），服务于取流链路。
 * 这里要回答的是"这是哪一类视觉清理场景"，语义不同，且还要认出首页。
 *
 * 本文件是 content 入口，`/video/` 字面量已在 `check-page-gate.mjs` 的
 * `NON_PLAY_PAGE_ENTRIES` 白名单内，合法。
 */
function detectPage(url: string): PageKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  if (u.hostname !== 'www.bilibili.com' && u.hostname !== 'bilibili.com') return 'other';

  // 首页：根路径或首页分区页 /v/*
  if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname.startsWith('/v/')) {
    return 'home';
  }
  // 视频详情页
  if (u.pathname.startsWith('/video/')) return 'video';

  // 其它（番剧、空间、搜索…）**不在本次范围**，直接不动作
  return 'other';
}

export default defineContentScript({
  /**
   * ⚠️ 字面量。WXT 生成 manifest 时对入口文件做静态分析，取不到跨文件常量。
   *
   * 全站注入由 `detectPage()` 在运行时收窄 —— 见文件头的三条硬约束。
   */
  matches: ['*://www.bilibili.com/*'],

  /**
   * `document_start`：广告卡片随推荐流异步插入，
   * 样式先就位才能避免用户先看到广告再闪一下。
   */
  runAt: 'document_start',

  async main(ctx): Promise<void> {
    const kind = detectPage(location.href);

    // 不认识的页面：什么都不做（ADR 0031 硬约束 1）
    if (kind === 'other') return;

    /** 最新选项（供 observer 的回调读取） */
    let options: CleanOptions = normalizeCleanOptions(await readRawCleanOptions());

    // 样式与 body 类名先就位（早于卡片渲染）
    ensureAdStyle();
    applyAdClean(options, document);

    /**
     * 动态监听：推荐流无限滚动、视频页右栏异步渲染，
     * 都需要持续补标记。
     */
    const { stop } = installAdObserver(
      () => options,
      document,
      () => {
        console.warn('[pluma] 未找到已知内容容器 —— 广告清理可能已因 B站 改版失效');
      },
    );
    ctx.onInvalidated(stop);

    // 设置页改选项 → 立即生效（与角标开关同一模式，见 02-ui-spec §4.3）
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[CLEAN_OPTIONS_CHANGED_KEY]) return;
      options = normalizeCleanOptions(changes[CLEAN_OPTIONS_CHANGED_KEY].newValue);
      applyAdClean(options, document);
      // 从调试态切回正常态时，之前漏掉的元素要补标
      if (!options.adDebug) markAdElements(document, window);
    });

    // 视频页只做广告清理；首页净化（M4）后续接在这里
    if (kind === 'video') return;
  },
});
