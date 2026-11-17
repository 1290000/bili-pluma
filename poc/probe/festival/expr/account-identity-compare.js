(async () => {
  const mainMid = String((window.__INITIAL_STATE__?.userInfo || {}).mid ?? '');
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
  const acct = r?.probes?.['account/summary'] ?? r?.['account/summary'] ?? null;
  const proxy = r?.probes?.['proxy/status'] ?? r?.['proxy/status'] ?? null;
  const extMid = String(acct?.mid ?? acct?.profile?.mid ?? acct?.account?.mid ?? '');
  return JSON.stringify({
    keys: Object.keys(r || {}),
    probeTypes: r?.receivedTypes ?? r?.keysSeen ?? null,
    proxy: proxy ? { identity: proxy.identity ?? null, proxyEnabled: proxy.proxyEnabled ?? null } : null,
    acctType: acct ? typeof acct : 'null',
    acctKeys: acct && typeof acct === 'object' ? Object.keys(acct).slice(0, 40) : [],
    acctHealth: acct && acct.health ? acct.health : null,
    hasMainMid: mainMid.length > 0,
    hasExtMid: extMid.length > 0,
    midEqual: mainMid.length > 0 && extMid.length > 0 ? mainMid === extMid : null,
    mainMidLen: mainMid.length,
    extMidLen: extMid.length,
  }, null, 2);
})()
