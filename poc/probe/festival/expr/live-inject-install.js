(() => {
  const S = window.__INITIAL_STATE__ || {};
  const pl = S.player;
  if (!pl || typeof pl.updateRequestConfig !== 'function') return { ok: false, why: 'no player API' };
  const L = { hits: 0, events: [], errors: [], fetchInfo: null };
  window.__LIVE__ = L;
  const log = (m) => L.events.push({ t: Math.round(performance.now()), m });
  pl.updateRequestConfig({
    reqHttpPlayUrlInfo: async function (params) {
      L.hits += 1;
      log('cb #' + L.hits + ' cid=' + (params && params.cid) + ' qn=' + (params && params.qn));
      try {
        const u = new URL('https://api.bilibili.com/x/player/wbi/playurl');
        for (const [k, v] of Object.entries(params || {})) {
          if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        }
        const r = await fetch(u.toString(), { credentials: 'include' });
        const j = await r.json();
        const d = j && j.data;
        L.fetchInfo = {
          http: r.status,
          code: j && j.code,
          heights: d && d.dash && d.dash.video ? d.dash.video.map((x) => x.height) : [],
          quality: d && d.quality,
        };
        log('fetched code=' + (j && j.code) + ' quality=' + (d && d.quality));
        if (d && d.dash && Array.isArray(d.dash.video)) {
          const before = d.dash.video.length;
          // 标记：只留 <=1080 的轨，强制播放器从 2160 掉到 1080，证明流来自本回调
          d.dash.video = d.dash.video.filter((x) => (x.height || 0) <= 1080);
          d.quality = 112;
          d.accept_quality = (d.accept_quality || []).filter((x) => x <= 112);
          log('filtered dash.video ' + before + ' -> ' + d.dash.video.length);
        }
        return { data: j, headers: {}, status: r.status };
      } catch (e) {
        L.errors.push(e.message);
        log('fetch error: ' + e.message);
        throw e;
      }
    },
  });
  const v = document.querySelector('video');
  L.before = { h: v && v.videoHeight, dur: Math.round((v && v.duration) || 0) };
  L.trigger = 'not-called';
  return {
    ok: true,
    before: L.before,
    quality: (() => { try { const q = pl.getQuality(); return q && q.newQ; } catch (e) { return null; } })(),
    hasReload: typeof pl.reload,
    hasRequestQuality: typeof pl.requestQuality,
  };
})()
