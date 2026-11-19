/**
 * 「换集后到底有几次 reset、各在什么时刻」判定探针（页面上下文，只读 + 若干次无参 GET）。
 *
 * ## 问题
 *
 * `resetLoadingTrace()` 在换集后可能有**两到三次**：Navigation API `navigate`、
 * `pgc-playview-stream`、`playurl-tracks` 各一次。但**在 state 已经为空时 reset 完全不可观测**
 * —— 只看快照的"非空→空"只会得到最先那一次。
 *
 * ## 办法：自标记 + 存活判定
 *
 * 一旦检测到 `pushState` 换到另一条 pathname，就在 +60/+160/+260/+360/+460/+620/+800ms
 * **页面侧**定时发出一组 `/x/player/playurl` 无参 GET（不用 bsk 往返，因此刻度是准的）。
 * 每次取流都会被采集器记成一条 `playurl-req`（`t` = 该请求的 `startTime`）。
 *
 * 任何一次 `resetLoadingTrace()` 都会把它们**全部抹掉**。所以：
 *   存活的最早标记时刻 ⇒ 那一刻之后**没有**再 reset
 *   缺失的标记 ⇒ 在它之后存在一次 reset
 *
 * 再叠加 20ms 快照采样（`hosts` 条数 / 事件数）就能同时拿到"空窗"的起止。
 *
 * ## 副作用（必须在报告里写明）
 *
 * 最多 7 条无参 GET，各自往时间轴里加 `playurl-req`/`playurl-res`，
 * 外加一条 `ext-patch`（本页由扩展代理时会补）。不影响播放，不改产品代码。
 */
(async () => {
  const R1 = (x) => Math.round(x * 10) / 10;
  const skel = (raw) => {
    try {
      const u = new URL(String(raw), location.href);
      return u.hostname + u.pathname;
    } catch {
      return '';
    }
  };

  const S = { version: 1, installedAtMs: performance.now(), timeOrigin: performance.timeOrigin, url0: skel(location.href) };
  window.__EP_RESET_COUNT__ = S;
  S.clicks = [];
  S.pushStates = [];
  S.markers = [];
  S.runs = [];
  S.errors = [];

  // 点击
  document.addEventListener(
    'click',
    (ev) => {
      try {
        const a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
        S.clicks.push({ t: R1(performance.now()), href: a ? String(a.getAttribute('href') || '').slice(0, 50) : '', text: String((a ? a.textContent : '') || '').trim().replace(/\s+/g, ' ').slice(0, 16) });
      } catch {
        /* 忽略 */
      }
    },
    true,
  );

  // 快照采样（20ms）
  const snap = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 900);
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

  const stageList = (s) =>
    (s && Array.isArray(s.events) ? s.events : []).map((e) => [e.stage, R1(e.t), e.note || '']);

  let pending = null;
  let armed = false;
  S.flush = () => {
    if (pending !== null) {
      S.runs.push(pending);
      pending = null;
    }
  };
  S.pollOnce = async () => {
    const s = await snap();
    const nHosts = s && Array.isArray(s.hosts) ? s.hosts.length : null;
    const evs = stageList(s);
    const t = R1(performance.now());
    const key = JSON.stringify({ nHosts, n: evs.length });
    const rec = {
      tFrom: t,
      tTo: t,
      n: 1,
      nHosts,
      nEvents: evs.length,
      stages: Array.from(new Set(evs.map((e) => e[0]))),
      hosts: s && Array.isArray(s.hosts) ? s.hosts.map((h) => [h.host, h.cls, h.count]) : null,
      actual: s ? s.actual : null,
    };
    if (pending === null || pending.key !== key) {
      S.flush();
      pending = Object.assign({ key }, rec);
    } else {
      pending.tTo = t;
      pending.n += 1;
      pending.hosts = rec.hosts;
    }
  };

  // 标记请求
  const fireMarker = async (label, tScheduled) => {
    const tStart = R1(performance.now());
    const rec = { label, tScheduled, tStart };
    S.markers.push(rec);
    try {
      const r = await fetch('https://api.bilibili.com/x/player/playurl', { credentials: 'omit', cache: 'no-store' });
      rec.http = r.status;
    } catch (e) {
      rec.http = 'err:' + String(e && e.name);
    }
    rec.tDone = R1(performance.now());
  };

  const arm = () => {
    if (armed) return;
    armed = true;
    const offsets = [60, 160, 260, 360, 460, 620, 800];
    for (const off of offsets) {
      setTimeout(() => {
        void fireMarker('+' + String(off), R1(performance.now()));
      }, off);
    }
  };

  // history 包装（检测到"换到另一条 pathname"就武装）
  for (const name of ['pushState', 'replaceState']) {
    const orig = history[name];
    history[name] = function (...args) {
      try {
        const to = skel(args[2] ?? location.href);
        S.pushStates.push({ n: name, t: R1(performance.now()), to });
        if (to !== S.url0) arm();
      } catch {
        /* 忽略 */
      }
      return orig.apply(this, args);
    };
  }

  // 采样定时器（20ms；用 setTimeout 链避免与 await 抢拍）
  S.timer = setInterval(() => {
    void S.pollOnce().catch((e) => S.errors.push(String(e)));
  }, 20);

  return JSON.stringify({ ok: true, installedAtMs: R1(S.installedAtMs), url: S.url0, markerOffsets: [60, 160, 260, 360, 460, 620, 800] });
})()