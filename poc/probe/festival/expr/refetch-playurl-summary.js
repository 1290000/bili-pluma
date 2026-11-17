(async () => {
  const entry = performance.getEntriesByType('resource').find((e) => /\/x\/player\/wbi\/playurl\?/.test(e.name));
  if (!entry) return JSON.stringify({ error: 'no playurl performance entry' });
  const u = new URL(entry.name);
  const querySummary = Object.fromEntries(
    ['qn', 'fnval', 'fnver', 'fourk', 'bvid', 'cid', 'avid', 'gaia_source', 'is_main_page'].map((k) => [k, u.searchParams.get(k)]),
  );
  let res;
  try {
    res = await fetch(u.toString(), { credentials: 'include', referrerPolicy: 'no-referrer-when-downgrade' });
  } catch (e) {
    return JSON.stringify({ error: 'fetch failed: ' + String(e), querySummary });
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return JSON.stringify({ error: 'json failed: ' + String(e), status: res.status, querySummary });
  }
  const d = body?.data ?? {};
  const streams = (arr) => (Array.isArray(arr) ? arr : []).map((s) => ({
    id: s.id,
    quality: s.quality,
    bandwidth: s.bandwidth,
    codecs: s.codecs,
    mimeType: s.mimeType,
    hasBaseUrl: typeof (s.baseUrl ?? s.base_url) === 'string',
    hasBackup: Array.isArray(s.backupUrl ?? s.backup_url),
    width: s.width,
    height: s.height,
  }));
  return JSON.stringify({
    status: res.status,
    code: body?.code,
    message: body?.message,
    querySummary,
    dataKeys: Object.keys(d),
    format: d.format,
    timelength: d.timelength,
    quality: d.quality,
    accept_quality: d.accept_quality,
    accept_description: d.accept_description,
    type: d.type,
    hasDash: !!d.dash,
    dashKeys: d.dash ? Object.keys(d.dash) : [],
    dashVideo: streams(d.dash?.video),
    dashAudio: streams(d.dash?.audio),
    hasDurl: !!d.durl,
    durlCount: Array.isArray(d.durl) ? d.durl.length : 0,
    durlQualities: Array.isArray(d.durl) ? d.durl.map((x) => x.quality) : [],
    supportFormats: Array.isArray(d.support_formats) ? d.support_formats.map((f) => ({ quality: f.quality, format: f.format, description: f.description })) : [],
  }, null, 2);
})()
