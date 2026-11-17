(async () => {
  const d = Object.getOwnPropertyDescriptor(window, '__playinfo__');
  const keys = d ? Object.keys(d) : [];
  const v = window.__playinfo__;
  return JSON.stringify({
    href: location.href,
    hasPlumaMain: typeof window.__PLUMA_MAIN__ !== 'undefined',
    descriptor: d ? { configurable: d.configurable, enumerable: d.enumerable, hasGet: typeof d.get === 'function', hasSet: typeof d.set === 'function', ownKeys: keys } : null,
    valueType: typeof v,
    valueKeys: v && typeof v === 'object' ? Object.keys(v).slice(0, 10) : [],
  }, null, 2);
})()
