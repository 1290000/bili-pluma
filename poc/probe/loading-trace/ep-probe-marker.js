/**
 * 「换集后还有没有第二次 reset」判定探针（页面上下文，只读 + 一次无参 GET）。
 *
 * ## 它回答什么
 *
 * `resetLoadingTrace()` 有**三个**触发点，全部在换集后不久：
 *   1. Navigation API `navigate` 事件
 *   2. `pgc-playview-stream` 消息（主世界换流成功才发）
 *   3. `playurl-tracks` 消息（cid 变化）
 *
 * 如果第 2/3 条**晚于**新集首批分片，它们会把刚记下的 `seg-req` 与 `hosts`
 * 再清一次 —— 那才是"面板说不知道走哪条线路、但视频已在播"的真因。
 *
 * ## 怎么判
 *
 * 只观察"变空"是不够的：reset 在 state 已经为空时**完全不可见**。
 * 所以这里主动打一个**标记**：等快照第一次变成非空（= 首批分片已被记下）后，
 * 立刻发一条 `/playurl` 请求（无 query），让采集器补一条带唯一 `t` 的
 * `playurl-req`。此后若有人 reset，这条标记会**消失** —— 那是可观测的。
 *
 * ⚠️ 代价：这一步会往时间轴里加 `playurl-req` / `playurl-res`（以及一条
 * `ext-patch`，因为本页由扩展代理）。只在测量收尾时执行，报告里会标明。
 */
(async () => {
  const snap = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1200);
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

  const now = () => Math.round(performance.now() * 10) / 10;

  // 等"首次非空"（= 首批分片已进采集器）
  const deadline = now() + 8000;
  let tNonEmpty = null;
  let seen = null;
  while (now() < deadline) {
    const s = await snap();
    const nHosts = s && Array.isArray(s.hosts) ? s.hosts.length : 0;
    const nEvents = s && Array.isArray(s.events) ? s.events.length : 0;
    if (nHosts > 0 || nEvents > 0) {
      tNonEmpty = now();
      seen = { nHosts, nEvents, stages: (s.events || []).map((e) => e.stage) };
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  if (tNonEmpty === null) {
    return JSON.stringify({ ok: false, reason: 'never-nonempty', waitedMs: 8000, probePresent: !!window.__EP_SWITCH_PROBE__ });
  }

  // 打标记：一条 pathname 含 `/playurl` 的无参请求
  const tMarker = now();
  let fetchOutcome = '';
  try {
    const r = await fetch('https://api.bilibili.com/x/player/playurl', { credentials: 'omit', cache: 'no-store' });
    fetchOutcome = 'http=' + String(r.status);
  } catch (e) {
    fetchOutcome = 'error: ' + String(e && e.name);
  }

  // 等观察器与采集器吃掉这条请求
  await new Promise((r) => setTimeout(r, 600));

  const after = await snap();
  const afterEvents = after && Array.isArray(after.events) ? after.events : [];
  const markerSeen = afterEvents.some((e) => e.stage === 'playurl-req' && Math.abs(e.t - tMarker) < 60);

  return JSON.stringify({
    ok: true,
    tNonEmpty,
    seenAtNonEmpty: seen,
    tMarker,
    fetchOutcome,
    markerSeen,
    afterHostsLen: after && Array.isArray(after.hosts) ? after.hosts.length : null,
    afterStages: afterEvents.map((e) => [e.stage, Math.round(e.t * 10) / 10]),
  });
})()