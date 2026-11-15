/**
 * 页面网络取证钩子 —— 只读记录，不改任何请求。
 *
 * 用法：把本文件内容作为表达式传给 `bsk evaluate`（在目标页 document_start 之前注入做不到，
 * 所以策略是：注入钩子 → 触发页面重发请求 → 读回记录）。
 *
 * ⚠️ 只记录：host / path / method / query 参数**名** / body 字段**名** / 响应 code。
 * **绝不记录任何 cookie 值、SESSDATA、bili_jct 值**（AGENTS.md §5.2）。
 */
(() => {
  if (window.__API_INV__) return 'already-installed';

  const recs = [];
  const KEYS = new Set([
    'mid',
    'w_rid',
    'wts',
    'dm_img_list',
    'dm_img_str',
    'dm_cover_img_str',
    'dm_img_inter',
    'csrf',
    'bili_jct',
    'DedeUserID',
    'aid',
    'bvid',
    'cid',
    'ep_id',
    'season_id',
    'page',
    'progress',
    'played_time',
    'real_played_time',
  ]);

  const interesting = (text) => {
    const q = String(text || '');
    const out = [];
    for (const k of KEYS) {
      if (q.includes(k + '=') || q.includes('"' + k + '"')) out.push(k);
    }
    return out;
  };

  const push = (method, url, bodyKeys) => {
    try {
      const u = new URL(url, location.href);
      if (!/bilibili|bilivideo|hdslb/.test(u.hostname)) return;
      if (/\.(m4s|mp4|js|css|png|jpg|webp|svg|woff2?|wasm)$/.test(u.pathname)) return;
      recs.push({
        m: method,
        host: u.hostname,
        path: u.pathname,
        interesting: interesting(u.search),
        bodyKeys: bodyKeys || null,
      });
    } catch {
      /* ignore */
    }
  };

  // ── fetch ──
  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      let bodyKeys = null;
      const b = init && init.body;
      if (typeof b === 'string') bodyKeys = Object.keys(Object.fromEntries(new URLSearchParams(b)));
      push((init && init.method) || 'GET', url, bodyKeys);
    } catch {
      /* ignore */
    }
    return of.apply(this, arguments);
  };

  // ── XHR ──
  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__inv = { m: method, url };
    return oo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const r = this.__inv;
      if (r) {
        let bodyKeys = null;
        if (typeof body === 'string') {
          bodyKeys = Object.keys(Object.fromEntries(new URLSearchParams(body)));
        }
        push(r.m, r.url, bodyKeys);
      }
    } catch {
      /* ignore */
    }
    return os.apply(this, arguments);
  };

  window.__API_INV = {
    read: () => recs,
    clear: () => {
      recs.length = 0;
    },
  };
  return 'installed';
})();
