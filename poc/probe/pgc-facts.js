(() => {
  const ssr = window.__playinfo__;
  const r = ssr && ssr.result;
  const vi = r && r.video_info;
  const wp = r && r.watch_progress;
  const pgc = window.__PLUMA_PGC__ || {};
  const v = document.querySelector('video');
  const pl = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.player;
  let media = null;
  try { media = pl && pl.getMediaInfo ? pl.getMediaInfo() : null; } catch (e) {}
  return {
    urlKind: location.pathname.startsWith('/bangumi/play/') ? 'bangumi' : 'other',
    login: !!(window.__INITIAL_STATE__ && window.__INITIAL_STATE__.userInfo && window.__INITIAL_STATE__.userInfo.isLogin),
    playinfo: r ? {
      keys: Object.keys(r),
      playVideoType: r.play_video_type,
      watchProgress: wp ? { current: wp.current_progress ?? null, lastEp: wp.last_ep_id ? '<present>' : null } : null,
      cidPresent: !!(r.arc && r.arc.cid),
      vi: vi ? {
        quality: vi.quality, timelength: vi.timelength,
        durlGroups: vi.durls ? vi.durls.length : (vi.durl ? 1 : 0),
        hasDash: !!vi.dash,
        isPreview: vi.is_preview,
      } : null,
    } : null,
    pgcTrace: {
      lastStage: pgc.lastStage, patchedAt: pgc.patchedAt, ssrFirstSeen: pgc.ssrFirstSeen,
      ssrPlayurlBefore: pgc.ssrPlayurlBefore, skipNoGateCount: pgc.skipNoGateCount,
      pgcActive: pgc.pgcActive, cfgEnabled: pgc.cfgEnabled,
    },
    video: { t: Math.round(v?.currentTime ?? 0), dur: Math.round(v?.duration ?? 0), h: v?.videoHeight ?? 0, ready: v?.readyState ?? null, paused: v?.paused ?? null, err: v?.error?.code ?? null },
    media: media ? { abs: Math.round(media.absolutePlayTime ?? 0), rel: Math.round(media.relativePlayTime ?? 0), max: Math.round(media.maxTime ?? 0), h: media.videoHeight } : null,
    playinfoVisible: typeof window.__playinfo__ !== 'undefined',
  };
})()
