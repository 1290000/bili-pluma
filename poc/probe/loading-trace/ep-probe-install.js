/**
 * 换集探针 v5 · 安装端（页面上下文，只读；不改产品代码）。
 *
 * 相比 v4 多记一条**最关键的证据**：页面与 content script 之间所有
 * `__PLUMA__` postMessage 的 `type` + 时刻。
 *
 * 为什么必须有它：`resetLoadingTrace()` 的真实调用点只有三个（PGC 换集消息、
 * UGC playurl-tracks 消息、navigate 事件），而它们**都**由某条消息或事件触发。
 * 只记快照"变空"的时刻只能得到"最晚一次 reset"，分不清是 navigate 还是
 * `pgc-playview-stream` 干的。把消息流打出来就能直接对上。
 *
 * ## 记什么
 *
 * 1. `click`（捕获阶段）
 * 2. `history.pushState/replaceState` 调用
 * 3. Navigation API `navigate` 事件（含 `navigationType`）
 * 4. **所有 `__PLUMA__` postMessage**（收 + 发，带 type；`loading-snapshot` 自己发的除外）
 * 5. 媒体分片（`.m4s/.mp4/.flv` 或含 `/upgcxcode/`）→ startTime / responseEnd / host / pathname
 * 6. B站 域上的 `/playurl` 与 `/playview` 请求（取流接口，判据是 pathname）
 * 7. 每 20ms 要一次 `loading-snapshot`：同签名压成段；空↔非空边界完整保留
 * 8. `<video>` 的 src / duration / readyState 变化痕迹
 *
 * 落盘只留 hostname + pathname：`upsig` / `deadline` 这类 query 一律不留。
 */
(async () => {
  if (window.__EP_SWITCH_PROBE__) {
    try {
      window.__EP_SWITCH_PROBE__.stop();
    } catch {
      /* 忽略 */
    }
  }

  const round1 = (x) => Math.round(x * 10) / 10;
  const P = {
    version: 5,
    installedAtMs: performance.now(),
    timeOrigin: performance.timeOrigin,
    url0: location.hostname + location.pathname,
    clicks: [],
    pushStates: [],
    navigations: [],
    posted: [],
    received: [],
    runs: [],
    edges: [],
    media: [],
    flow: [],
    videos: [],
    errors: [],
    timer: null,
  };
  window.__EP_SWITCH_PROBE__ = P;

  const skel = (raw) => {
    try {
      const u = new URL(String(raw), location.href);
      return u.hostname + u.pathname;
    } catch {
      return '';
    }
  };
  const hostOf = (n) => {
    try {
      return new URL(n).hostname.toLowerCase();
    } catch {
      return '';
    }
  };
  const pathOf = (n) => {
    try {
      return new URL(n).pathname;
    } catch {
      return '';
    }
  };

  // 文档重载痕迹
  let loads = [];
  try {
    loads = JSON.parse(sessionStorage.getItem('__ep_probe_loads') || '[]');
    if (!Array.isArray(loads)) loads = [];
  } catch {
    loads = [];
  }
  loads.push({ atMs: Date.now(), timeOrigin: Math.round(performance.timeOrigin), url: P.url0 });
  if (loads.length > 12) loads = loads.slice(-12);
  try {
    sessionStorage.setItem('__ep_probe_loads', JSON.stringify(loads));
  } catch {
    /* 忽略 */
  }
  P.loads = loads;

  // 1) 点击
  const onDocClick = (ev) => {
    try {
      const tgt = ev.target;
      const a = tgt && tgt.closest ? tgt.closest('a') : null;
      P.clicks.push({
        t: round1(performance.now()),
        href: a ? String(a.getAttribute('href') || '').slice(0, 60) : '',
        text: String((a ? a.textContent : tgt && tgt.tagName) || '').trim().replace(/\s+/g, ' ').slice(0, 18),
      });
    } catch {
      /* 忽略 */
    }
  };
  document.addEventListener('click', onDocClick, true);

  // 2) history 包装
  for (const name of ['pushState', 'replaceState']) {
    const orig = history[name];
    history[name] = function (...args) {
      try {
        P.pushStates.push({ n: name, t: round1(performance.now()), to: skel(args[2] ?? location.href) });
      } catch {
        /* 忽略 */
      }
      return orig.apply(this, args);
    };
  }

  // 3) Navigation API
  try {
    if (typeof navigation !== 'undefined' && navigation && typeof navigation.addEventListener === 'function') {
      navigation.addEventListener('navigate', (ev) => {
        try {
          P.navigations.push({
            t: round1(performance.now()),
            to: skel(ev.destination && ev.destination.url),
            type: String(ev.navigationType || ''),
          });
        } catch {
          /* 忽略 */
        }
      });
    }
  } catch (e) {
    P.errors.push('navigation: ' + String(e));
  }

  // 4) __PLUMA__ 消息流（页面→content 方向）
  const describe = (d) => {
    const keys = Object.keys(d).filter((k) => k !== '__ns');
    const brief = {};
    for (const k of keys) {
      const v = d[k];
      const t = typeof v;
      if (t === 'string') brief[k] = v.length > 24 ? v.slice(0, 24) + '…' : v;
      else if (t === 'number' || t === 'boolean' || v === null) brief[k] = v;
      else if (Array.isArray(v)) brief[k] = 'array(' + v.length + ')';
      else if (t === 'object') brief[k] = 'object';
    }
    return brief;
  };
  const onPlumaMsg = (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.__ns !== '__PLUMA__') return;
    const type = String(d.type || '');
    // 自己发的采样询问与应答都不记 —— 否则 20ms 一次会把真正要看的消息挤出去
    if (type === 'loading-snapshot-reply' || type === 'loading-snapshot') return;
    P.received.push({ t: round1(performance.now()), type, brief: describe(d) });
    if (P.received.length > 2000) P.received.shift();
  };
  window.addEventListener('message', onPlumaMsg);

  const origPost = window.postMessage.bind(window);
  window.postMessage = function (msg, targetOrigin, ...rest) {
    try {
      if (msg && typeof msg === 'object' && msg.__ns === '__PLUMA__' && msg.type !== 'loading-snapshot') {
        P.posted.push({ t: round1(performance.now()), type: String(msg.type || ''), brief: describe(msg) });
        if (P.posted.length > 400) P.posted.shift();
      }
    } catch {
      /* 忽略 */
    }
    return origPost(msg, targetOrigin, ...rest);
  };

  // 5)(6) resource 观察器：媒体分片 + 取流接口
  const isMedia = (n) => /\.(?:m4s|mp4|flv)(?:\?|$)/i.test(n) || n.indexOf('/upgcxcode/') !== -1;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const n = String(e.name || '');
        const path = pathOf(n);
        const host = hostOf(n);
        if (isMedia(n) || path.indexOf('/upgcxcode/') !== -1) {
          P.media.push({ s: round1(e.startTime), e: round1(e.responseEnd), h: host, p: path, init: String(e.initiatorType || '') });
          if (P.media.length > 8000) P.media.splice(0, P.media.length - 8000);
        }
        if (path.indexOf('/playurl') !== -1 || path.indexOf('/playview') !== -1 || path.indexOf('/playinfo') !== -1) {
          P.flow.push({ s: round1(e.startTime), e: round1(e.responseEnd), h: host, p: path.slice(0, 70), init: String(e.initiatorType || ''), size: e.transferSize, status: e.responseStatus });
          if (P.flow.length > 300) P.flow.shift();
        }
      }
    });
    obs.observe({ type: 'resource', buffered: false });
    P.resourceObserver = obs;
  } catch (e) {
    P.errors.push('observer: ' + String(e));
  }

  // 8) video 痕迹
  const videoTrace = () => {
    const v = document.querySelector('video');
    if (v === null) return;
    const last = P.videos[P.videos.length - 1];
    const key = String(v.currentSrc || v.src || '').slice(-40) + '|' + String(Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0) + '|' + v.readyState;
    if (last !== undefined && last.key === key) return;
    P.videos.push({
      t: round1(performance.now()),
      key,
      duration: Number.isFinite(v.duration) ? round1(v.duration) : 0,
      readyState: v.readyState,
      paused: v.paused,
      currentTime: round1(v.currentTime),
    });
  };

  // 7) 快照采样
  let pending = null;
  let prevNonEmpty = null;
  const flushPending = () => {
    if (pending !== null) {
      P.runs.push(pending);
      pending = null;
    }
  };
  const onMsg = (ev) => {
    const d = ev.data;
    if (!d || d.__ns !== '__PLUMA__' || d.type !== 'loading-snapshot-reply') return;
    const s = d.snapshot;
    const counts = {};
    const fullEvents = [];
    if (s && Array.isArray(s.events)) {
      for (const e of s.events) {
        counts[e.stage] = (counts[e.stage] || 0) + 1;
        if (fullEvents.length < 100) fullEvents.push([e.stage, round1(e.t), e.host || '', e.note || '']);
      }
    }
    const hosts = s && Array.isArray(s.hosts) ? s.hosts.map((h) => [h.host, h.cls, h.count]) : null;
    const t = round1(performance.now());
    const nonEmpty = !!(s && s.present) && hosts !== null && hosts.length > 0;
    const sig = JSON.stringify({ p: !!(s && s.present), h: hosts, n: s && Array.isArray(s.events) ? s.events.length : null });
    const snap = {
      t,
      present: !!(s && s.present),
      confidence: s ? s.confidence : null,
      hostsLen: hosts === null ? null : hosts.length,
      hosts,
      actual: s ? s.actual : null,
      counts,
      events: fullEvents,
      video: s ? s.video : null,
    };

    if (prevNonEmpty !== null && prevNonEmpty !== nonEmpty) {
      flushPending();
      const kind = nonEmpty ? 'empty->nonempty' : 'nonempty->empty';
      P.edges.push(Object.assign({ kind }, snap));
      P.runs.push(Object.assign({ tFrom: t, tTo: t, n: 1, sig, edge: kind }, snap));
      prevNonEmpty = nonEmpty;
      return;
    }
    prevNonEmpty = nonEmpty;
    if (pending === null || pending.sig !== sig) {
      flushPending();
      pending = Object.assign({ tFrom: t, tTo: t, n: 1, sig }, snap);
    } else {
      pending.tTo = t;
      pending.n += 1;
    }
  };
  window.addEventListener('message', onMsg);

  P.poll = () => {
    videoTrace();
    window.postMessage({ __ns: '__PLUMA__', type: 'loading-snapshot' }, '*');
  };
  P.stop = () => {
    if (P.timer) clearInterval(P.timer);
    P.timer = null;
    flushPending();
    window.removeEventListener('message', onMsg);
    window.removeEventListener('message', onPlumaMsg);
    window.postMessage = origPost;
    document.removeEventListener('click', onDocClick, true);
    try {
      P.resourceObserver.disconnect();
    } catch {
      /* 忽略 */
    }
  };

  P.poll();
  P.timer = setInterval(P.poll, 20);

  return JSON.stringify({
    ok: true,
    version: 5,
    t0: round1(P.installedAtMs),
    timeOrigin: Math.round(P.timeOrigin),
    url: P.url0,
    resourceEntriesInBuffer: performance.getEntriesByType('resource').length,
    loads: P.loads.length,
    sampleIntervalMs: 20,
  });
})()