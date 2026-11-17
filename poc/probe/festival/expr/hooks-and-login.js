(async () => {
  const st = window.__INITIAL_STATE__ || {};
  const u = st.userInfo || {};
  const n = window.nano;
  return JSON.stringify({
    href: location.href,
    title: document.title,
    nanoType: typeof n,
    nanoCreatePlayerType: n && typeof n.createPlayer,
    nanoOwnKeys: n ? Object.keys(n).slice(0, 20) : [],
    nanoProtoKeys: n && Object.getPrototypeOf(n) ? Object.getOwnPropertyNames(Object.getPrototypeOf(n)).slice(0, 40) : [],
    playinfoType: typeof window.__playinfo__,
    login: { isLogin: u.isLogin, midPresent: !!u.mid, vipStatus: u.vipStatus, vipType: u.vipType },
    videoCid: st.videoInfo?.cid ?? null,
    videoBvid: st.videoInfo?.bvid ?? null,
  }, null, 2);
})()
