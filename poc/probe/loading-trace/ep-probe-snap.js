/**
 * 换集探针 · 单次快照（页面上下文，只读）。
 *
 * 只问一次 `loading-snapshot` 桥，返回原始关键字段：
 * hosts 长度 / 各 stage 条数与 t 列表 / actual / video。
 *
 * ⚠️ 必须在 async IIFE 内部 await 完再 stringify —— 直接 stringify Promise 得到 `{}`。
 */
(async () => {
  const snap = await new Promise((resolve) => {
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
  if (snap === null) return JSON.stringify({ ok: false, reason: 'timeout' });

  const byStage = {};
  for (const e of snap.events || []) {
    if (!byStage[e.stage]) byStage[e.stage] = [];
    byStage[e.stage].push(Math.round(e.t));
  }
  const stages = {};
  for (const [k, v] of Object.entries(byStage)) stages[k] = { n: v.length, t: v };

  return JSON.stringify({
    ok: true,
    nowMs: Math.round(performance.now()),
    present: snap.present,
    confidence: snap.confidence,
    hostsLen: Array.isArray(snap.hosts) ? snap.hosts.length : null,
    hosts: Array.isArray(snap.hosts) ? snap.hosts : null,
    actual: snap.actual,
    eventsLen: Array.isArray(snap.events) ? snap.events.length : null,
    stages,
    firstEvent: Array.isArray(snap.events) && snap.events.length > 0 ? snap.events[0] : null,
    truncated: snap.truncated,
    filter: snap.filter,
    video: snap.video,
  });
})()