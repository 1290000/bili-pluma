(() => {
  const s = window.__INITIAL_STATE__ || {};
  const pl = s.player || {};
  const n = window.nano || {};
  const v = document.querySelector('video');
  const brief = (x) => {
    if (x === null) return 'null';
    if (Array.isArray(x)) return 'array(' + x.length + '):' + (x.length ? brief(x[0]) : '');
    if (typeof x === 'object') {
      let keys = [];
      try { keys = Object.keys(x).slice(0, 30); } catch (e) {}
      return 'obj{' + keys.join(',') + '}';
    }
    if (typeof x === 'function') return 'fn:' + (x.name || 'anon');
    const t = String(x);
    return typeof x + ':' + (t.length > 60 ? t.slice(0, 40) + '…' : t);
  };
  let media = null;
  try {
    const m = pl.getMediaInfo ? pl.getMediaInfo() : null;
    media = m ? { keys: Object.keys(m), playUrlBrief: brief(m.playUrl), h: m.videoHeight, w: m.videoWidth } : null;
  } catch (e) { media = 'err:' + e.message; }
  let manifest = null;
  try {
    const m = pl.getManifest ? pl.getManifest() : null;
    manifest = m ? Object.fromEntries(Object.entries(m).map(([k, x]) => [k, brief(x)])) : null;
  } catch (e) { manifest = 'err:' + e.message; }
  let qual = null;
  try {
    qual = pl.getSupportedQualityList ? brief(pl.getSupportedQualityList()) : null;
  } catch (e) { qual = 'err:' + e.message; }
  let prefetch = null;
  try {
    prefetch = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n), 'prefetch');
    prefetch = prefetch && typeof prefetch.get === 'function' ? brief(prefetch.get.call(n)) : brief(n.prefetch);
  } catch (e) { prefetch = 'err:' + e.message; }
  return {
    url: location.href,
    login: !!(s.userInfo && s.userInfo.isLogin),
    vipStatus: s.userInfo && s.userInfo.vipStatus,
    hasDedeUserID: document.cookie.includes('DedeUserID='),
    nanoType: typeof n,
    nanoCreatePlayer: typeof n.createPlayer,
    nanoPrefetch: prefetch,
    video: { h: v && v.videoHeight, w: v && v.videoWidth, dur: Math.round((v && v.duration) || 0), ready: v && v.readyState },
    quality: (() => { try { return pl.getQuality ? pl.getQuality() : null; } catch (e) { return 'err'; } })(),
    supportedQuality: qual,
    media,
    manifest,
  };
})()
