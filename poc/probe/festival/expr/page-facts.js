(async () => {
  const devNames = ['buvid3','buvid4','buvid_fp','b_nut','_uuid','bili_ticket','bili_ticket_expires'];
  const authNames = ['SESSDATA','bili_jct','DedeUserID','sid','buvid5','b_lsid'];
  const cookieNames = document.cookie.split(';').map((p) => p.trim().split('=')[0]).filter(Boolean);
  const perf = performance.getEntriesByType('resource').map((e) => {
    try {
      const u = new URL(e.name);
      return { host: u.host, path: u.pathname, keys: [...u.searchParams.keys()].slice(0, 40) };
    } catch {
      return { host: '-', path: String(e.name).slice(0, 80), keys: [] };
    }
  }).filter((x) => /playurl|playview|\/player\//.test(x.path));
  const playurlReqs = performance.getEntriesByType('resource')
    .filter((e) => /playurl/.test(e.name));
  return JSON.stringify({
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    hasPlayinfo: typeof window.__playinfo__ !== 'undefined',
    playinfoKeys: window.__playinfo__ && typeof window.__playinfo__ === 'object' ? Object.keys(window.__playinfo__) : [],
    hasInitialState: typeof window.__INITIAL_STATE__ !== 'undefined',
    initialStateKeys: window.__INITIAL_STATE__ && typeof window.__INITIAL_STATE__ === 'object' ? Object.keys(window.__INITIAL_STATE__).slice(0, 30) : [],
    hasPlumaMain: typeof window.__PLUMA_MAIN__ !== 'undefined',
    globals: ['createPlayer','Player','BilibiliPlayer','__player__','__biliPlayer'].filter((k) => typeof window[k] !== 'undefined'),
    cookieDevice: Object.fromEntries(devNames.map((n) => [n, cookieNames.includes(n)])),
    cookieAuthPresence: Object.fromEntries(authNames.map((n) => [n, cookieNames.includes(n)])),
    cookieCount: cookieNames.length,
    perfPlayerReqs: perf,
    playurlPerfCount: playurlReqs.length,
    scriptsWithPlayer: [...document.scripts].map((s) => s.src).filter((s) => /player|bilibili|festival/i.test(s)).slice(0, 20).map((s) => { try { const u = new URL(s, location.href); return u.host + u.pathname; } catch { return String(s).slice(0, 100); } }),
    bvidParam: new URL(location.href).searchParams.get('bvid'),
  }, null, 2);
})()
