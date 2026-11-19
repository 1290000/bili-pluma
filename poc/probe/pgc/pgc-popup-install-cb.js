(() => {
  try {
    const old = window.__PGC_GATE_PROBE__;
    if (old) { if (old.worker) old.worker.terminate(); if (old.timer) clearInterval(old.timer); }
  } catch (e) {}
  const w = window.open('', 'probeWin');
  if (!w) return { ok: false, why: 'no handle' };
  const P = (window.__PGC_GATE_PROBE__ = {
    t0: Math.round(performance.now()), nonce: 'probe=' + Date.now(), events: [], samples: 0, workerSamples: 0, errors: [],
  });
  P.url = 'https://www.bilibili.com/bangumi/play/ss47836?' + P.nonce;
  const log = (m, t) => P.events.push({ t: Math.round(t == null ? performance.now() : t), m });

  const wrapNano = (v) => {
    if (!v || typeof v.createPlayer !== 'function' || v.createPlayer.__pgcCbWrapped) return;
    const orig = v.createPlayer;
    v.createPlayer = function (config) {
      P.tCreateExact = Math.round(w.performance.now());
      try {
        const rc = config && config.requestConfig;
        const origCb = rc && rc.reqHttpPlayUrlInfo;
        if (origCb && typeof origCb === 'function') {
          rc.reqHttpPlayUrlInfo = function (params, cfg) {
            P.tCb = Math.round(w.performance.now());
            P.cbParamsKeys = Object.keys(params || {});
            return origCb.call(this, params, cfg);
          };
          P.cbInjected = true;
        }
      } catch (e) { P.errors.push('cb inject: ' + e.message); }
      return orig.call(this, config);
    };
    v.createPlayer.__pgcCbWrapped = true;
    P.nanoWrapped = true;
  };

  const hookNano = () => {
    if (P.nanoHooked) return;
    try {
      if (!w.document || w.document.readyState === 'uninitialized') return;
      let ref = w.nano;
      w.Object.defineProperty(w, 'nano', {
        configurable: true,
        enumerable: true,
        get() { return ref; },
        set(v) { ref = v; wrapNano(v); },
      });
      if (ref) wrapNano(ref);
      P.nanoHooked = true;
      P.nanoHookAt = Math.round(w.performance.now());
      log('nano hook installed', P.nanoHookAt);
    } catch (e) { P.errors.push('nano hook: ' + e.message); }
  };

  const poll = () => {
    P.samples += 1;
    let tr = null; let now = null;
    try {
      if (!w.location.href || w.location.href.indexOf(P.nonce) === -1) return;
      hookNano();
      tr = w.__PLUMA_PGC__;
      now = w.performance && w.performance.now();
    } catch (e) { if (P.errors.length < 5) P.errors.push('read: ' + e.message); return; }
    if (!tr) return;
    if (tr.createPlayerCalls > 0 && P.tCreate == null) { P.tCreate = Math.round(now); log('createPlayerCalls=1', now); }
    if (tr.cfgCount > 0 && tr.lastCfgEnabled === true && P.tCfg == null) { P.tCfg = Math.round(now); log('cfg gate', now); }
    if (tr.patchedAt > 0 && P.tPatched == null) { P.tPatched = Math.round(now); }
    try {
      const es = w.performance.getEntriesByType('resource') || [];
      for (const e of es) {
        if (!/\/pgc\/player\/web\/playurl|\/ogv\/player\/playview/.test(e.name)) continue;
        if (!P.firstPlayurl) P.firstPlayurl = { start: Math.round(e.startTime), init: e.initiatorType };
      }
    } catch (e) {}
  };

  try {
    const worker = new Worker(URL.createObjectURL(new Blob(['setInterval(function(){postMessage(1)},5)'], { type: 'text/javascript' })));
    worker.onmessage = () => { P.workerSamples += 1; poll(); };
    P.worker = worker;
  } catch (e) { P.errors.push('worker: ' + e.message); }
  P.timer = setInterval(poll, 20);
  try { w.location.replace(P.url); } catch (e) { P.errors.push('nav: ' + e.message); }
  try { w.blur(); window.focus(); } catch (e) {}
  return { ok: true, url: P.url };
})()
