// 时序测量：页面自己的 `createPlayer` 到底在什么时刻被调用？
//
// ## 要回答的问题
//
// 2026-10-28 真机证据链：
//   - `window.nano.__plumaPgcWrapped === true`（我们的包装装上了）
//   - 手动调 `nano.createPlayer(cfg)` → 接管逻辑正常（prefetch 被删、回调被换）
//   - **但真实播放仍是 360s 试看**
//
// 唯一还站得住的解释：SSR 内联脚本在我们要装 hook 之前就已经调过 `createPlayer`。
//
// ## 方法
//
// Playwright 的 `addInitScript` 能抢在**页面任何脚本之前**执行，所以从这里开始
// 挂 `window.nano` 的 setter，能精确记录"nano 赋值 → createPlayer 调用"的时间差，
// 以及那一刻 `__playinfo__` 有没有就绪。
//
// 这个脚本**不装我们的 hook**，纯粹观测原生时序 —— 结论才能说明"hook 应该装在哪儿"。
//
//   node poc/probe/probe-pgc-timing.cjs
//   POC_TARGET=https://www.bilibili.com/bangumi/play/ss34412 node poc/probe/probe-pgc-timing.cjs
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET = process.env.POC_TARGET || 'https://www.bilibili.com/bangumi/play/ss34412';
const OUT = path.join(__dirname, 'result-pgc-timing.json');

const INIT = () => {
  const t0 = performance.now();
  window.__TIMING__ = [];
  const T = (what, extra) => {
    window.__TIMING__.push({
      ms: Math.round(performance.now() - t0),
      ready: document.readyState,
      what,
      ...(extra || {}),
    });
  };
  T('init-script 执行（页面任何脚本之前）');

  let nanoRef;
  try {
    Object.defineProperty(window, 'nano', {
      configurable: true,
      enumerable: true,
      get() {
        return nanoRef;
      },
      set(v) {
        T('window.nano 被赋值', {
          hasCreatePlayer: typeof v?.createPlayer === 'function',
          playinfoReady: !!window.__playinfo__,
          playinfoType: window.__playinfo__?.result?.play_video_type ?? null,
        });
        nanoRef = v;
        if (v && typeof v.createPlayer === 'function') {
          const orig = v.createPlayer;
          v.createPlayer = function (config) {
            T('createPlayer 被调用', {
              hasPrefetchPlayUrl: !!(config && config.prefetch && config.prefetch.playUrl),
              playinfoReady: !!window.__playinfo__,
              playinfoType: window.__playinfo__?.result?.play_video_type ?? null,
              hasReqCb: !!(config && config.requestConfig && config.requestConfig.reqHttpPlayUrlInfo),
            });
            return orig.apply(this, arguments);
          };
        }
      },
    });
    T('defineProperty(window.nano) 成功');
  } catch (e) {
    T('defineProperty(window.nano) 失败', { err: String(e && e.message) });
  }

  // 顺便记录 __playinfo__ 的赋值时刻（不接管，只观测）
  let pi;
  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      enumerable: true,
      get() {
        return pi;
      },
      set(v) {
        T('__playinfo__ 被赋值', {
          type: v?.result?.play_video_type ?? null,
          hasDash: !!v?.result?.video_info?.dash,
          durlMs: v?.result?.video_info?.durls?.[0]?.durl?.[0]?.length ?? null,
        });
        pi = v;
      },
    });
  } catch (e) {
    T('defineProperty(__playinfo__) 失败', { err: String(e && e.message) });
  }

  document.addEventListener('DOMContentLoaded', () => T('DOMContentLoaded'));
  window.addEventListener('load', () => T('window.load'));
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
    await page.waitForTimeout(12000);
    out.timing = await page.evaluate(() => window.__TIMING__ || []);
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        h: v?.videoHeight ?? 0,
        dur: Math.round(v?.duration ?? 0),
        nanoWrapped: !!window.nano,
        hasPlayer: !!window.player,
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
