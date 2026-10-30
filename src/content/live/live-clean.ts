/**
 * 直播间页内清理 —— 纯样式，零逻辑、零请求（ADR 0031）。
 *
 * ## 这份文件改的是什么
 *
 * 只隐藏直播播放器上的水印 logo。三个选择器**逐字取自 Bilibili-Evolved**
 * （`registry/lib/components/live/remove-watermark/remove-watermark.scss`，MIT 许可）。
 * 署名见仓库根 `NOTICE`。
 *
 * ## 为什么不放进 Shadow DOM
 *
 * `AGENTS.md` §5.3 要求页内注入用 Shadow DOM（`mode:'closed'`），**那条针对我们自己的 UI**。
 * 而这里要隐藏的**是 B 站自己的元素**——shadow root 里的选择器**命不中文档树**，
 * 塞进去等于完全失效。ADR 0031 已把这条例外写进决策，不要"顺手改回去"。
 *
 * ## 为什么不做开关
 *
 * 水印清理没有"看情况才想要"的中间态：几乎没人希望播控上挂个 logo。
 * 放到 popup 里多一个开关，正是 `02-ui-spec.md` §0「popup 是查看器」要避免的噪音。
 *
 * ## ⚠️ 已知边界：只在"水印是 DOM 元素"时有效
 *
 * 若 B 站某类直播把水印烧进视频流（canvas / 流内），CSS 无法处理。
 * **未实测**，登记在 `docs/03-open-questions.md` Q18。
 */

export const LIVE_CLEAN_CSS = `
/* 删除直播水印 —— 与上游 Bilibili-Evolved 的三个选择器逐字一致 */
.player-ctnr .web-player-icon-roomStatus,
.live-player-ctnr .web-player-icon-roomStatus,
.bilibili-live-player-video-logo {
  display: none !important;
}
`;

/** 样式节点 id —— 便于诊断时确认"注入到没有" */
export const LIVE_CLEAN_STYLE_ID = 'pluma-live-clean';

/**
 * 把样式插进 `document.head`。
 *
 * 用 `<style>` 而不是 `chrome.scripting.insertCSS`：后者要 `scripting` 权限，
 * 而本功能只需 `host_permissions`。**不为了一个静态样式表多要一个权限。**
 */
export function applyLiveClean(doc: Document = document): boolean {
  if (doc.getElementById(LIVE_CLEAN_STYLE_ID)) return true;
  const style = doc.createElement('style');
  style.id = LIVE_CLEAN_STYLE_ID;
  style.textContent = LIVE_CLEAN_CSS;
  const target = doc.head ?? doc.documentElement;
  if (!target) return false;
  target.appendChild(style);
  return true;
}
