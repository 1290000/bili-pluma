(() => {
  const es = performance.getEntriesByType('resource') || [];
  const rows = es.map((e) => {
    let path = '';
    try { path = new URL(e.name).pathname; } catch (err) { path = String(e.name).slice(0, 60); }
    return { start: Math.round(e.startTime), init: e.initiatorType, path, dur: Math.round(e.duration) };
  }).filter((r) => /api\.bilibili\.com|\/x\/player/.test(r.path) || /playurl/.test(r.path));
  return { now: Math.round(performance.now()), total: es.length, rows, trace: (() => { const t = window.__PLUMA_FESTIVAL__ || {}; return { cbHits: t.cbHits, lastStage: t.lastStage, lastQuery: !!t.lastQuery, lastRespCode: t.lastRespCode, rewritten: t.rewritten, lastCid: t.lastCid }; })() };
})()
