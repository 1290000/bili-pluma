(() => {
  try { performance.setResourceTimingBufferSize(2000); } catch (e) {}
  const pl = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.player;
  const tr = window.__PLUMA_FESTIVAL__ || {};
  if (!pl || typeof pl.reload !== 'function') return { ok: false, why: 'no reload' };
  const before = { cbHits: tr.cbHits, rewritten: tr.rewritten, lastStage: tr.lastStage, at: Math.round(performance.now()) };
  try { pl.reload(); } catch (e) { return { ok: false, why: e.message, before }; }
  return { ok: true, before };
})()
