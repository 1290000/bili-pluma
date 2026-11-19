(() => {
  const pl = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.player;
  const tr = window.__PLUMA_FESTIVAL__ || {};
  if (!pl || typeof pl.reload !== 'function') return { ok: false, why: 'no reload' };
  let r = null;
  try { r = pl.reload(); } catch (e) { return { ok: false, why: e.message }; }
  return {
    ok: true,
    at: Math.round(performance.now()),
    before: { cbHits: tr.cbHits, lastQuery: !!tr.lastQuery, lastRespCode: tr.lastRespCode, lastStage: tr.lastStage, rewritten: tr.rewritten },
    ret: typeof r,
  };
})()
