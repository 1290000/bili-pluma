/**
 * 「换集后到底有几次 reset、各在什么时刻」—— 细粒度版（页面上下文）。
 *
 * ## 原理
 *
 * `resetLoadingTrace()` 把 `state` 换成一个全新的空对象，所以**已记录的
 * `playurl-req` 会一起消失**。而 `recordPlayurl()` 对每一次取流都记一对
 * `playurl-req` / `playurl-res`（`t` = 该请求的 `startTime`）。
 *
 * 因此：从 `pushState` 之后每 30ms 发一条无参 `/x/player/playurl` GET，
 * 每条都会留下一个**带唯一 `t` 的标记**。测完读快照：
 *
 *   还活着的标记里最早的那个 `t` ⇒ 该时刻之后**没有**发生 reset
 *   缺失的标记 ⇒ 它之后发生过**一次** reset（每丢一批 = 一次 reset）
 *
 * 这样能把"重置了几次、分别在什么时刻"直接数出来，而不是靠猜。
 *
 * ## 副作用（必须写进报告）
 *
 * 最多约 40 条无参 GET（只带 pathname，无 query），各自往时间轴里加
 * `playurl-req`/`playurl-res`（外加首条会补一条 `ext-patch`）。
 * 不改产品代码、不改播放状态。
 *
 * ## 与采样器共用
 *
 * 同时跑 20ms 的 `hosts`/事件数采样，用来对照"空窗"起止。
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

  const S = {
    installedAtMs: performance.now(),
    url0: skel(location.href),
    markers: [],
    pushStates: [],
    clicks: [],
    samples: [],
    armed: false,
  };
  window.__EP_RESET_FINE__ = S;

  const snap = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 700);
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

  // 点击记录
  document.addEventListener(
    'click',
    (ev) => {
      try {
        const a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
        S.clicks.push({
          t: R1(performance.now()),
          href: a ? String(a.getAttribute('href') || '').slice(0, 50) : '',
          text: String((a ? a.textContent : '') || '').trim().replace(/\s+/g, ' ').slice(0, 14),
        });
      } catch {
        /* 忽略 */
      }
    },
    true,
  );

  // 20ms 采样
  S.timer = setInterval(() => {
    void (async () => {
      const s = await snap();
      const evs = s && Array.isArray(s.events) ? s.events : [];
      S.samples.push({
        t: R1(performance.now()),
        hostsLen: s && Array.isArray(s.hosts) ? s.hosts.length : null,
        nEvents: evs.length,
        nPlayurlReq: evs.filter((e) => e.stage === 'playurl-req').length,
      });
      if (S.samples.length > 4000) S.samples.splice(0, 2000);
    })();
  }, 20);

  // 标记：pushState 到另一条 pathname 之后，每 30ms 一条，共 40 条
  const arm = () => {
    if (S.armed) return;
    S.armed = true;
    for (let i = 0; i < 40; i += 1) {
      setTimeout(() => {
        const tSched = R1(performance.now());
        const rec = { i, tSched };
        S.markers.push(rec);
        void fetch('https://api.bilibili.com/x/player/playurl', { credentials: 'omit', cache: 'no-store' })
          .then((r) => {
            rec.http = r.status;
            rec.tDone = R1(performance.now());
          })
          .catch((e) => {
            rec.http = 'err';
            rec.tDone = R1(performance.now());
            rec.err = String(e && e.name);
          });
      }, 30 + i * 30);
    }
  };

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

  return JSON.stringify({ ok: true, installedAtMs: R1(S.installedAtMs), url: S.url0, markerPitchMs: 30, markerCount: 40 });
})()