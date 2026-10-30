/**
 * 直播间内容脚本 —— 独立入口，**不与 `content.ts` 合并**（ADR 0031）。
 *
 * ## 为什么必须独立
 *
 * `content.ts` 是画质链路的编排层（报到、Observe 画质、下发配置给主世界）。
 * 让它注入直播间等于**凭空扩大取流逻辑的暴露面**，而我们**不支持直播取流**。
 *
 * 另外 `scripts/check-page-gate.mjs` 规则 2 要求 content 入口的 `matches`
 * 必须同时含 `video/*` 与 `bangumi/play/*`——把直播塞进同一入口就违反那条断言，
 * 等于让 page-gate 从此失去意义。
 *
 * ## 这个入口做什么
 *
 * 只做一件事：插一段隐藏水印的样式。没有消息、没有 chrome.storage、没有网络。
 */

import { applyLiveClean } from '@/src/content/live/live-clean';

export default defineContentScript({
  /**
   * ⚠️ 字面量，不能引用共享常量：WXT 生成 manifest 时对入口文件做静态分析，
   * 取不到跨文件常量的值（`shared/utils/video-page.ts` 里已记过同样的坑）。
   *
   * `live.bilibili.com/<房间号>` 与 `live.bilibili.com/blanc/<房间号>` 都要覆盖。
   */
  matches: ['*://live.bilibili.com/*'],

  /**
   * 注入时机用默认的 `document_idle`。
   *
   * 不用 `document_start`：这里不抢跑任何时序，早注入只会让解析期多一次 DOM 操作。
   * 我们的样式本身是常驻的，晚一点无所谓。
   */
  runAt: 'document_idle',

  main(): void {
    applyLiveClean();
  },
});
