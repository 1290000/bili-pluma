(async () => {
  const entries = performance.getEntriesByType('resource').filter((e) => /\/x\/player\/wbi\/playurl\?/.test(e.name));
  if (!entries.length) return JSON.stringify({ error: 'no playurl entry' });
  const url = entries[entries.length - 1].name;
  const bridge = await new Promise((res) => {
    const t = setTimeout(() => res({ jsTimeout: true }), 6000);
    const h = (e) => {
      if (e.data?.__ns === '__PLUMA__' && e.data.type === 'streaming-probe-reply') {
        clearTimeout(t); window.removeEventListener('message', h); res(e.data.trace);
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'streaming-probe', probeTypes: ['proxy/status'] }, '*');
  });
  const summarize = (b) => {
    const d = (b && b.data) || {};
    const vids = Array.isArray(d.dash?.video) ? d.dash.video : [];
    const ids = [...new Set(vids.map((v) => v.id))].sort((a, b) => b - a);
    const heights = [...new Set(vids.map((v) => v.height))].sort((a, b) => b - a);
    return {
      code: b?.code, quality: d.quality, accept_quality: d.accept_quality,
      format: d.format, hasDash: !!d.dash, videoCount: vids.length,
      dashIds: ids, dashHeights: heights,
      dash120: vids.filter((v) => v.id === 120).length,
      hasDurl: Array.isArray(d.durl) && d.durl.length > 0,
      dolbyVision: !!(d.dash?.dolby?.vision), hasFlac: !!(d.dash?.flac),
      dolbyAudio: Array.isArray(d.dash?.dolby?.audio) ? d.dash.dolby.audio.length : 0,
    };
  };
  let fetchResult;
  try {
    const r = await fetch(url, { credentials: 'include' });
    const b = await r.json();
    fetchResult = { status: r.status, body: summarize(b) };
  } catch (e) { fetchResult = { error: String(e) }; }
  return JSON.stringify({
    href: location.href,
    proxy: bridge ? { identity: bridge.identity ?? null, proxyEnabled: bridge.proxyEnabled ?? null } : null,
    qnRequested: new URL(url).searchParams.get('qn'),
    fetchResult,
  }, null, 2);
})()
