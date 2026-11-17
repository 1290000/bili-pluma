(() => {
  const pl = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.player;
  if (!pl) return { err: 'no player' };
  const brief = (x) => {
    if (!x || typeof x !== 'object') return typeof x;
    let k = [];
    try { k = Object.keys(x).slice(0, 20); } catch (e) {}
    return k.join(',');
  };
  const core = pl.__core;
  let out = { coreType: typeof core, coreKeys: brief(core) };
  try {
    let p = core;
    for (let i = 0; i < 3 && p; i++) {
      out['coreProto' + i] = brief(Object.getPrototypeOf(p));
      p = Object.getPrototypeOf(p);
    }
  } catch (e) {}
  try {
    out.coreOwnNames = Object.getOwnPropertyNames(core).slice(0, 30);
  } catch (e) {}
  try {
    const c = pl.__core && pl.__core.configStore;
    out.configStore = brief(c);
    out.primary = brief(c && c.primary);
    out.primaryRequestConfig = brief(c && c.primary && c.primary.requestConfig);
  } catch (e) { out.err2 = e.message; }
  return out;
})()
