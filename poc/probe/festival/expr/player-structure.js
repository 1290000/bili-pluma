(async () => {
  const st = window.__INITIAL_STATE__ || {};
  const player = st.player || {};
  const videoInfo = st.videoInfo || {};
  const v = document.querySelector('video');
  const cookieNames = document.cookie.split(';').map((p) => p.trim().split('=')[0]).filter(Boolean);
  return JSON.stringify({
    href: location.href,
    title: document.title,
    nanoType: typeof window.nano,
    nanoKeys: window.nano && typeof window.nano === 'object' ? Object.keys(window.nano).slice(0, 20) : [],
    playerKeys: Object.keys(player).slice(0, 40),
    playerCid: player.cid ?? null,
    playerQuality: player.quality ?? null,
    videoInfoKeys: Object.keys(videoInfo).slice(0, 30),
    videoPageKeys: st.videoPage && typeof st.videoPage === 'object' ? Object.keys(st.videoPage).slice(0, 20) : [],
    userInfoKeys: st.userInfo && typeof st.userInfo === 'object' ? Object.keys(st.userInfo).slice(0, 20) : [],
    isVideo: st.isVideo,
    isLive: st.isLive,
    isModern: st.isModern,
    videoElement: v ? { present: true, readyState: v.readyState, currentSrcHost: (() => { try { return new URL(v.currentSrc).host; } catch { return ''; } })(), srcHost: (() => { try { return new URL(v.src).host; } catch { return ''; } })() } : { present: false },
    playinfoDescriptor: (() => { const d = Object.getOwnPropertyDescriptor(window, '__playinfo__'); return d ? { configurable: d.configurable, enumerable: d.enumerable, hasGet: typeof d.get === 'function', hasSet: typeof d.set === 'function' } : null; })(),
    cookieNames: cookieNames.filter((n) => /^(SESSDATA|bili_jct|DedeUserID|buvid3|buvid4|b_nut|_uuid|bili_ticket|sid)$/.test(n)),
  }, null, 2);
})()
