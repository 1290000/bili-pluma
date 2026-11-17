(async () => {
  const r = await new Promise((res) => {
    const t = setTimeout(() => res({ jsTimeout: true }), 8000);
    const h = (e) => {
      if (e.data?.__ns === '__PLUMA__' && e.data.type === 'streaming-probe-reply') {
        clearTimeout(t); window.removeEventListener('message', h); res(e.data.trace);
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'streaming-probe', probeTypes: ['proxy/status'] }, '*');
  });
  const p = r?.probes?.['proxy/status'] ?? r?.['proxy/status'] ?? r;
  return JSON.stringify({ rawKeys: Object.keys(r || {}), proxyStatus: p, buildProof: r?.buildProof }, null, 2).slice(0, 4000);
})()
