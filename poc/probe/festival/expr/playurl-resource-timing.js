(() => {
  const safe = (u) => {
    try {
      const x = new URL(u);
      return x.host + x.pathname + '?qn=' + (x.searchParams.get('qn') || '') +
        '&fnval=' + (x.searchParams.get('fnval') || '') +
        '&w_rid=' + (x.searchParams.has('w_rid') ? '<present>' : '<absent>') +
        '&wts=' + (x.searchParams.get('wts') || '');
    } catch (e) { return '<unparsable>'; }
  };
  const es = performance.getEntriesByType('resource') || [];
  const hits = es.filter((e) => /\/x\/player\/(wbi\/)?playurl/.test(e.name || ''))
    .map((e) => ({
      start: Math.round(e.startTime),
      end: Math.round(e.startTime + e.duration),
      duration: Math.round(e.duration),
      initiator: e.initiatorType,
      url: safe(e.name),
      size: e.transferSize,
    }));
  const tr = window.__PLUMA_FESTIVAL__ || {};
  return {
    now: Math.round(performance.now()),
    playurlResources: hits,
    trace: {
      cbHits: tr.cbHits, createCalls: tr.createCalls, nanoSets: tr.nanoSets,
      lastStage: tr.lastStage, lastQuery: !!tr.lastQuery, lastStatus: tr.lastStatus,
      lastRespCode: tr.lastRespCode, rewritten: tr.rewritten, remounts: tr.remounts,
      fallbacks: tr.fallbacks, errors: tr.errors, lastCid: tr.lastCid,
    },
  };
})()
