/**
 * 「换集后到底有几次 reset」· 细粒度读取（页面上下文，只读）。
 *
 * 返回还活着的 `playurl-req` 时刻（按 `t`）、全部标记的调度时刻、
 * 以及 `hosts` 条数随时间的变化段 —— 调用侧据此判断
 * "最早存活标记" 与 "空窗区间"。
 */
(async () => {
  const S = window.__EP_RESET_FINE__;
  if (!S) return JSON.stringify({ ok: false, reason: 'not-installed' });

  const snap = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1200);
      const h = (ev) => {
        const d = ev.data;
        if (!d || d.__ns !== '__PLUMA__' || d.type !== 'loading-snapshot-reply') return;
        clearTimeout(timer);
        window.removeEventListener('message', h);
        resolve(d.snapshot);
      };
      window.addEventListener('message', h);
      window.postMessage({ __ns: '__PLUMA__', type: 'loading-snapshot' }, '*');
    });

  const s = await snap();
  const evs = s && Array.isArray(s.events) ? s.events : [];
  const R1 = (x) => Math.round(x * 10) / 10;

  // 把 20ms 采样压成"hosts 条数变化段"
  const segs = [];
  for (const x of S.samples) {
    const last = segs[segs.length - 1];
    if (last === undefined || last.hostsLen !== x.hostsLen) {
      segs.push({ tFrom: x.t, tTo: x.t, hostsLen: x.hostsLen, nEvents: x.nEvents });
    } else {
      last.tTo = x.t;
      last.nEvents = x.nEvents;
    }
  }

  return JSON.stringify({
    ok: true,
    nowMs: R1(performance.now()),
    url0: S.url0,
    currentUrl: (() => {
      try {
        const u = new URL(location.href);
        return u.hostname + u.pathname;
      } catch {
        return '';
      }
    })(),
    clicks: S.clicks,
    pushStates: S.pushStates,
    markers: S.markers.map((m) => ({ i: m.i, tSched: m.tSched, http: m.http ?? null })),
    livePlayurlReqs: evs.filter((e) => e.stage === 'playurl-req').map((e) => R1(e.t)),
    liveStages: evs.map((e) => [e.stage, R1(e.t), e.note || '']),
    liveHostsLen: s && Array.isArray(s.hosts) ? s.hosts.length : null,
    liveVideo: s ? s.video : null,
    sampleCount: S.samples.length,
    hostSegs: segs,
  });
})()