/**
 * 读 `window.__EP_PANELRACE__`（页面上下文，只读）。
 *
 * 报告里用来证明两件事：
 * 1. pushState 到「空窗期」里合成的点「打开 Pluma 面板」**有没有命中按钮**
 * 2. 合成点击落在 pushState 之后多少毫秒 —— 必须落在 reset→首条 seg-req 进 state
 *    的那个 600–900ms 空窗里，否则测的不是这条路径
 */
(() => {
  const C = window.__EP_PANELRACE__;
  if (!C) return JSON.stringify({ ok: false, reason: 'not-installed' });

  const R1 = (x) => Math.round(x * 10) / 10;
  return JSON.stringify({
    ok: true,
    installedAtMs: R1(C.installedAtMs),
    now: R1(performance.now()),
    url: location.hostname + location.pathname,
    pushStates: C.pushStates,
    syntheticClicks: C.syntheticClicks,
  });
})()