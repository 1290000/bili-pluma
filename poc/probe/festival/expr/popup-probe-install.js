(() => {
  const w = window.open('', 'probeWin');
  if (!w) return { ok: false, why: 'no handle' };
  const w2 = w;

  const P = (window.__POPUP_PROBE__ = {
    t0: Math.round(performance.now()),
    events: [],
    samples: 0,
    errors: [],
    url: 'https://www.bilibili.com/festival/bnj2026?bvid=BV1eoZ7BnEGy&probe=' + Date.now(),
  });
  const log = (m, t) => P.events.push({ t: Math.round(t == null ? performance.now() : t), m });

  const poll = () => {
    P.samples += 1;
    let tr = null;
    let now = null;
    try {
      tr = w2.__PLUMA_FESTIVAL__;
      now = w2.performance && w2.performance.now();
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
      const es = w2.performance.getEntriesByType('resource') || [];
      for (const e of es) {
        if (!/\/x\/player\/wbi\/playurl/.test(e.name)) continue;
        if (!P.firstPlayurl) {
          P.firstPlayurl = { start: Math.round(e.startTime), init: e.initiatorType };
          log('firstPlayurl ' + e.initiatorType, e.startTime);
        }
      }
    } catch (e) {}
    // 快照只在关键字段变化时记，避免数组过大
    const key = [tr.createCalls, tr.hookInstalled, tr.cbHits, tr.remounts, tr.lastStage, tr.lastQuery].join('|');
    if (key !== P.lastKey) {
      P.lastKey = key;
      P.states = P.states || [];
      if (P.states.length < 40) P.states.push({ t: Math.round(now), key });
    }
  };

  P.timer = setInterval(poll, 10);
  try { w2.location.href = P.url; } catch (e) { P.errors.push('nav: ' + e.message); }
  try { window.focus(); } catch (e) {}
  return { ok: true, t0: P.t0, url: P.url };
})()
