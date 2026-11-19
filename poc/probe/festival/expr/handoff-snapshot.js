(() => {
  const t = window.__PLUMA_FESTIVAL__;
  const snap = t ? JSON.parse(JSON.stringify(t)) : null;
  const v = document.querySelector('video');
  const pl = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.player;
  let q = null;
  try { const x = pl && pl.getQuality && pl.getQuality(); q = x && { newQ: x.newQ, nowQ: x.nowQ, realQ: x.realQ }; } catch (e) {}
  let cp = null;
  try {
    const f = window.nano && window.nano.createPlayer;
    cp = { type: typeof f, wrapped: !!(f && f.__plumaProbed), src: f ? String(f).slice(0, 260) : '' };
  } catch (e) { cp = { err: e.message }; }
  let src = '';
  try { src = (v && v.currentSrc || '').split('?')[0].replace(/^https?:\/\//, ''); } catch (e) {}
  return {
    now: Math.round(performance.now()),
    trace: snap,
    hook: cp,
    video: { h: v && v.videoHeight, w: v && v.videoWidth, dur: Math.round((v && v.duration) || 0), t: Math.round((v && v.currentTime) || 0), ready: v && v.readyState, srcHost: src },
    quality: q,
    login: !!(window.__INITIAL_STATE__ && window.__INITIAL_STATE__.userInfo && window.__INITIAL_STATE__.userInfo.isLogin),
  };
})()
