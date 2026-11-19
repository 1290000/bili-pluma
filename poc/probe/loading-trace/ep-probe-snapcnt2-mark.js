/**
 * 在 snapcnt2 的计数器上打一个标记（页面上下文，只读）。
 *
 * 用法：在某个事件（换集点击 / 打开面板 / 点 ⟳）**前后**各打一条，
 * 之后用 `ep-probe-snapcnt2-read.js` 看两段之间有没有 `loading-snapshot` 请求。
 *
 * 表达式末尾那个字面量就是标记文本 —— 由调用方在 `bsk-eval` 之前
 * 用 sed 替换，见报告「复现命令」一节。
 */
(() => {
  const C = window.__EP_SNAPCNT__;
  if (!C || typeof C.markNow !== 'function') return JSON.stringify({ ok: false, reason: 'not-installed' });
  const label = 'MARK_LABEL';
  C.markNow(label);
  return JSON.stringify({ ok: true, label, t: Math.round(performance.now() * 10) / 10, totalReqs: C.reqs.length });
})()