/**
 * 「单独一次 `pushState` 会不会触发 `resetLoadingTrace()`」对照实验（页面上下文，只读 + 合成一次 hash 导航）。
 *
 * ## 为什么要做这个对照
 *
 * 真实换集是「点击 + pushState + navigate + 路由重渲染」一整套动作，
 * 从外部只能看到"reset 发生了"，**看不到它挂在哪个信号上**。
 *
 * 本探针只做**最小的一件事**：
 * 用 `history.pushState(null, '', pathname + '#epa-hash-probe')` 造一次
 * **同 pathname** 的同文档导航 ——
 *
 * - `navigate` 事件**会**触发（`navigationType: 'push'`）
 * - `playPageIdentity` **不变**（pathname 没动）
 *
 * 于是结果只有两种解读：
 *
 * | 观测 | 结论 |
 * | --- | --- |
 * | `hosts` 掉到 0（reset 发生） | reset 挂在 **navigate 事件**上，与 identity 无关 |
 * | `hosts` 不掉 | reset 需要 identity 变化（或别的东西），不是"任何 navigate" |
 *
 * ## 它为什么安全
 *
 * - 只改 hash，不改 pathname ⇒ 播放页路由不会重载，视频不会中断
 * - 结束后自动 `history.back()` 把 hash 撤掉（`navigationType: 'traverse'`）
 * - 不发任何网络请求（`fetch` 一次都不调）
 * - 不改任何产品代码
 */
(() => {
  const R1 = (x) => Math.round(x * 10) / 10;
  const KEY = '__EP_NAVONLY__';
  if (window[KEY]) return JSON.stringify({ ok: true, already: true });

  const C = {
    installedAtMs: R1(performance.now()),
    url0: location.hostname + location.pathname + location.search,
    navigations: [],
    hostSamples: [],
    pushT: null,
    backT: null,
    done: false,
  };
  window[KEY] = C;

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

  const record = (raw, s) =>
    C.hostSamples.push({
      t: R1(performance.now()),
      nEvents: s === null ? null : s.events.length,
      hostsLen: s === null ? null : s.hosts.length,
      actual: s === null || s.actual === null ? null : s.actual.host,
      note: raw,
    });

  try {
    navigation.addEventListener('navigate', (ev) => {
      C.navigations.push({
        t: R1(performance.now()),
        type: ev.navigationType,
        to: ev.destination && ev.destination.url ? String(ev.destination.url).replace(/[?#].*$/, '') : '',
        hash: ev.destination && ev.destination.url ? (/[?#]/.test(String(ev.destination.url)) ? 'changed' : 'none') : '',
      });
    });
  } catch (e) {
    C.navErr = String(e && e.name);
  }

  const run = async () => {
    // 0) 基线
    record('baseline', await snap());

    // 1) hash-only pushState
    C.pushT = R1(performance.now());
    history.pushState(null, '', location.pathname + location.search + '#epa-hash-probe');
    record('after-push', await snap());

    // 2) 每 120ms 采一次，共 8 次（≈1s），看 hosts 会不会掉到 0
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 120));
      record('poll' + i, await snap());
    }

    // 3) 撤掉 hash
    C.backT = R1(performance.now());
    history.back();
    await new Promise((r) => setTimeout(r, 320));
    record('after-back', await snap());

    C.done = true;
    C.urlEnd = location.hostname + location.pathname + location.search;
    return JSON.stringify({
      ok: true,
      installedAtMs: C.installedAtMs,
      url0: C.url0,
      urlEnd: C.urlEnd,
      pushT: C.pushT,
      backT: C.backT,
      navigations: C.navigations,
      hostSamples: C.hostSamples,
      resetHappened: C.hostSamples.some((x) => x.hostsLen === 0 && x.t > (C.pushT || 0) && x.t < (C.backT || Infinity)),
    });
  };

  return run();
})()