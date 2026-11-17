(async () => {
  const entries = performance.getEntriesByType('resource').filter((e) => /\/x\/player\/wbi\/playurl\?/.test(e.name));
  if (!entries.length) return JSON.stringify({ error: 'no playurl entry' });
  const url = entries[entries.length - 1].name;
  const u = new URL(url);
  const qn = u.searchParams.get('qn');
  const summarize = (b) => {
    const d = (b && b.data) || {};
    const vids = Array.isArray(d.dash?.video) ? d.dash.video : [];
    const ids = [...new Set(vids.map((v) => v.id))].sort((a, b) => b - a);
    const heights = [...new Set(vids.map((v) => v.height))].sort((a, b) => b - a);
    return {
      code: b?.code, message: b?.message,
      quality: d.quality, accept_quality: d.accept_quality,
      accept_description: d.accept_description,
      format: d.format, type: d.type,
      hasDash: !!d.dash, videoCount: vids.length,
      dashIds: ids, dashHeights: heights,
      dash120: vids.filter((v) => v.id === 120).length,
      hasDurl: Array.isArray(d.durl) && d.durl.length > 0,
      hasDolbyVision: !!(d.dash && d.dash.dolby && d.dash.dolby.vision),
      hasFlac: !!(d.dash && d.dash.flac),
      dolbyAudio: Array.isArray(d.dash?.dolby?.audio) ? d.dash.dolby.audio.length : 0,
    };
  };
  const get = async (init) => {
    try {
      const r = await fetch(url, Object.assign({ credentials: 'include' }, init));
      const t = await r.text();
      let b;
      try { b = JSON.parse(t); } catch { b = { parseError: t.slice(0, 120) }; }
      return { status: r.status, body: summarize(b) };
    } catch (e) { return { error: String(e) }; }
  };
  const out = { href: location.href, qnRequested: qn, playurlEntryCount: entries.length };
  out.get = await get({ method: 'GET' });
  out.post = await get({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  out.getAgain = await get({ method: 'GET' });
  return JSON.stringify(out, null, 2);
})()
