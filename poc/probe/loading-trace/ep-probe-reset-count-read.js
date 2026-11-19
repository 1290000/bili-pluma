/**
 * 「换集后到底有几次 reset」· 读取端（页面上下文，只读）。
 *
 * 返回标记清单 + 快照变化段 + 当前快照里还活着的 `playurl-req` 时刻，
 * 用它们判定"最早的存活标记"（= 此后无 reset）。
 */
(async () => {
  const S = window.__EP_RESET_COUNT__;
  if (!S) return JSON.stringify({ ok: false, reason: 'not-installed' });

  try {
    await S.pollOnce();
  } catch {
    /* 忽略 */
  }
  S.flush();

  const snapped = await new Promise((resolve) => {
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

  const events = snapped && Array.isArray(snapped.events) ? snapped.events : [];
  const playurlReqs = events.filter((e) => e.stage === 'playurl-req').map((e) => Math.round(e.t * 10) / 10);

  const R1 = (x) => Math.round(x * 10) / 10;
  return JSON.stringify({
    ok: true,
    nowMs: R1(performance.now()),
    installedAtMs: R1(S.installedAtMs),
    url: S.url0,
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
    markers: S.markers,
    runs: S.runs,
    errors: S.errors,
    livePlayurlReqs: playurlReqs,
    liveHostsLen: snapped && Array.isArray(snapped.hosts) ? snapped.hosts.length : null,
    liveStages: events.map((e) => [e.stage, Math.round(e.t * 10) / 10, e.note || '']),
    liveVideo: snapped ? snapped.video : null,
  });
})()