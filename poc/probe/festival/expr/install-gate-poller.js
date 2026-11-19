(() => {
  const tr = window.__PLUMA_FESTIVAL__;
  const now = Math.round(performance.now());
  const P = {
    t0: now,
    hookAtStart: !!(tr && tr.hookInstalled),
    traceAtStart: tr ? { cbHits: tr.cbHits, createCalls: tr.createCalls, hookInstalled: tr.hookInstalled, remounts: tr.remounts, lastStage: tr.lastStage, lastQuery: !!tr.lastQuery } : null,
    hookAt: null,
    createAt: null,
    updateAt: null,
    updateArg: null,
    samples: [],
  };
  window.__GATE__ = P;
  const tick = () => {
    const t = window.__PLUMA_FESTIVAL__;
    if (!t) return;
    if (t.createCalls > 0 && P.createAt == null) P.createAt = Math.round(performance.now());
    if (t.hookInstalled && P.hookAt == null) P.hookAt = Math.round(performance.now());
  };
  setInterval(tick, 10);
  try {
    const pl = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.player;
    if (pl && typeof pl.updateRequestConfig === 'function' && !pl.__gateWrapped) {
      const o = pl.updateRequestConfig;
      pl.updateRequestConfig = function (arg) {
        P.updateAt = Math.round(performance.now());
        P.updateArg = arg && typeof arg === 'object' ? Object.keys(arg) : null;
        return o.apply(this, arguments);
      };
      pl.__gateWrapped = true;
      P.wrappedUpdate = true;
    }
  } catch (e) { P.wrapErr = e.message; }
  return P;
})()
