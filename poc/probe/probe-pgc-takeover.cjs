// 复现我们的 hook 在**真实时序**下的行为：能不能接管，以及接管后播的是谁的数据。
//
// 与 `probe-pgc-timing.cjs` 的区别：那个只观测原生时序，这个装上与
// `public/main-world.js` 完全相同的接管逻辑（删 prefetch + 换回调 + 合并），
// 然后看 `video.duration` 变成多少。
//
//   POC_HEADLESS=1 node poc/probe/probe-pgc-takeover.cjs
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET = process.env.POC_TARGET || 'https://www.bilibili.com/bangumi/play/ss34412';
const OUT = path.join(__dirname, 'result-pgc-takeover.json');

const INIT = () => {
  const t0 = performance.now();
  window.__L__ = [];
  const L = (m, e) => window.__L__.push({ ms: Math.round(performance.now() - t0), m, ...(e || {}) });

  /** 与 main-world.js 的 pgcMerge 同逻辑：SSR 骨架 + 接口流字段 */
  function merge(ssr, api) {
    const inner = ssr && ssr.result ? ssr : { code: 0, result: {} };
    const br = inner.result || {};
    const vi = br.video_info || {};
    const videoInfo = Object.assign({}, vi, {
      quality: api.quality != null ? api.quality : vi.quality,
      timelength: api.timelength != null ? api.timelength : vi.timelength,
      format: api.format != null ? api.format : vi.format,
      dash: api.dash || vi.dash,
      durl: api.durl || (api.durls && api.durls[0] && api.durls[0].durl) || vi.durl,
      durls: api.durls || vi.durls,
      accept_quality: api.accept_quality || vi.accept_quality,
      accept_description: api.accept_description || vi.accept_description,
      support_formats: api.support_formats || vi.support_formats,
      is_preview: false,
    });
    return {
      status: 200,
      data: Object.assign({}, inner, { code: 0, result: Object.assign({}, br, { video_info: videoInfo }) }),
    };
  }

  let nanoRef;
  Object.defineProperty(window, 'nano', {
    configurable: true,
    enumerable: true,
    get() {
      return nanoRef;
    },
    set(v) {
      nanoRef = v;
      if (!v || typeof v.createPlayer !== 'function' || v.__wrapped) return;
      v.__wrapped = true;
      const orig = v.createPlayer;
      v.createPlayer = function (config) {
        L('createPlayer', { hasPrefetch: !!(config && config.prefetch && config.prefetch.playUrl) });
        try {
          const ssr = window.__playinfo__;
          const r0 = ssr && ssr.result;
          const vi = (r0 && r0.video_info) || {};
          const preview = r0 && (r0.play_video_type === 'preview' || vi.is_preview === true);
          const cid = (r0 && r0.arc && r0.arc.cid) || vi.cid;
          const rc = config && config.requestConfig;
          if (preview && cid && rc && typeof rc.reqHttpPlayUrlInfo === 'function') {
            const fallback = rc.reqHttpPlayUrlInfo;
            if (config.prefetch) delete config.prefetch.playUrl;
            rc.reqHttpPlayUrlInfo = function () {
              const url = `https://api.bilibili.com/pgc/player/web/playurl?cid=${cid}&avid=0&qn=80&fnval=4048&fnver=0&fourk=1`;
              return fetch(url, { credentials: 'include' })
                .then((r) => r.json())
                .then((j) => {
                  if (!j || j.code !== 0 || !j.result) throw new Error('code=' + (j && j.code));
                  const out = merge(ssr, j.result);
                  const vi2 = out.data.result.video_info || {};
                  L('fetch-ok', {
                    timelength: vi2.timelength,
                    dashGroups: (vi2.dash && vi2.dash.video.length) || 0,
                    durlMs: (vi2.durls && vi2.durls[0] && vi2.durls[0].durl[0].length) || null,
                  });
                  return out;
                })
                .catch((e) => {
                  L('fetch-fail', { err: String(e && e.message).slice(0, 80) });
                  return fallback.call(rc);
                });
            };
            L('takeover', { cid });
          } else {
            L('skip', { preview: !!preview, cid: cid || null, hasRc: !!rc });
          }
        } catch (e) {
          L('error', { err: String(e && e.message).slice(0, 80) });
        }
        return orig.apply(this, arguments);
      };
    },
  });
};

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.POC_HEADLESS === '1',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--lang=zh-CN',
    ],
  });
  const ctx = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  await page.addInitScript(INIT);

  const out = { target: TARGET };
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);
    await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (v) {
          v.muted = true;
          void v.play().catch(() => {});
        }
      })
      .catch(() => {});
    await page.waitForTimeout(6000);

    out.log = await page.evaluate(() => window.__L__ || []);
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
        t: Math.round(v?.currentTime ?? 0),
        paused: v?.paused ?? null,
        err: v?.error?.code ?? null,
      };
    });
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close();
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 1));
})();
