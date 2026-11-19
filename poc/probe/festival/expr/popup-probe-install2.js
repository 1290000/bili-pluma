(() => {
  // 清理上一轮的 worker / interval，避免泄漏
  try {
    const old = window.__POPUP_PROBE__;
    if (old) {
      if (old.worker) old.worker.terminate();
      if (old.timer) clearInterval(old.timer);
    }
  } catch (e) {}
  const w = window.open('', 'probeWin');
  if (!w) return { ok: false, why: 'no handle' };
  const P = (window.__POPUP_PROBE__ = {
    t0: Math.round(performance.now()),
    events: [],
    samples: 0,
    workerSamples: 0,
    errors: [],
    nonce: 'probe=' + Date.now(),
    url: 'https://www.bilibili.com/festival/bnj2026?bvid=BV1eoZ7BnEGy&probe=' + Date.now(),
    visibility: document.visibilityState,
  });
  P.url = 'https://www.bilibili.com/festival/bnj2026?bvid=BV1eoZ7BnEGy&' + P.nonce;
  const log = (m, t) => P.events.push({ t: Math.round(t == null ? performance.now() : t), m });

  const poll = () => {
    P.samples += 1;
    let tr = null;
    let now = null;
    try {
      // 只接受本次导航后的文档；旧文档的同名字段不能算
      if (!w.location.href || w.location.href.indexOf(P.nonce) === -1) return;
      tr = w.__PLUMA_FESTIVAL__;
      now = w.performance && w.performance.now();
    } catch (e) {
      if (P.errors.length < 5) P.errors.push('read: ' + e.message);
      return;
    }
    if (!tr) return;
    if (!P.trSeen) { P.trSeen = Math.round(now); log('trace object visible', now); }
    if (tr.createCalls > 0 && P.tCreate == null) { P.tCreate = Math.round(now); log('createCalls=1', now); }
    if (tr.hookInstalled && P.tHook == null) { P.tHook = Math.round(now); log('hookInstalled=true', now); }
    if (tr.cbHits > 0 && P.tCb == null) { P.tCb = Math.round(now); log('cbHits=' + tr.cbHits, now); }
    if (tr.remounts > 0 && P.tRemount == null) { P.tRemount = Math.round(now); log('remounts=' + tr.remounts, now); }
    try {
      const es = w.performance.getEntriesByType('resource') || [];
      for (const e of es) {
        if (!/\/x\/player\/wbi\/playurl/.test(e.name)) continue;
        if (!P.firstPlayurl) {
          P.firstPlayurl = { start: Math.round(e.startTime), init: e.initiatorType };
          log('firstPlayurl ' + e.initiatorType, e.startTime);
        }
      }
    } catch (e) {}
    const key = [tr.createCalls, tr.hookInstalled, tr.cbHits, tr.remounts, tr.lastStage, tr.lastQuery].join('|');
    if (key !== P.lastKey) {
      P.lastKey = key;
      P.states = P.states || [];
      if (P.states.length < 60) P.states.push({ t: Math.round(now), key });
    }
  };

  // Worker 计时不受后台页 1s 节流影响；onmessage 回到主线程读子窗口
  try {
    const src = 'setInterval(function(){postMessage(1)},5)';
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = () => { P.workerSamples += 1; poll(); };
    P.worker = worker;
  } catch (e) {
    P.errors.push('worker: ' + e.message);
  }
  // 兜底（可能被节流）
  P.timer = setInterval(poll, 20);

  try { w.location.replace(P.url); } catch (e) { P.errors.push('nav: ' + e.message); }
  try { w.blur(); window.focus(); } catch (e) {}
  return { ok: true, t0: P.t0, url: P.url, visibility: P.visibility };
})()
