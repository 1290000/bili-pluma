(async () => {
  const ssr = window.__playinfo__ && window.__playinfo__.result;
  const cid = ssr && ssr.arc && ssr.arc.cid;
  if (!cid) return { ok: false, why: 'no cid' };
  const u = 'https://api.bilibili.com/pgc/player/web/playurl?cid=' + encodeURIComponent(String(cid)) + '&avid=0&qn=80&fnval=4048&fnver=0&fourk=1';
  const r = await fetch(u, { credentials: 'include' });
  const j = await r.json();
  const d = j && j.result;
  return {
    ok: true,
    http: r.status,
    code: j && j.code,
    resultKeys: d ? Object.keys(d).slice(0, 40) : [],
    lastPlayTime: d ? (d.last_play_time ?? null) : null,
    lastPlayCidPresent: !!(d && d.last_play_cid),
    timelength: d ? (d.timelength ?? null) : null,
    quality: d ? (d.quality ?? null) : null,
    hasDash: !!(d && d.dash),
    dashHeights: d && d.dash ? d.dash.video.slice(0, 6).map((x) => x.height) : [],
    durlGroups: d && d.durls ? d.durls.length : (d && d.durl ? 1 : 0),
    isPreview: d ? d.is_preview : null,
    ssrProgress: ssr && ssr.watch_progress ? (ssr.watch_progress.current_progress ?? null) : null,
    ssrQuality: ssr && ssr.video_info ? ssr.video_info.quality : null,
    ssrTimelength: ssr && ssr.video_info ? ssr.video_info.timelength : null,
  };
})()
