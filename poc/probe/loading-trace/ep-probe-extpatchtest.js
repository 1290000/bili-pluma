/**
 * 「扩展介入（ext-patch）会不会再出现」判定探针（页面上下文，只读 + 一次无参 GET）。
 *
 * ## 为什么需要它
 *
 * `state.streamingProxied` 是模块级私有变量，页面侧读不到；它唯一的**可观测后果**
 * 是在 `recordPlayurl()` 命中时补一条 `stage='ext-patch'`（`note='接管取流'`）。
 *
 * 所以：**主动制造一次 `/playurl` 请求，看采集器会不会为它补 `ext-patch`** ——
 *   补了 ⇒ `streamingProxied === true`
 *   没补 ⇒ `streamingProxied === false`
 *
 * 这是唯一能在页面上下文判定该字段的手段（`getLoadingSnapshot()` 里没有任何
 * 直接暴露它，`LoadingSnapshotLite` 也没这个字段）。
 *
 * ## 这一步会往采集器里加一条 playurl-req/res + 可能一条 ext-patch
 *
 * 只在测量**收尾**时执行，且不带任何 query（`upsig` / `deadline` 无从产生）。
 * 无参请求由 B站 返回业务错误 JSON，不影响播放。
 */
(async () => {
  const snap = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1500);
      const h = (ev) => {
        const d = ev.data;
        if (!d || d.__ns !== '__PLUMA__' || d.type !== 'loading-snapshot-reply') return;
        clearTimeout(timer);
        window.removeEventListener('message', h);
        resolve(d.snapshot);
      };
      window.addEventListener('message', h);
      window.postMessage({ __ns: '__PLUMA__', type: 'loading-snapshot' }, '*');
    });

  const summarize = (s) =>
    s === null
      ? null
      : {
          nowMs: Math.round(performance.now() * 10) / 10,
          nEvents: Array.isArray(s.events) ? s.events.length : null,
          stages: (s.events || []).reduce((acc, e) => {
            acc[e.stage] = (acc[e.stage] || 0) + 1;
            return acc;
          }, {}),
          extPatch: (s.events || [])
            .filter((e) => e.stage === 'ext-patch')
            .map((e) => ({ t: Math.round(e.t * 10) / 10, note: e.note || '' })),
          playurl: (s.events || [])
            .filter((e) => e.stage === 'playurl-req' || e.stage === 'playurl-res')
            .map((e) => ({ stage: e.stage, t: Math.round(e.t * 10) / 10 })),
          hostsLen: Array.isArray(s.hosts) ? s.hosts.length : null,
        };

  const before = summarize(await snap());

  // 无参 GET：只为让 PerformanceObserver 看到一条 pathname 含 `/playurl` 的条目
  const tRequest = Math.round(performance.now() * 10) / 10;
  let fetchOutcome = '';
  try {
    const r = await fetch('https://api.bilibili.com/x/player/playurl', {
      credentials: 'omit',
      cache: 'no-store',
    });
    fetchOutcome = `http=${r.status}`;
  } catch (e) {
    fetchOutcome = 'error: ' + String(e && e.name);
  }
  const tDone = Math.round(performance.now() * 10) / 10;

  // 等观察器 + 采集器把这条条目吃进去
  await new Promise((r) => setTimeout(r, 700));

  const after = summarize(await snap());

  return JSON.stringify({
    ok: true,
    tRequest,
    tDone,
    fetchOutcome,
    before,
    after,
    extPatchDelta: (after === null ? 0 : after.extPatch.length) - (before === null ? 0 : before.extPatch.length),
    playurlDelta: (after === null ? 0 : after.playurl.length) - (before === null ? 0 : before.playurl.length),
  });
})()