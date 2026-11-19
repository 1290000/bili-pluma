/**
 * 读**静默计数器**（`__EP_QUIETCOUNT__`）—— 面板取数次数，按标记切段（页面上下文，只读）。
 *
 * ## 与 `ep-probe-snapcnt2-read.js` 的区别
 *
 * snapcnt2 读的是 `__EP_SNAPCNT__`，那是**静默之前**装的实例，计数被主探针的
 * 20ms 采样污染（6056 条里 6055 条是我自己发的）。静默探针 `ep-probe-quiet.js`
 * 另建了 `__EP_QUIETCOUNT__`，只在「所有探针定时器都停掉之后」才开始记。
 *
 * 本读取器只读后者，并按 `marks` 把请求切成互不重叠的窗口 —— 这样每个窗口的
 * `n` 都可以独立解释为「这个窗口内面板取了几次数」。
 */
(() => {
  const C = window.__EP_QUIETCOUNT__;
  if (!C) return JSON.stringify({ ok: false, reason: 'quiet-not-installed' });

  const R1 = (x) => Math.round(x * 10) / 10;
  const now = R1(performance.now());
  const marks = C.marks.slice();
  const segs = marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].t : now;
    const inSeg = C.reqs.filter((r) => r.t >= m.t && r.t < end);
    return {
      label: m.label,
      tFrom: m.t,
      tTo: i + 1 < marks.length ? R1(end) : null,
      spanMs: R1(end - m.t),
      n: inSeg.length,
      t: inSeg.slice(0, 12).map((r) => r.t),
    };
  });

  return JSON.stringify({
    ok: true,
    installedAtMs: R1(C.installedAtMs),
    now,
    url: location.hostname + location.pathname,
    totalReqs: C.reqs.length,
    allReqT: C.reqs.map((r) => r.t),
    segs,
    unmarkedBefore:
      marks.length && marks[0].t > C.installedAtMs
        ? C.reqs.filter((r) => r.t < marks[0].t).length
        : 0,
  });
})()