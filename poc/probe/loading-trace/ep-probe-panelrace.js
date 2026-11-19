/**
 * 「面板在空窗期挂载会显示什么」探针（页面上下文，只读 + 一次合成点击）。
 *
 * ## 为什么要合成点击
 *
 * `resetLoadingTrace()` 之后到第一条 `seg-req` 真正**进入 state** 之间有
 * 一个 ~0.6–0.9s 的空窗（本报告问题 1 已实测）。若面板恰好在空窗里**挂载**，
 * `refreshLoading()` 取到的就是空快照 —— 之后**没有任何自动重取**，于是那句
 * 「还不知道走哪条线路」会一直留在卡上，即便视频已经在播。
 *
 * 用 `bsk click` 抢这个 600–900ms 的窗口不可行（一次 click 往返就 >1s）。
 * 所以本探针在**页面侧**等 `pushState`，然后延时 `DELAY_MS` 合成点一下
 * 「打开 Pluma 面板」——
 *
 * - 按钮就是页面 DOM 里那个 `[aria-label="打开 Pluma 面板"]`（面板本体在
 *   closed shadow 里进不去，但**入口按钮**是普通 DOM，点得动）
 * - 点的只是"显示面板"，不发任何网络请求、不改产品状态
 *
 * ## 产物
 *
 * `window.__EP_PANELRACE__` 里记 pushState 时刻、合成点击时刻、以及点击是否命中。
 * 面板内容用 `bsk` 的 VOM 读（closed shadow 只能那样读）。
 */
(() => {
  const R1 = (x) => Math.round(x * 10) / 10;
  const DELAY_MS = 180;
  // `sidebar.ts:1861` 在「有新版本」时会写成「打开 Pluma 面板（有新版本）」，
  // 所以用 aria-label 前缀匹配而不是全等。
  const BTN = '[aria-label^="打开 Pluma 面板"]';

  if (window.__EP_PANELRACE__) return JSON.stringify({ ok: true, already: true });

  const C = { installedAtMs: R1(performance.now()), pushStates: [], syntheticClicks: [], lastPushT: null };
  window.__EP_PANELRACE__ = C;

  const skel = (raw) => {
    try {
      const u = new URL(String(raw), location.href);
      return u.hostname + u.pathname;
    } catch {
      return '';
    }
  };

  const fireBtn = (tag) => {
    const el = document.querySelector(BTN);
    const rec = {
      tag,
      t: R1(performance.now()),
      sincePush: C.lastPushT === null ? null : R1(performance.now() - C.lastPushT),
      found: el !== null,
      tagName: el ? el.tagName : null,
      aria: el ? el.getAttribute('aria-label') : null,
    };
    if (el) {
      try {
        el.click();
        rec.clicked = true;
      } catch (e) {
        rec.clicked = false;
        rec.err = String(e && e.name);
      }
    }
    C.syntheticClicks.push(rec);
    return rec;
  };

  for (const name of ['pushState', 'replaceState']) {
    const orig = history[name];
    history[name] = function (...args) {
      const to = skel(args[2] ?? location.href);
      const prev = C.pushStates.length ? C.pushStates[C.pushStates.length - 1].to : null;
      const t = R1(performance.now());
      C.pushStates.push({ n: name, t, to, prev, samePath: to === location.pathname });
      // 只对"真正换了 pathname"的那次排一个合成点击（pushState 自身递归不会发生）
      if (prev !== null && to !== prev) {
        C.lastPushT = t;
        setTimeout(() => fireBtn('auto-open@' + DELAY_MS + 'ms'), DELAY_MS);
      }
      return orig.apply(this, args);
    };
  }

  // 首次调用时把"当前 pathname"作为基线，避免把第一次 replaceState 误判成换集
  C.pushStates.push({ n: 'baseline', t: R1(performance.now()), to: location.pathname, prev: null, samePath: true });

  return JSON.stringify({ ok: true, installedAtMs: C.installedAtMs, delayMs: DELAY_MS, url: skel(location.href), btnFound: document.querySelector(BTN) !== null });
})()