/**
 * 换集探针 v5 · 读取端（页面上下文，只读）。
 *
 * 返回探针累计到的全部数据。`media` 与 `runs` 可能很大，用 `?slice=` 由调用侧裁剪。
 * 只含 hostname + pathname（query 一律已丢）。
 */
(async () => {
  const P = window.__EP_SWITCH_PROBE__;
  if (!P) return JSON.stringify({ ok: false, reason: 'probe-not-installed' });

  const skel = (raw) => {
    try {
      const u = new URL(String(raw), location.href);
      return u.hostname + u.pathname;
    } catch {
      return '';
    }
  };

  try {
    P.poll();
  } catch {
    /* 忽略 */
  }
  const nowMs = Math.round(performance.now() * 10) / 10;

  return JSON.stringify({
    ok: true,
    version: P.version,
    nowMs,
    timeOrigin: Math.round(P.timeOrigin),
    installedAtMs: Math.round(P.installedAtMs),
    ageSec: Math.round((nowMs - P.installedAtMs) / 100) / 10,
    currentUrl: skel(location.href),
    loads: P.loads,
    clicks: P.clicks,
    pushStates: P.pushStates,
    navigations: P.navigations,
    posted: P.posted,
    received: P.received,
    errors: P.errors,
    videos: P.videos,
    mediaCount: P.media.length,
    media: P.media,
    flowCount: P.flow.length,
    flow: P.flow,
    edges: P.edges,
    runCount: P.runs.length,
    runs: P.runs,
  });
})()