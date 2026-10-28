/**
 * 主世界内容脚本入口 —— **极薄**，只做一件事：把 `src/content/main-world.js` 跑在 MAIN world。
 *
 * ## 为什么需要它（2026-10-27 真机踩到的致命问题）
 *
 * 原来主世界脚本是 ISOLATED world 用 `<script src=chrome-extension://…/main-world.js>`
 * 注入的。**那是异步加载**：`async = false` 只管动态脚本之间的**执行顺序**，
 * 既不阻塞 HTML 解析，也不保证早于页面的内联脚本。
 *
 * 而 PGC 页的 `window.nano = …` 与 `createPlayer(…)` 全在**内联脚本**里。
 * 实测（ss34412）：`__PLUMA_MAIN__ === true`（脚本确实执行了）但 `nano` 的 hook
 * 没装上、`__playinfo__` 的 descriptor 还是原生的 —— 整个 PGC 分支**静默失效**。
 *
 * 试过内联注入（`script.text`），但 MV3 的 `extension_pages` CSP **拒绝**
 * `script-src 'unsafe-inline'`——Edge 156 直接报「Insecure CSP value」且**装不上扩展**
 * （改 `minimum_chrome_version` 也无效）。平台层面封死。
 *
 * ## 现在的做法
 *
 * 用 `world: 'MAIN'` 内容脚本 —— 浏览器在 `document_start` 直接把它注入 MAIN world，
 * 不需要任何内联脚本，也不受 CSP 限制，时机正好早于页面的 SSR 内联脚本。
 *
 * ## 为什么不把它搬成 TS
 *
 * 那是近 3000 行纯 JS，**不参与 TS 编译、也不进 ESLint**（见 `docs/04-project-structure.md` §6
 * 「主世界脚本怎么测」）：测试直接 `eval` 它，保证测的是真源码。搬成 TS 会引入
 * 第二个构建产物和"构建后才知道长什么样"的漂移风险。这里只是**换一个更早的运行环境**。
 *
 * ## 为什么是 `import` 而不是 `<script src>`
 *
 * `import` 让脚本**打进本入口的 bundle**，由浏览器在 `document_start` 注入时一并执行。
 * 它因此**不再是 `public/` 里的静态资源**，也就不需要 `web_accessible_resources` ——
 * 那段声明曾经留在 manifest 里，实际已无人使用，只是让全站页面都能 fetch 到这个文件
 * （2026-10-28 审查发现后删除）。
 *
 * ⚠️ 本文件与 `entrypoints/content.ts` **必须同时存在**：
 *   - 这个（MAIN）：装 hook，看不到 `chrome.*`
 *   - 那个（ISOLATED）：报到 / 装 DNR / 下发配置
 * 缺任何一个，功能都不会生效。
 */

import '@/src/content/main-world.js';

export default defineContentScript({
  /**
   * 与 `entrypoints/content.ts` 保持同一组匹配 —— 两边必须同时生效。
   *
   * `world: 'MAIN'`：由浏览器直接注入页面主世界，早于页面的内联脚本，
   * 且不需要 `web_accessible_resources` / 内联 `<script>`（后者会被 CSP 拒）。
   */
  matches: ['*://*.bilibili.com/video/*', '*://*.bilibili.com/bangumi/play/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // 主世界逻辑全部在 `src/content/main-world.js` 的 IIFE 里，import 时已执行。
  },
});
