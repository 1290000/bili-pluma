// 未知 1：在 createPlayer(config) 返回之前同步塞 requestConfig.reqHttpPlayUrlInfo，播放器认不认？
// 三种模式：
//   MODE=off   对照：不注入，只记录播放器原生 XHR 的 playurl 参数
//   MODE=stub  同步注入一个「记录后立刻抛错」的回调，只为证明它被调用
//   MODE=real  同步注入真实取流回调（fetch 播放器给的 params），并裁 dash.video 到 <=FORCE_Q 证明消费
// 用法：
//   MODE=stub POC_HEADLESS=1 node poc/probe/festival/nano-sync-inject.cjs
//   MODE=real FORCE_Q=360 POC_HEADLESS=1 node poc/probe/festival/nano-sync-inject.cjs
//   MODE=off POC_HEADLESS=1 node poc/probe/festival/nano-sync-inject.cjs
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET =
  process.env.POC_TARGET ||
  'https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn';
const MODE = process.env.MODE || 'stub';
const FORCE_Q = Number(process.env.FORCE_Q || 0);
const HEADLESS = process.env.POC_HEADLESS !== '0';
const OUT = path.join(__dirname, `result-sync-${MODE}${FORCE_Q ? '-q' + FORCE_Q : ''}.json`);

const INIT = ({ mode, forceQ }) => {
  const P = { mode, events: [], nanoSets: 0, createCalls: 0, cbHits: 0, cbParams: null, xhr: [], fetch: [], errors: [] };
  window.__SYNC__ = P;
  const log = (m) => P.events.push({ t: Math.round(performance.now()), m });

  const pick = (params) => {
    const p = params || {};
    return {
      keys: Object.keys(p),
      cid: p.cid, avid: p.avid, bvid: p.bvid, qn: p.qn, fnval: p.fnval, fnver: p.fnver, fourk: p.fourk,
      types: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Array.isArray(v) ? 'array' : typeof v])),
    };
  };

  // 对照模式：document_start 记录播放器原生 XHR 的 playurl 请求参数
  if (mode === 'off') {
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      try {
        const url = String(u);
        if (/\/x\/player\/(wbi\/)?playurl/.test(url)) {
          const x = new URL(url, location.href);
          const q = {};
          for (const [k, v] of x.searchParams) q[k] = v;
          P.xhr.push({ t: Math.round(performance.now()), path: x.pathname, ...pick(q), hasWrid: x.searchParams.has('w_rid') });
          log('native XHR playurl qn=' + q.qn + ' fnval=' + q.fnval + ' cid=' + q.cid);
        }
      } catch (e) {}
      return oo.apply(this, arguments);
    };
  }

  // 记录所有 fetch（用于 real 模式确认回调用的是 fetch，不是播放器 XHR）
  const of = window.fetch;
  window.fetch = function (input) {
    try {
      const u = typeof input === 'string' ? input : input && input.url ? input.url : '';
      if (/\/x\/player\/(wbi\/)?playurl/.test(u)) {
        const x = new URL(u, location.href);
        P.fetch.push({ t: Math.round(performance.now()), hasWrid: x.searchParams.has('w_rid'), qn: x.searchParams.get('qn') });
      }
    } catch (e) {}
    return of.apply(this, arguments);
  };

  let nanoRef;
  Object.defineProperty(window, 'nano', {
    configurable: true,
    enumerable: true,
    get() { return nanoRef; },
    set(v) {
      P.nanoSets += 1;
      nanoRef = v;
      if (!v || typeof v.createPlayer !== 'function' || v.createPlayer.__syncWrapped) return;
      const orig = v.createPlayer;
      v.createPlayer = function (config) {
        P.createCalls += 1;
        const tCreate = Math.round(performance.now());
        log('createPlayer #' + P.createCalls + ' at ' + tCreate + 'ms cid=' + (config && config.cid));
        if (mode !== 'off' && config && typeof config === 'object') {
          try {
            // ★ 关键：在 orig 之前同步塞进去，不判任何门控
            config.requestConfig = config.requestConfig || {};
            config.requestConfig.reqHttpPlayUrlInfo = async function (params) {
              P.cbHits += 1;
              P.cbParams = pick(params);
              log('★ sync cb #' + P.cbHits + ' at ' + Math.round(performance.now()) + 'ms cid=' + (params && params.cid) + ' qn=' + (params && params.qn));
              if (mode === 'stub') {
                throw new Error('SYNC_STUB_CALLED');
              }
              try {
                const u = new URL('https://api.bilibili.com/x/player/wbi/playurl');
                for (const [k, val] of Object.entries(params || {})) {
                  if (val !== undefined && val !== null) u.searchParams.set(k, String(val));
                }
                const r = await of(u.toString(), { credentials: 'include' });
                const j = await r.json();
                const d = j && j.data;
                P.response = {
                  http: r.status, code: j && j.code,
                  heights: d && d.dash && d.dash.video ? d.dash.video.map((x) => x.height) : [],
                  dashDuration: d && d.dash ? d.dash.duration : null,
                  timelength: d ? d.timelength : null,
                };
                if (d && forceQ && d.dash && Array.isArray(d.dash.video)) {
                  const before = d.dash.video.length;
                  d.dash.video = d.dash.video.filter((x) => (x.height || 0) <= forceQ);
                  d.quality = forceQ;
                  d.accept_quality = (d.accept_quality || []).filter((x) => x <= forceQ);
                  P.response.heightsAfter = d.dash.video.map((x) => x.height);
                  log('filtered dash.video ' + before + ' -> ' + d.dash.video.length);
                }
                return { data: j, headers: {}, status: r.status };
              } catch (e) {
                P.errors.push('fetch: ' + e.message);
                throw e;
              }
            };
            P.injected = true;
            log('已同步注入 requestConfig.reqHttpPlayUrlInfo (mode=' + mode + ')');
          } catch (e) {
            P.errors.push('inject: ' + e.message);
            log('注入异常: ' + e.message);
          }
        }
        const ret = orig.call(this, config);
        return ret;
      };
      v.createPlayer.__syncWrapped = true;
      log('createPlayer 已包装 (mode=' + mode + ')');
    },
  });
};

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
  });
  const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
  await page.addInitScript(INIT, { mode: MODE, forceQ: FORCE_Q });

  const out = { mode: MODE, target: TARGET, forceQ: FORCE_Q, at: new Date().toISOString() };
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);
    await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return;
        v.muted = true;
        void v.play().catch(() => {});
      })
      .catch(() => {});
    await page.waitForTimeout(6000);
    out.probe = await page.evaluate(() => {
      const p = window.__SYNC__ || {};
      return {
        nanoSets: p.nanoSets, createCalls: p.createCalls, cbHits: p.cbHits, cbParams: p.cbParams,
        injected: !!p.injected, response: p.response || null, xhr: p.xhr || [], fetch: p.fetch || [],
        errors: p.errors || [], events: p.events || [],
      };
    });
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { t: Math.round(v?.currentTime ?? 0), dur: Math.round(v?.duration ?? 0), h: v?.videoHeight ?? 0, w: v?.videoWidth ?? 0, ready: v?.readyState ?? null, paused: v?.paused ?? null, err: v?.error?.code ?? null };
    });
    out.pageErrors = pageErrors.slice(0, 10);
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close().catch(() => {});
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({ probe: out.probe, state: out.state, pageErrors: out.pageErrors, error: out.error }, null, 2).slice(0, 16000));
})();
