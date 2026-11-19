(() => {
  // 父页面脚本：复用命名弹窗，Worker 5ms 轮询子窗口 __PLUMA_PGC__
  try {
    const old = window.__PGC_GATE_PROBE__;
    if (old) { if (old.worker) old.worker.terminate(); if (old.timer) clearInterval(old.timer); }
  } catch (e) {}
  const w = window.open('', 'probeWin');
  if (!w) return { ok: false, why: 'no handle' };
  const P = (window.__PGC_GATE_PROBE__ = {
    t0: Math.round(performance.now()),
    nonce: 'probe=' + Date.now(),
    events: [],
    samples: 0,
    workerSamples: 0,
    errors: [],
    url: 'https://www.bilibili.com/bangumi/play/ss47836&' + ('probe=' + Date.now()),
  });
  P.url = 'https://www.bilibili.com/bangumi/play/ss47836?' + P.nonce;
  const log = (m, t) => P.events.push({ t: Math.round(t == null ? performance.now() : t), m });

  const poll = () => {
    P.samples += 1;
    let tr = null;
    let now = null;
    try {
      if (!w.location.href || w.location.href.indexOf(P.nonce) === -1) return;
      tr = w.__PLUMA_PGC__;
      now = w.performance && w.performance.now();
    } catch (e) {
      if (P.errors.length < 5) P.errors.push('read: ' + e.message);
      return;
    }
    if (!tr) return;
    if (!P.trSeen) { P.trSeen = Math.round(now); log('PGC trace visible', now); }
    if (tr.createPlayerCalls > 0 && P.tCreate == null) { P.tCreate = Math.round(now); log('createPlayerCalls=1', now); }
    // 门控代理：第一条带 enabled=true 的 cfg（冷启动无缓存时，就是 page/activate 那条）
    if (tr.cfgCount > 0 && tr.lastCfgEnabled === true && P.tCfg == null) { P.tCfg = Math.round(now); log('cfgCount=' + tr.cfgCount + ' lastCfgEnabled=true', now); }
    if (tr.patchedAt > 0 && P.tPatched == null) { P.tPatched = Math.round(now); log('patchedAt=' + tr.patchedAt, now); }
    try {
      const es = w.performance.getEntriesByType('resource') || [];
      for (const e of es) {
        if (!/\/pgc\/player\/web\/playurl|\/ogv\/player\/playview/.test(e.name)) continue;
        if (!P.firstPlayurl) { P.firstPlayurl = { start: Math.round(e.startTime), init: e.initiatorType }; log('first playurl ' + e.initiatorType, e.startTime); }
      }
      let m4s = 0;
      for (const e of es) if (/\.m4s(\?|$)/.test(e.name)) m4s += 1;
      P.m4sCount = m4s;
    } catch (e) {}
    const key = [tr.createPlayerCalls, tr.cfgCount, tr.lastCfgEnabled, tr.patchedAt, tr.lastStage].join('|');
    if (key !== P.lastKey) {
      P.lastKey = key;
      P.states = P.states || [];
      if (P.states.length < 30) P.states.push({ t: Math.round(now), key });
    }
  };

  try {
    const src = 'setInterval(function(){postMessage(1)},5)';
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = () => { P.workerSamples += 1; poll(); };
    P.worker = worker;
  } catch (e) { P.errors.push('worker: ' + e.message); }
  P.timer = setInterval(poll, 20);

  try { w.location.replace(P.url); } catch (e) { P.errors.push('nav: ' + e.message); }
  try { w.blur(); window.focus(); } catch (e) {}
  return { ok: true, t0: P.t0, url: P.url };
})()
