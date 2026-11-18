(async () => {
  const ssr = window.__playinfo__ && window.__playinfo__.result;
  const cid = ssr && ssr.arc && ssr.arc.cid;
  if (!cid) return { ok: false, why: 'no cid' };
  const u = 'https://api.bilibili.com/pgc/player/web/playurl?cid=' + encodeURIComponent(String(cid)) + '&avid=0&qn=80&fnval=4048&fnver=0&fourk=1';
  const r = await fetch(u, { credentials: 'include' });
  const j = await r.json();
  const api = j && j.result;
  if (!api) return { ok: false, why: 'no result', code: j && j.code };
  const vi = Object.assign({}, ssr.video_info);
  const keys = ['dash', 'durl', 'durls', 'quality', 'timelength', 'accept_quality', 'accept_description', 'support_formats', 'video_codecid', 'format', 'is_preview'];
  for (const k of keys) if (api[k] !== undefined && api[k] !== null) vi[k] = api[k];
  vi.is_preview = false;
  const payload = { vi, exp: Date.now() + 60 * 60 * 1000 };
  const raw = JSON.stringify(payload);
  sessionStorage.setItem('pluma:pgc-vi:' + cid, raw);
  return {
    ok: true,
    bytes: raw.length,
    apiQuality: api.quality,
    apiTimelength: api.timelength,
    hasDash: !!api.dash,
    dashHeights: api.dash ? api.dash.video.slice(0, 8).map((x) => x.height) : [],
    ssrProgress: ssr.watch_progress ? ssr.watch_progress.current_progress : null,
    keyPrefix: 'pluma:pgc-vi:',
    ssrQuality: ssr.video_info.quality,
  };
})()
