(async () => {
  const r = await new Promise((res) => {
    const t = setTimeout(() => res({ jsTimeout: true }), 8000);
    const h = (e) => {
      if (e.data?.__ns === '__PLUMA__' && e.data.type === 'streaming-probe-reply') {
        clearTimeout(t); window.removeEventListener('message', h); res(e.data.trace);
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'streaming-probe', probeTypes: ['account/summary', 'proxy/status'] }, '*');
  });
  const mask = (k, v) => /mid|uname|face|avatar|nick|email|tel/i.test(k) ? '[redacted]' : v;
  const clean = (o, depth) => {
    if (depth > 5 || !o || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map((x) => clean(x, depth + 1));
    const out = {};
    for (const k of Object.keys(o)) out[k] = mask(k, clean(o[k], depth + 1));
    return out;
  };
  return JSON.stringify(clean(r, 0), null, 2).slice(0, 6000);
})()
