/**
 * 首页内容脚本 —— 独立入口（ADR 0031）。
 *
 * ## 为什么必须独立于 `content.ts`
 *
 * `content.ts` 是**画质链路**的编排层（报到、观测画质、下发配置给主世界），
 * 它的 `matches` 只有视频页与番剧页。首页没有取流可做。
 *
 * 让画质脚本注入首页等于：
 *   - 在不该报到的地方报到（`page/activate` 会对首页发规则，见 `background.ts` 的标签页清理逻辑）
 *   - 白白扩大取流逻辑的暴露面
 *
 * 所以首页的样式清理走自己的入口。
 *
 * ## 职责边界
 *
 * 只做**样式注入**：删除广告（`ads.ts`）。不读 storage、不发消息、不碰 DOM 结构。
 * 首页净化（按分类删卡片）需要 JS，在 M4 加进这个入口，
 * 但**只允许在这里加**，不要合并回 `content.ts`。
 */

import { applyHomeAdClean } from '@/src/content/site-clean/ads';

export default defineContentScript({
  /**
   * ⚠️ 字面量。WXT 生成 manifest 时对入口文件做静态分析，取不到跨文件常量。
   *
   * 只认首页根路径与分区页（`/v/*`）。**不要写 `*://*.bilibili.com/*`**：
   * 那会注入到视频页 / 番剧页 / 空间页，和 `content.ts` 的写域重叠。
   */
  matches: ['*://www.bilibili.com/', '*://www.bilibili.com/v/*'],

  /**
   * `document_start`：广告卡片是随推荐流**异步插入**的。
   * 样式先就位，卡片一出现就被 `:has()` 命中，避免用户先看到广告再被隐藏（闪一下）。
   */
  runAt: 'document_start',

  main(): void {
    applyHomeAdClean();
  },
});
