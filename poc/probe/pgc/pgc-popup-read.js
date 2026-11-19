(() => {
  const P = window.__PGC_GATE_PROBE__ || {};
  let w = null;
  try { w = window.open('', 'probeWin'); } catch (e) {}
  let child = null;
  try {
    if (w) {
      const tr = w.__PLUMA_PGC__ || null;
      child = {
        hrefHasNonce: !!(w.location.href && P.nonce && w.location.href.indexOf(P.nonce) !== -1),
        trace: tr ? {
          bootAt: tr.bootAt, patchedAt: tr.patchedAt, cfgCount: tr.cfgCount,
          lastCfgEnabled: tr.lastCfgEnabled, lastStage: tr.lastStage,
          createPlayerAt: tr.createPlayerAt, createPlayerCalls: tr.createPlayerCalls,
          ssHit: tr.ssHit, cacheBytes: tr.cacheBytes, playinfoAt: tr.playinfoAt,
          skipInactiveCount: tr.skipInactiveCount, skipNoGateCount: tr.skipNoGateCount,
        } : null,
        now: (() => { try { return Math.round(w.performance.now()); } catch (e) { return null; } })(),
        video: (() => { try { const v = w.document.querySelector('video'); return v ? { h: v.videoHeight, w: v.videoWidth, dur: Math.round(v.duration || 0), t: Math.round(v.currentTime || 0), ready: v.readyState, src: (v.currentSrc || '').slice(0, 60) } : null; } catch (e) { return null; } })(),
      };
    }
  } catch (e) { child = { err: e.message }; }
  return { probe: P, child, exact: { tCreateExact: P.tCreateExact ?? null, tCb: P.tCb ?? null, tCfg: P.tCfg ?? null, nanoHooked: !!P.nanoHooked, nanoHookAt: P.nanoHookAt ?? null, cbInjected: !!P.cbInjected, cbParamsKeys: P.cbParamsKeys || null } };
})()
