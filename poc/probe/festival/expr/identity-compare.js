(() => {
  const tr = window.__PLUMA_FESTIVAL__ || {};
  const v = document.querySelector('video');
  const ck = document.cookie || '';
  const m = ck.match(/(?:^|;\s*)DedeUserID=(\d+)/);
  const pageMid = m ? m[1] : '';
  const ids = new Set();
  const rows = [];
  for (const e of performance.getEntriesByType('resource') || []) {
    if (!/\.m4s(\?|$)/.test(e.name)) continue;
    try {
      const u = new URL(e.name);
      const mid = u.searchParams.get('mid');
      if (mid) ids.add(mid);
      if (rows.length < 6) rows.push({ init: e.initiatorType, start: Math.round(e.startTime), midMatchMain: mid && pageMid ? mid === pageMid : null });
    } catch (err) {}
  }
  const uniq = [...ids];
  const pl = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.player;
  let q = null;
  try { const x = pl && pl.getQuality(); q = x && { newQ: x.newQ, nowQ: x.nowQ }; } catch (e) {}
  return {
    now: Math.round(performance.now()),
    pageMidPresent: !!pageMid,
    m4sMidCount: uniq.length,
    allM4sMatchMain: uniq.length > 0 && uniq.every((x) => x === pageMid),
    anyM4sMatchMain: uniq.some((x) => x === pageMid),
    // 不输出任何 mid 数字，只输出相对关系与条数
    m4sRows: rows,
    trace: { cbHits: tr.cbHits, lastStage: tr.lastStage, lastQuery: !!tr.lastQuery, lastRespCode: tr.lastRespCode, rewritten: tr.rewritten, remounts: tr.remounts, createCalls: tr.createCalls },
    video: { h: v && v.videoHeight, w: v && v.videoWidth, t: Math.round((v && v.currentTime) || 0), dur: Math.round((v && v.duration) || 0) },
    quality: q,
  };
})()
