(async () => {
  const entry = performance.getEntriesByType('resource').find((e) => /\/x\/player\/wbi\/playurl\?/.test(e.name));
  if (!entry) return JSON.stringify({ error: 'no playurl entry' });
  const res = await fetch(entry.name, { credentials: 'include' });
  const b = await res.json();
  const d = b?.data ?? {};
  const ids = (arr) => Array.isArray(arr) ? [...new Set(arr.map((s) => s.id))].sort((a, b) => b - a) : [];
  return JSON.stringify({
    href: location.href,
    qnRequested: new URL(entry.name).searchParams.get('qn'),
    responseQuality: d.quality,
    acceptQuality: d.accept_quality,
    dashVideoIds: ids(d.dash?.video),
    dash120Count: Array.isArray(d.dash?.video) ? d.dash.video.filter((s) => s.id === 120).length : 0,
    hasDurl: !!d.durl,
    code: b.code,
  }, null, 2);
})()
