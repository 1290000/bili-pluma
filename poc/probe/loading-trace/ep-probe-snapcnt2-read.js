/**
 * 读 `ep-probe-snapcnt2.js` 的计数（页面上下文，只读）。
 *
 * 返回：安装时刻、当前 URL、pushState 记录、点击记录、标记、以及
 * **按标记切段**的请求计数（`segs`）。这样即便有零星残留请求，
 * 也能看出「某一段窗口内到底有没有请求」。
 */
(() => {
  const C = window.__EP_SNAPCNT__;
  if (!C) return JSON.stringify({ ok: false, reason: 'not-installed' });

  const R1 = (x) => Math.round(x * 10) / 10;
  const now = R1(performance.now());

  // 按 marks 切段：每段统计落在 [mark.t, nextMark.t) 内的请求
  const marks = C.marks.slice();
  const segs = marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].t : now;
    const inSeg = C.reqs.filter((r) => r.t >= m.t && r.t < end);
    return { label: m.label, tFrom: m.t, tTo: i + 1 < marks.length ? R1(end) : null, n: inSeg.length, t: inSeg.slice(0, 12).map((r) => r.t) };
  });

  return JSON.stringify({
    ok: true,
    installedAtMs: R1(C.installedAtMs),
    now,
    url: location.hostname + location.pathname,
    totalReqs: C.reqs.length,
    firstReqT: C.reqs.length ? C.reqs[0].t : null,
    lastReqT: C.reqs.length ? C.reqs[C.reqs.length - 1].t : null,
    marks,
    segs,
    pushStates: C.pushStates,
    clicks: C.clicks,
  });
})()