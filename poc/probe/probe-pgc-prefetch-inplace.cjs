// 现场实验：hook 真实的 createPlayer，就地替换 config.prefetch.playUrl 里的 video_info
//
// ## 为什么必须 addInitScript
//
// 页面只调一次 createPlayer（409ms）。要拦到那一次，必须在页面任何脚本之前执行。
// Playwright 的 addInitScript 正是这个时机。
//
// ## 这次改什么
//
// 上一轮已经确认：
//   - 播放器**不读** window.__playinfo__（getter 计数 = 0）
//   - `dash` 数据本身是对的（MSE 实测 seekable=1440）
//   - 删 durl / 改三个试看字段都无效（因为改的是没人用的对象）
//
// 所以这一轮：在 createPlayer 里**就地**把 `config.prefetch.playUrl` 的
// `result.video_info` 换成完整流，并抹掉 durl。用的数据来自现场 fetch。
//
//   POC_HEADLESS=1 node poc/probe/probe-pgc-prefetch-inplace.cjs
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET = process.env.POC_TARGET || 'https://www.bilibili.com/bangumi/play/ss34412';
const OUT = path.join(__dirname, 'result-pgc-prefetch-inplace.json');

const INIT = () => {
  const t0 = performance.now();
  window.__L__ = [];
  const L = (m, e) => window.__L__.push({ ms: Math.round(performance.now() - t0), m, ...(e || {}) });

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
        L('createPlayer 被调用', {
          hasPrefetch: !!(config && config.prefetch),
          prefetchKeys: config && config.prefetch ? Object.keys(config.prefetch) : null,
          playUrlSameAsPlayinfo: !!(config && config.prefetch && config.prefetch.playUrl === window.__playinfo__),
        });

        try {
          const pf = config && config.prefetch && config.prefetch.playUrl;
          const r = pf && pf.result;
          const vi = r && r.video_info;
          const cid = (r && r.arc && r.arc.cid) || (vi && vi.cid);
          L('prefetch 结构', {
            hasResult: !!r,
            hasVideoInfo: !!vi,
            cid: cid || null,
            durlMs: (vi && vi.durls && vi.durls[0] && vi.durls[0].durl && vi.durls[0].durl[0].length) || null,
          });

          if (cid && vi) {
            /**
             * 同步改**不够**：需要拿接口的完整流，而 fetch 是异步。
             * 但 config 是对象，播放器会在 connect() 之后才真正用。
             * 策略：先就地塞一个占位（保持结构），异步拿到后**同一对象**再覆盖。
             */
            window.__PLUMA_INPLACE__ = { vi, cid, done: false };
            const url = `https://api.bilibili.com/pgc/player/web/playurl?cid=${cid}&avid=0&qn=80&fnval=4048&fnver=0&fourk=1`;
            fetch(url, { credentials: 'include' })
              .then((res) => res.json())
              .then((j) => {
                if (!j || j.code !== 0 || !j.result) throw new Error('code=' + (j && j.code));
                const api = j.result;
                // 就地覆盖：只动流字段，保留 SSR 的其余键
                if (api.dash) vi.dash = api.dash;
                if (api.timelength) vi.timelength = api.timelength;
                if (api.quality) vi.quality = api.quality;
                if (api.accept_quality) vi.accept_quality = api.accept_quality;
                // 有 dash 就删 durl，逼播放器走 dash
                delete vi.durl;
                delete vi.durls;
                // 类型标识也要改成 dash 的样子（原来是 3 / flv）
                vi.type = 0;
                vi.format = api.format || 'flv720';
                window.__PLUMA_INPLACE__.done = true;
                L('已就地覆盖 prefetch.video_info', {
                  dashGroups: api.dash ? api.dash.video.length : 0,
                  timelength: api.timelength,
                  durlGone: !vi.durl,
                });
              })
              .catch((e) => L('fetch/覆盖失败', { err: String(e && e.message).slice(0, 80) }));
          }
        } catch (e) {
          L('hook 内部异常', { err: String(e && e.message).slice(0, 80) });
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
  page.setDefaultTimeout(30_000);
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
    await page.waitForTimeout(8000);

    out.log = await page.evaluate(() => window.__L__ || []);
    out.inplace = await page.evaluate(() => {
      const s = window.__PLUMA_INPLACE__;
      if (!s) return null;
      return {
        done: s.done,
        hasDash: !!s.vi.dash,
        dashDur: s.vi.dash && s.vi.dash.duration,
        durlGone: !s.vi.durl && !s.vi.durls,
        type: s.vi.type,
        format: s.vi.format,
      };
    });
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
        t: Math.round(v?.currentTime ?? 0),
        paused: v?.paused ?? null,
        seekable: v && v.seekable.length ? Math.round(v.seekable.end(0)) : 0,
        buffered: v && v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1)) : 0,
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
