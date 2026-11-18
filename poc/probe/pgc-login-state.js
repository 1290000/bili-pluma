(() => {
  const s = window.__INITIAL_STATE__ || {};
  const u = s.userInfo || {};
  const pgc = window.__PLUMA_PGC__;
  return {
    hasDedeUserID: (document.cookie || '').includes('DedeUserID='),
    userInfoKeys: Object.keys(u).slice(0, 30),
    isLogin: u.isLogin,
    vipStatus: u.vipStatus,
    vipType: u.vipType,
    stateKeys: Object.keys(s).slice(0, 40),
    mainWorld: !!window.__PLUMA_MAIN__,
    pgcKeys: pgc ? Object.keys(pgc) : null,
    pgcTrace: pgc ? { lastStage: pgc.lastStage, patchedAt: pgc.patchedAt, ssrAt: pgc.ssrAt, ssrFirstSeen: pgc.ssrFirstSeen, cfgCount: pgc.cfgCount, createPlayerCalls: pgc.createPlayerCalls } : null,
    readyState: document.readyState,
  };
})()
