/**
 * H6 复核：**新建标签页** → 不 hover 直接查浮层是否已有内容（判定数据是否预取）。
 * 再走一次 hover，记录请求。
 *
 * 上一轮的干扰：`initialOpen: true`（上一次探测留下的浮层还开着），
 * 所以"0 请求"可能只是"早就加载过了"。必须换干净页面重测。
 */
import { spawnSync } from 'node:child_process';

const BSK = process.env.BSK_BIN || 'bsk';
const SESSION = process.env.BSK_SESSION;
const TAB = process.env.BSK_TAB;

function evaluate(expr) {
  const r = spawnSync(
    BSK,
    ['evaluate', '--session', SESSION, '--tab-id', TAB, '--json', expr],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false },
  );
  if (r.error) throw r.error;
  const out = (r.stdout || '').trim();
  if (r.status !== 0) throw new Error(`evaluate failed (${r.status}): ${(r.stderr || out).slice(0, 800)}`);
  const parsed = JSON.parse(out);
  const v = parsed.value ?? parsed.result ?? parsed;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const EXPR = String.raw`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};

  // 干净页面：浮层此时**从未被打开过**
  const entry = document.querySelector('.v-popover-wrap.history-entry');
  if (!entry) return JSON.stringify({ fatal: 'entry missing / page not loaded' });
  const trigger = entry.querySelector('.right-entry__item-trigger') || entry;

  out.step0_neverOpened = {
    panelExists: !!document.querySelector('.history-panel-popover'),
    itemCountInPanel: document.querySelectorAll('.history-panel-popover a[href*="/video/"]').length,
  };

  // ── 安装网络钩子 ──
  if (!window.__HIST_NET2__) {
    const recs = [];
    const push = (method, url) => {
      try {
        const u = new URL(url, location.href);
        if (!/bilibili|hdslb/.test(u.hostname)) return;
        if (/\.(m4s|mp4|js|css|png|jpg|jpeg|webp|svg|woff2?|wasm|ico|gif)$/.test(u.pathname)) return;
        recs.push({ m: method, host: u.hostname, path: u.pathname });
      } catch (e) {}
    };
    const of = window.fetch;
    window.fetch = function (input, init) {
      try { push((init && init.method) || 'GET', typeof input === 'string' ? input : (input && input.url)); } catch (e) {}
      return of.apply(this, arguments);
    };
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url) {
      try { push(m, url); } catch (e) {}
      return oo.apply(this, arguments);
    };
    window.__HIST_NET2__ = { read: () => recs, clear: () => { recs.length = 0; } };
  }

  const net = window.__HIST_NET2__;
  net.clear();

  // ── hover 打开（首次）──
  const r0 = trigger.getBoundingClientRect();
  trigger.dispatchEvent(new MouseEvent('mouseenter', {
    bubbles: true, cancelable: true, view: window,
    clientX: Math.round(r0.x + r0.width/2), clientY: Math.round(r0.y + r0.height/2),
  }));
  await sleep(2000);

  const recs = net.read();
  const panel = document.querySelector('.history-panel-popover');

  out.firstHover = {
    opened: !!panel,
    itemCount: panel ? panel.querySelectorAll('a[href*="/video/"]').length : 0,
    requestCount: recs.length,
    requests: recs.slice(0, 25),
    historyRequests: recs.filter(r => /history|feed|rcmd/i.test(r.path)),
  };

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR));
