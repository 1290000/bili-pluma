/**
 * H3 + H6 探测：
 *   H3 —— 浮层是 hover 打开还是 click 打开？关闭时机（移出即关 / 延迟）？
 *   H6 —— 浮层首次打开时有没有网络请求？（还是数据已预取）
 *
 * 只读：不点击任何会改变状态的元素。浮层图标本身只用于"打开面板"。
 * ⚠️ 网络钩子只记录 host + path + method + query 参数**名**，绝不记录 cookie/凭据值。
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
  if (r.status !== 0) throw new Error(`evaluate failed (${r.status}): ${(r.stderr || out).slice(0, 600)}`);
  const parsed = JSON.parse(out);
  const v = parsed.value ?? parsed.result ?? parsed;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const EXPR = String.raw`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};

  // ── 安装网络钩子（只读，只记 host+path+method+参数名）──
  if (!window.__HIST_NET__) {
    const recs = [];
    const push = (method, url) => {
      try {
        const u = new URL(url, location.href);
        if (!/bilibili|hdslb/.test(u.hostname)) return;
        if (/\.(m4s|mp4|js|css|png|jpg|webp|svg|woff2?|wasm|ico)$/.test(u.pathname)) return;
        recs.push({ m: method, host: u.hostname, path: u.pathname,
                    qKeys: [...u.searchParams.keys()].slice(0, 12) });
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
    window.__HIST_NET__ = {
      read: () => recs,
      clear: () => { recs.length = 0; },
    };
  }
  const net = window.__HIST_NET__;
  net.clear();

  const panel = () => document.querySelector('.history-panel-popover');
  const isOpen = () => {
    const p = panel();
    if (!p) return false;
    const r = p.getBoundingClientRect();
    return r.width > 100 && r.height > 100 && p.querySelectorAll('a[href*="/video/"]').length > 0;
  };

  const entry = document.querySelector('.v-popover-wrap.history-entry');
  const trigger = entry.querySelector('.right-entry__item-trigger') || entry;
  const r0 = trigger.getBoundingClientRect();
  const cx = Math.round(r0.x + r0.width / 2);
  const cy = Math.round(r0.y + r0.height / 2);

  const fire = (el, t) => el.dispatchEvent(new MouseEvent(t, {
    bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy,
  }));

  out.initialOpen = isOpen();

  // ══ 阶段 1：只发 mouseenter，不点 ══
  // 先确保关闭（把鼠标移到 body 空白处）
  fire(document.body, 'mousemove');
  await sleep(800);
  out.afterMoveAway = isOpen();

  // 只发 mouseenter
  fire(trigger, 'mouseenter');
  await sleep(1200);
  out.afterMouseenterOnly = isOpen();
  out.h3_verdict_hover_opens = out.afterMouseenterOnly;

  // ══ 阶段 2：移出后多久关闭 ══
  if (isOpen()) {
    fire(document.body, 'mousemove');
    const t0 = Date.now();
    let closedAt = null;
    for (let i = 0; i < 40; i++) {          // 最多等 4 秒
      await sleep(100);
      if (!isOpen()) { closedAt = Date.now() - t0; break; }
    }
    out.closeDelayMs = closedAt;            // null = 4 秒内没关
    out.closeMode = closedAt === null ? 'not-auto-closed-within-4s'
                  : (closedAt < 200 ? 'immediate(<200ms)' : 'delayed');
  }

  // ══ 阶段 3：H6 —— 首次打开的网络请求 ══
  net.clear();
  const beforeNetLen = net.read().length;
  fire(trigger, 'mouseenter');
  await sleep(1800);
  out.panelOpenedForNet = isOpen();
  const recs = net.read();
  out.h6_requestsOnOpen = recs.slice(0, 20);
  out.h6_requestCount = recs.length;

  // 关键判定：有没有打到 history 相关的 host+path
  out.h6_historyRequests = recs.filter(r => /history/i.test(r.path) || /history/i.test(r.host));

  // ══ 阶段 4：第二个账号视角 —— 数据是否已在 HTML 里预取 ══
  // 若首次打开就 0 请求但列表有 17 条，说明数据来自页面 HTML/预取
  out.h6_renderedItemsOnFirstOpen =
    panel() ? panel().querySelectorAll('a[href*="/video/"]').length : 0;

  // 页面自身是否内联了历史数据（搜 HTML 里的关键词，不下发值）
  const html = document.documentElement.innerHTML;
  out.h6_htmlHasHistoryKeyword = {
    len: html.length,
    hasHistoryCursor: /history\/cursor|historyCursor/.test(html),
    hasHistoryData: /__INITIAL_STATE__/.test(html) ? 'has INITIAL_STATE' : 'no INITIAL_STATE',
  };

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR));
