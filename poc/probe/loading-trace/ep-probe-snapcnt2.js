/**
 * 「面板会不会在换集后重新取快照」计数探针 v2（页面上下文，**只收不发**）。
 *
 * ## 与 v1（ep-probe-snapcount.js）的区别
 *
 * v1 的计数被**上一轮遗留的采样器**污染（2 秒读到 281 次 ≈ 140/s，
 * 而面板一次刷新只发 1 条）。v2 做三件事避免污染：
 *
 * 1. 单例化（重复 install 直接复用，不叠加监听）
 * 2. 暴露 `window.__EP_SNAPCNT__.reset()`，可以**清零后重数**
 * 3. 记录**每次请求的来源标记**（`mark`），配合 `markNow(label)` 做分段统计
 *
 * ## 为什么这个计数是可信的
 *
 * `__PLUMA__ / loading-snapshot` 这个方向（页面 → content）**只有一个生产者**：
 * `panel-data.ts` 的 `fetchLoadingSnapshotViaPage()`。它只在面板的加载卡
 * **挂载**或**用户点 ⟳** 时被调一次。所以：
 *
 * - 计数增长 ⇒ 面板确实取了数
 * - 计数不增长 ⇒ 面板没有任何人触发取数（既没重挂载，也没点 ⟳）
 *
 * 探针自身**只挂监听、不发请求**，不改变被观测行为。
 */
(() => {
  const R1 = (x) => Math.round(x * 10) / 10;

  if (window.__EP_SNAPCNT__) {
    const c = window.__EP_SNAPCNT__;
    return JSON.stringify({ ok: true, already: true, installedAtMs: R1(c.installedAtMs), n: c.reqs.length });
  }

  const C = {
    installedAtMs: performance.now(),
    reqs: [],
    marks: [{ t: R1(performance.now()), label: 'install' }],
    pushStates: [],
    clicks: [],
  };

  const markNow = (label) => {
    C.marks.push({ t: R1(performance.now()), label: String(label).slice(0, 40) });
  };

  C.markNow = markNow;
  C.reset = () => {
    C.reqs.length = 0;
    C.marks.length = 0;
    C.clicks.length = 0;
    C.pushStates.length = 0;
    markNow('reset');
  };

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

  window.__EP_SNAPCNT__ = C;

  return JSON.stringify({ ok: true, installedAtMs: R1(C.installedAtMs), n: C.reqs.length, url: skel(location.href) });
})()