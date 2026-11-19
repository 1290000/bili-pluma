/**
 * 页面状态速读（只读）：video 状态 / 当前 URL 骨架 / `__playinfo__` 是否存在 / 主世界埋点。
 */
(async () => {
  const sk = (raw) => {
    try {
      const u = new URL(String(raw), location.href);
      return u.hostname + u.pathname;
    } catch {
      return '';
    }
  };
  const v = document.querySelector('video');
  const pi = window.__playinfo__;
  return JSON.stringify({
    nowMs: Math.round(performance.now()),
    timeOrigin: Math.round(performance.timeOrigin),
    url: sk(location.href),
    title: String(document.title || '').slice(0, 60),
    video: v
      ? {
          readyState: v.readyState,
          paused: v.paused,
          currentTime: Math.round(v.currentTime * 10) / 10,
          duration: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0,
          height: v.videoHeight,
          src: v.src ? sk(v.src) : '',
        }
      : null,
    hasPlayinfo: !!pi,
    playinfoKeys: pi && pi.result ? Object.keys(pi.result).slice(0, 12) : null,
    mainHook: !!window.__PLUMA_MAIN__,
    pgcTrace: window.__PLUMA_PGC__ ? Object.keys(window.__PLUMA_PGC__).slice(0, 12) : null,
    resourceCount: performance.getEntriesByType('resource').length,
    probeInstalled: !!window.__EP_SWITCH_PROBE__,
  });
})()