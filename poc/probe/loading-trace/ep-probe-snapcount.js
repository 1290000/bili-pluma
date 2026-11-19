/**
 * 「面板会不会在换集后重新取快照」计数探针（页面上下文，只读，**自己不发任何请求**）。
 *
 * ## 为什么需要它
 *
 * 面板的加载卡只在**挂载 / ⟳** 时取数（`panel.ts` 的 `refreshLoading()`），
 * 没有导航监听、没有定时器。所以「换集后卡在『还不知道走哪条线路』」的成因，
 * 就是"那张卡拿到的是换集那一刻的空快照，之后再也不刷新"。
 *
 * 判定方法：页面侧监听 `__PLUMA__ / loading-snapshot`（**只收不发**），
 * 记录每一次请求的时刻。若模拟导航（`history.pushState`）之后**没有**新请求，
 * 就证明面板不会跟随 SPA 导航刷新。
 *
 * ⚠️ 注意：`loading-snapshot` 是"页面 → content"方向的请求，
 * 只有面板（`panel-data.ts` 的 `fetchLoadingSnapshotViaPage()`）会发它，
 * 所以计数不等于 0 即说明面板确实在取数。
 */
(async () => {
  if (window.__EP_SNAPCOUNT__) return JSON.stringify({ ok: true, already: true });

  const R1 = (x) => Math.round(x * 10) / 10;
  const C = { installedAtMs: performance.now(), reqs: [], pushStates: [], clicks: [] };
  window.__EP_SNAPCOUNT__ = C;

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__ns !== '__PLUMA__' || d.type !== 'loading-snapshot') return;
    C.reqs.push({ t: R1(performance.now()) });
  });

  document.addEventListener(
    'click',
    (ev) => {
      try {
        const a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
        C.clicks.push({
          t: R1(performance.now()),
          href: a ? String(a.getAttribute('href') || '').slice(0, 50) : '',
          text: String((a ? a.textContent : ev.target && ev.target.tagName) || '').trim().replace(/\s+/g, ' ').slice(0, 16),
        });
      } catch {
        /* 忽略 */
      }
    },
    true,
  );

  const skel = (raw) => {
    try {
      const u = new URL(String(raw), location.href);
      return u.hostname + u.pathname;
    } catch {
      return '';
    }
  };
  for (const name of ['pushState', 'replaceState']) {
    const orig = history[name];
    history[name] = function (...args) {
      try {
        C.pushStates.push({ n: name, t: R1(performance.now()), to: skel(args[2] ?? location.href) });
      } catch {
        /* 忽略 */
      }
      return orig.apply(this, args);
    };
  }

  return JSON.stringify({ ok: true, installedAtMs: R1(C.installedAtMs), url: skel(location.href) });
})()