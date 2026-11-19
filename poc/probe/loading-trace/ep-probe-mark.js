/**
 * 模板：给静默计数器打一个标记（页面上下文，只读）。
 *
 * `MARK_LABEL` 由调用方在跑 `bsk-eval` 之前用 `sed` 替换成具体标签。
 * 存在意义：把「换集前 / 换集后 / 开面板后 / 点⟳后」切成互不重叠的窗口，
 * 之后 `ep-probe-snapcnt2-read.js` 会按标记切段报每段的 `loading-snapshot` 条数。
 */
(() => {
  const C = window.__EP_QUIETCOUNT__ || window.__EP_SNAPCNT__;
  if (!C || typeof C.markNow !== 'function') {
    return JSON.stringify({ ok: false, reason: 'not-installed', ep: Object.keys(window).filter((k) => k.indexOf('__EP') === 0) });
  }
  const label = 'MARK_LABEL';
  C.markNow(label);
  return JSON.stringify({ ok: true, label, t: Math.round(performance.now() * 10) / 10, totalReqs: C.reqs.length });
})()