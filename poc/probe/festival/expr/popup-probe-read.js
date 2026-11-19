(() => {
  const P = window.__POPUP_PROBE__ || {};
  let w = null;
  try { w = window.open('', 'probeWin'); } catch (e) {}
  let child = null;
  try {
    if (w) {
      const tr = w.__PLUMA_FESTIVAL__ || null;
      child = {
        href: w.location.href,
        trace: tr ? {
          createCalls: tr.createCalls, hookInstalled: tr.hookInstalled, cbHits: tr.cbHits,
          remounts: tr.remounts, spaSwaps: tr.spaSwaps, rewritten: tr.rewritten, fallbacks: tr.fallbacks,
          lastStage: tr.lastStage, lastQuery: !!tr.lastQuery, lastRespCode: tr.lastRespCode,
          lastStatus: tr.lastStatus, lastCid: tr.lastCid, nanoSets: tr.nanoSets,
        } : null,
        now: (() => { try { return Math.round(w.performance.now()); } catch (e) { return null; } })(),
        resources: (() => {
          try {
            return (w.performance.getEntriesByType('resource') || [])
              .filter((e) => /\/x\/player\/wbi\/playurl/.test(e.name))
              .map((e) => ({ start: Math.round(e.startTime), init: e.initiatorType, dur: Math.round(e.duration) }));
          } catch (e) { return []; }
        })(),
        video: (() => { try { const v = w.document.querySelector('video'); return v ? { h: v.videoHeight, w: v.videoWidth, dur: Math.round(v.duration || 0), t: Math.round(v.currentTime || 0), ready: v.readyState } : null; } catch (e) { return null; } })(),
        identity: (() => {
          try {
            const ck = w.document.cookie || '';
            const mm = ck.match(/(?:^|;\s*)DedeUserID=(\d+)/);
            const pageMid = mm ? mm[1] : '';
            const ids = new Set();
            for (const e of w.performance.getEntriesByType('resource') || []) {
              if (!/\.m4s(\?|$)/.test(e.name)) continue;
              const mid = new URL(e.name).searchParams.get('mid');
              if (mid) ids.add(mid);
            }
            const uniq = [...ids];
            return { pageMidPresent: !!pageMid, m4sMidCount: uniq.length, anyMatchMain: uniq.some((x) => x === pageMid), allMatchMain: uniq.length > 0 && uniq.every((x) => x === pageMid) };
          } catch (e) { return { err: e.message }; }
        })(),
      };
    }
  } catch (e) { child = { err: e.message }; }
  return { probe: P, child };
})()
