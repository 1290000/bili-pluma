// 只读探针：活动页 nano.createPlayer 里补 requestConfig.reqHttpPlayUrlInfo 能否真接管取流。
// 用播放器自己生成的签名 params 自取流，并把 timelength 加 MARK_MS 作为「数据来自我们」的标记。
// 用法：MARK_MS=137000 FORCE_Q=360 POC_HEADLESS=1 node poc/probe/festival/nano-inject.cjs
// 产出：poc/probe/festival/result-nano-inject.json（URL 全脱敏）
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET =
  process.env.POC_TARGET ||
  'https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn';
const OUT = path.join(__dirname, 'result-nano-inject.json');
const MARK_MS = Number(process.env.MARK_MS || 137000);
const FORCE_Q = process.env.FORCE_Q ? Number(process.env.FORCE_Q) : 0;
const HEADLESS = process.env.POC_HEADLESS !== '0';

const INIT = ({ markMs, forceQ }) => {
  const P = {
    events: [],
    cbHits: 0,
    paramsKeys: [],
    fetchInfo: null,
    errors: [],
    createCalls: 0,
  };
  window.__INJECT__ = P;
  const log = (m) => P.events.push({ t: Math.round(performance.now()), m });

  let nanoRef;
  Object.defineProperty(window, 'nano', {
    configurable: true,
    enumerable: true,
    get() {
      return nanoRef;
    },
    set(v) {
      nanoRef = v;
      if (!v || typeof v.createPlayer !== 'function' || v.createPlayer.__injectWrapped) return;
      const orig = v.createPlayer;
      v.createPlayer = function (config) {
        P.createCalls += 1;
        log('createPlayer #' + P.createCalls + ' cid=' + (config && config.cid));
        try {
          if (!config || typeof config !== 'object') throw new Error('config 不是对象');
          const rc = config.requestConfig || (config.requestConfig = {});
          rc.reqHttpPlayUrlInfo = async function (params, cfg) {
            P.cbHits += 1;
            log('★ reqHttpPlayUrlInfo 被调用 #' + P.cbHits);
            try {
              P.paramsKeys = Object.keys(params || {});
              log('params keys=' + P.paramsKeys.slice(0, 30).join(','));
              const u = new URL('https://api.bilibili.com/x/player/wbi/playurl');
              for (const [k, val] of Object.entries(params || {})) {
                if (val !== undefined && val !== null) u.searchParams.set(k, String(val));
              }
              const t0 = performance.now();
              const r = await fetch(u.toString(), { credentials: 'include' });
              const j = await r.json();
              const d = j && j.data;
              P.fetchInfo = {
                http: r.status,
                code: j && j.code,
                ms: Math.round(performance.now() - t0),
                dataKeys: d ? Object.keys(d) : [],
                resultKeys: d && d.result ? Object.keys(d.result) : [],
                resultTimelength: d && d.result ? d.result.timelength : null,
                resultDashDuration: d && d.result && d.result.dash ? d.result.dash.duration : null,
                resultHeights:
                  d && d.result && d.result.dash && d.result.dash.video
                    ? d.result.dash.video.map((x) => x.height)
                    : [],
                heights: d && d.dash && d.dash.video ? d.dash.video.map((x) => x.height) : [],
                dashDuration: d && d.dash ? d.dash.duration : null,
                timelength: d ? d.timelength : null,
                quality: d ? d.quality : null,
              };
              log('自取流 code=' + (j && j.code) + ' timelength=' + (d && d.timelength));
              if (d && j.code === 0) {
                d.timelength = (d.timelength || 0) + markMs;
                if (d.dash && typeof d.dash.duration === 'number') {
                  d.dash.duration += Math.round(markMs / 1000);
                }
                if (d.result && typeof d.result === 'object') {
                  if (d.result.timelength) d.result.timelength += markMs;
                  if (d.result.dash && typeof d.result.dash.duration === 'number') {
                    d.result.dash.duration += Math.round(markMs / 1000);
                  }
                  if (forceQ && d.result.dash && Array.isArray(d.result.dash.video)) {
                    d.result.dash.video = d.result.dash.video.filter((x) => (x.height || 0) <= forceQ);
                  }
                }
                log(
                  '已加标记 timelength+' + markMs + ' → ' + d.timelength +
                    ' / dash.duration+' + Math.round(markMs / 1000) + ' → ' + (d.dash && d.dash.duration) +
                    ' / nested=' + (d.result && d.result.timelength),
                );
                if (forceQ && d.dash && Array.isArray(d.dash.video)) {
                  const before = d.dash.video.length;
                  d.dash.video = d.dash.video.filter((x) => (x.height || 0) <= forceQ);
                  d.quality = forceQ;
                  d.accept_quality = (d.accept_quality || []).filter((x) => x <= forceQ);
                  log('已裁 dash.video: ' + before + ' → ' + d.dash.video.length + ' (<= ' + forceQ + ')');
                }
              }
              // 对齐内核 requestDefault 的返回形状：{ data, headers, status }
              return { data: j, headers: {}, status: r.status };
            } catch (e) {
              P.errors.push('fetch: ' + e.message);
              log('自取流失败: ' + e.message);
              throw e;
            }
          };
          log('已注入 requestConfig.reqHttpPlayUrlInfo');
        } catch (e) {
          log('注入异常: ' + e.message);
        }
        return orig.call(this, config);
      };
      v.createPlayer.__injectWrapped = true;
      log('createPlayer 已包装');
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
  const net = { playurlXHR: 0, m4s: 0 };
  const errors = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\/x\/player\/wbi\/playurl/.test(u)) net.playurlXHR += 1;
    else if (/\.m4s(\?|$)/.test(u)) net.m4s += 1;
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200));
  });
  await page.addInitScript(INIT, { markMs: MARK_MS, forceQ: FORCE_Q });

  const out = { target: TARGET, markMs: MARK_MS, forceQ: FORCE_Q, at: new Date().toISOString() };
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
    await page.waitForTimeout(7000);
    out.probe = await page.evaluate(() => {
      const p = window.__INJECT__ || {};
      return {
        events: p.events || [],
        cbHits: p.cbHits || 0,
        paramsKeys: p.paramsKeys || [],
        fetchInfo: p.fetchInfo || null,
        errors: p.errors || [],
        createCalls: p.createCalls || 0,
      };
    });
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      let quality = null;
      try {
        quality = window.__LAST_PLAYER__?.getQuality?.();
      } catch (e) {}
      return {
        t: Math.round(v?.currentTime ?? 0),
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
        w: v?.videoWidth ?? 0,
        ready: v?.readyState ?? null,
        paused: v?.paused ?? null,
        err: v?.error?.code ?? null,
        quality,
      };
    });
    out.net = net;
    out.errors = errors.slice(0, 20);
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close().catch(() => {});
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2).slice(0, 20000));
})();
