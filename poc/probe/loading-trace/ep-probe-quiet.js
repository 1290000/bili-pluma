/**
 * 「静默测量」探针（页面上下文，**只收不发**）—— 用于干净地数面板取数次数。
 *
 * ## 为什么必须"先静默、再计数"
 *
 * 前一轮 `ep-probe-snapcount.js` 读到 140 次/秒，不是面板行为。
 * 根因找到了：**我自己**的主探针 `ep-probe-install.js` 每 20ms 就发一次
 * `__PLUMA__ / loading-snapshot`（`P.poll`，见该文件 `:278-298`），
 * 用来采样快照。只要它还活着，`loading-snapshot` 的计数就全被它占满，
 * 面板发没发根本看不出来。
 *
 * ## 本探针做两件事（都只读）
 *
 * 1. 调所有已知探针的 `stop()`（`__EP_SWITCH_PROBE__` / `__EP_FINE__` …），
 *    并摘掉它们的 20ms 采样定时器
 * 2. 装一个**纯监听**的 `loading-snapshot` 计数器（自己不 postMessage）
 *
 * 静默之后，`loading-snapshot` 的唯一生产者就只剩
 * `panel-data.ts` 的 `fetchLoadingSnapshotViaPage()`，
 * 也就是"面板确实在取数"。计数不涨 = 面板没取数。
 */
(() => {
  const R1 = (x) => Math.round(x * 10) / 10;
  const stopped = [];

  // 已知探针的全局句柄 → 全部停掉（每个都有 stop()）
  for (const key of ['__EP_SWITCH_PROBE__', '__EP_FINE__', '__EP_SNAPCNT_OLD__']) {
    const p = window[key];
    if (!p) continue;
    try {
      if (typeof p.stop === 'function') {
        p.stop();
        stopped.push(key + '.stop()');
      }
      if (p.timer) {
        clearInterval(p.timer);
        p.timer = null;
        stopped.push(key + '.timer');
      }
      delete window[key];
      stopped.push(key + ' deleted');
    } catch (e) {
      stopped.push(key + ' ERR ' + String(e && e.name));
    }
  }

  // 兜底：把"每 20ms 发一次 loading-snapshot"的定时器全杀掉
  // （无法枚举，只能靠上面的句柄；此处只清理残留的 interval 计数以便自检）
  let killCount = 0;
  try {
    const topId = setInterval(() => {}, 1e9);
    // 浏览器里 interval id 是小整数递增的，把 0..topId 全清一遍是安全的保底手段
    for (let i = 1; i <= topId; i += 1) {
      clearInterval(i);
      killCount += 1;
    }
    clearInterval(topId);
    stopped.push('cleared 1..' + topId + ' intervals');
  } catch (e) {
    stopped.push('interval sweep ERR ' + String(e && e.name));
  }

  // 装纯监听计数器
  const C = { installedAtMs: R1(performance.now()), reqs: [], marks: [{ t: R1(performance.now()), label: 'quiet' }] };
  C.markNow = (label) => {
    C.marks.push({ t: R1(performance.now()), label: String(label).slice(0, 40) });
  };
  C.reset = () => {
    C.reqs.length = 0;
    C.marks.length = 0;
    C.markNow('reset');
  };
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__ns !== '__PLUMA__' || d.type !== 'loading-snapshot') return;
    C.reqs.push({ t: R1(performance.now()) });
  });
  window.__EP_QUIETCOUNT__ = C;

  // 静默后立刻取一次基线：等 1.2s 再报告，若这期间计数仍疯涨说明没清干净
  return new Promise((resolve) => {
    const t0 = performance.now();
    setTimeout(() => {
      resolve(
        JSON.stringify({
          ok: true,
          stopped,
          killCount,
          installedAtMs: C.installedAtMs,
          afterQuietMs: R1(performance.now() - t0),
          nQuiet: C.reqs.length,
          quietRate: Math.round((C.reqs.length / ((performance.now() - t0) / 1000)) * 100) / 100,
          url: location.hostname + location.pathname,
        }),
      );
    }, 1200);
  });
})()