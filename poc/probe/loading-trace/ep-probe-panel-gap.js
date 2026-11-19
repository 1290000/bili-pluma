/**
 * 面板在「换集后空窗期」里长什么样（页面上下文，只读 + 一次按钮点击）。
 *
 * ## 为什么要它
 *
 * 采集器 reset 之后、新集首批分片回来之前，快照是「`present:false` / `hosts:[]`」。
 * 而面板的加载卡**只在挂载/⟳ 时取数**，不跟随导航自动刷新。
 * 所以如果用户在那一刻打开面板，那张卡会一直停在「还不知道走哪条线路」。
 *
 * ## 它做什么
 *
 * 1. 装一个 20ms 采样器，记录 `hosts` 条数随时间的变化（找空窗）
 * 2. 通过 `history` 包装检测到换到另一条 pathname 后，在 +`DELAY` ms 处
 *    点一次页面上的「打开 Pluma 面板」按钮
 * 3. 记下点击时刻 + 随后若干次快照的 `hosts` 条数
 *
 * 按钮在**页面 DOM** 里（面板本体才是 closed shadow），所以按文字找元素即可。
 *
 * ⚠️ 不改产品代码；只点它自己的按钮。
 */
(async () => {
  const R1 = (x) => Math.round(x * 10) / 10;
  const DELAY = Number(window.__EP_PANEL_DELAY__ ?? 700);

  const skel = (raw) => {
    try {
      const u = new URL(String(raw), location.href);
      return u.hostname + u.pathname;
    } catch {
      return '';
    }
  };

  const S = { installedAtMs: performance.now(), url0: skel(location.href), enabled: true, samples: [], clicks: [], pushStates: [] };
  window.__EP_PANEL_PROBE__ = S;

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

  const record = async (tag) => {
    const s = await snap();
    S.samples.push({
      tag,
      t: R1(performance.now()),
      hostsLen: s && Array.isArray(s.hosts) ? s.hosts.length : null,
      nEvents: s && Array.isArray(s.events) ? s.events.length : null,
      present: s ? s.present : null,
      actual: s ? (s.actual || null) : null,
    });
  };

  // 拉一个「打开 Pluma 面板」按钮（页面 DOM 里）
  const findLauncher = () => {
    const all = document.querySelectorAll('button, [role="button"], div, span');
    for (const el of all) {
      const txt = String(el.textContent || '').trim();
      if (txt === '打开 Pluma 面板') return el;
    }
    return null;
  };

  S.timer = setInterval(() => {
    void record('poll');
  }, 20);

  for (const name of ['pushState', 'replaceState']) {
    const orig = history[name];
    history[name] = function (...args) {
      try {
        const to = skel(args[2] ?? location.href);
        S.pushStates.push({ n: name, t: R1(performance.now()), to });
        if (to !== S.url0 && S.enabled) {
          S.enabled = false;
          setTimeout(() => {
            const btn = findLauncher();
            S.clicks.push({ t: R1(performance.now()), found: btn !== null, delay: DELAY });
            if (btn !== null) {
              try {
                btn.click();
              } catch (e) {
                S.clicks[S.clicks.length - 1].err = String(e);
              }
            }
            void record('after-click');
            setTimeout(() => void record('after-click+300'), 300);
            setTimeout(() => void record('after-click+900'), 900);
          }, DELAY);
        }
      } catch {
        /* 忽略 */
      }
      return orig.apply(this, args);
    };
  }

  return JSON.stringify({ ok: true, installedAtMs: R1(S.installedAtMs), url: S.url0, delayMs: DELAY });
})()