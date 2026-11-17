// 只读探针：SPA 换 bvid 后 nano 实例 / 注入回调是否还在；updateRequestConfig 能否重新挂回调。
// 产出：poc/probe/festival/result-nano-spa.json
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET = 'https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn';
const OUT = path.join(__dirname, 'result-nano-spa.json');
const HEADLESS = process.env.POC_HEADLESS !== '0';

const INIT = () => {
  const P = { events: [], cb1: 0, cb2: 0, createCalls: 0, errors: [], nanoSets: 0 };
  window.__SPA__ = P;
  const log = (m) => P.events.push({ t: Math.round(performance.now()), m });

  // 播放器原生签名 params → 自己 fetch → 包成内核 requestDefault 的形状
  const fetchPlayUrl = async (params, tag) => {
    try {
      const u = new URL('https://api.bilibili.com/x/player/wbi/playurl');
      for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      }
      const r = await fetch(u.toString(), { credentials: 'include' });
      const j = await r.json();
      log(tag + ' 自取流 code=' + (j && j.code) + ' cid=' + (params && params.cid));
      return { data: j, headers: {}, status: r.status };
    } catch (e) {
      P.errors.push(tag + ': ' + e.message);
      log(tag + ' 失败: ' + e.message);
      throw e;
    }
  };
  window.__SPA_FETCH__ = fetchPlayUrl;

  let nanoRef;
  Object.defineProperty(window, 'nano', {
    configurable: true,
    enumerable: true,
    get() {
      return nanoRef;
    },
    set(v) {
      nanoRef = v;
      P.nanoSets += 1;
      if (!v || typeof v.createPlayer !== 'function' || v.createPlayer.__spaWrapped) return;
      const orig = v.createPlayer;
      v.createPlayer = function (config) {
        P.createCalls += 1;
        log('createPlayer #' + P.createCalls + ' cid=' + (config && config.cid));
        if (config && typeof config === 'object') {
          const rc = config.requestConfig || (config.requestConfig = {});
          rc.reqHttpPlayUrlInfo = function (params, cfg) {
            P.cb1 += 1;
            log('★ cb1 被调用 #' + P.cb1);
            return fetchPlayUrl(params, 'cb1');
          };
        }
        const ret = orig.call(this, config);
        window.__SPA_PLAYER__ = ret;
        // 给初始 player 打标记，用于判断 SPA 切换后是否同一实例
        try {
          const pl = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.player;
          if (pl && !pl.__spaProbeTag) pl.__spaProbeTag = 'initial';
        } catch (e) {}
        return ret;
      };
      v.createPlayer.__spaWrapped = true;
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  await page.addInitScript(INIT);

  const out = { at: new Date().toISOString(), note: 'SPA 切换用 pushState+popstate 合成（页面无可用 festival 链接，状态确实随之改变）' };
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
    out.before = await page.evaluate(() => {
      const p = window.__SPA__ || {};
      const v = document.querySelector('video');
      return {
        createCalls: p.createCalls,
        cb1: p.cb1,
        events: p.events,
        cid: window.__INITIAL_STATE__?.videoInfo?.cid,
        playerTagged: window.__INITIAL_STATE__?.player?.__spaProbeTag || null,
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
      };
    });

    // 在切集前用 updateRequestConfig 挂第二个回调
    out.arm = await page.evaluate(() => {
      const pl = window.__INITIAL_STATE__?.player;
      if (!pl || typeof pl.updateRequestConfig !== 'function') return 'no player API';
      try {
        pl.updateRequestConfig({
          reqHttpPlayUrlInfo: function (params, cfg) {
            window.__SPA__.cb2 += 1;
            window.__SPA__.events.push({ t: Math.round(performance.now()), m: '★ cb2 被调用 #' + window.__SPA__.cb2 });
            return window.__SPA_FETCH__(params, 'cb2');
          },
        });
        return 'ok';
      } catch (e) {
        return 'error: ' + e.message;
      }
    });

    await page.evaluate(() => {
      history.pushState({}, '', '/festival/bnj2026?bvid=BV1eoZ7BnEGy');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForTimeout(14000);

    out.after = await page.evaluate(() => {
      const p = window.__SPA__ || {};
      const v = document.querySelector('video');
      return {
        createCalls: p.createCalls,
        cb1: p.cb1,
        cb2: p.cb2,
        nanoSets: p.nanoSets,
        nanoStillWrapped: !!(window.nano && window.nano.createPlayer && window.nano.createPlayer.__spaWrapped),
        samePlayer: window.__INITIAL_STATE__?.player === window.__SPA_PLAYER__,
        events: p.events,
        errors: p.errors,
        cid: window.__INITIAL_STATE__?.videoInfo?.cid,
        bvid: window.__INITIAL_STATE__?.videoInfo?.bvid,
        playerTagged: window.__INITIAL_STATE__?.player?.__spaProbeTag || null,
        url: location.href,
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
        t: Math.round(v?.currentTime ?? 0),
        ready: v?.readyState ?? null,
      };
    });
    out.pageErrors = errors;
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close().catch(() => {});
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2).slice(0, 24000));
})();
