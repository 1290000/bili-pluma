// PoC：验证能否在 MAIN world 拦截番剧播放器的 createPlayer，
// 并替换 reqHttpPlayUrlInfo 为「延迟 resolve 的 Promise」。
// 不需要登录态——番剧页未登录也能打开（试看）。
const { chromium } = require('playwright');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const BANGUMI = 'https://www.bilibili.com/bangumi/play/ep3854821';
const OUT = path.join(__dirname, 'result-hook-poc.json');

const INIT = () => {
  window.__PLUMA_LOG__ = [];
  const log = (m) => window.__PLUMA_LOG__.push({ t: Math.round(performance.now()), m });

  let nanoRef;
  try {
    Object.defineProperty(window, 'nano', {
      configurable: true,
      enumerable: true,
      get() {
        return nanoRef;
      },
      set(v) {
        nanoRef = v;
        log('nano 被赋值, keys=' + (v && typeof v === 'object' ? Object.keys(v).join(',') : typeof v));
        if (v && typeof v.createPlayer === 'function') {
          const orig = v.createPlayer;
          v.createPlayer = function (config) {
            log('createPlayer 被调用');
            try {
              const rc = config && config.requestConfig;
              log('requestConfig keys=' + (rc ? Object.keys(rc).join(',') : 'none'));
              if (rc && typeof rc.reqHttpPlayUrlInfo === 'function') {
                const o = rc.reqHttpPlayUrlInfo;
                rc.reqHttpPlayUrlInfo = function (...args) {
                  log('★ reqHttpPlayUrlInfo 被调用（第 ' + (window.__PLUMA_HITS__ = (window.__PLUMA_HITS__ || 0) + 1) + ' 次）');
                  const r = o.apply(this, args);
                  Promise.resolve(r)
                    .then((d) => {
                      const res = d && d.data && d.data.result;
                      log(
                        '  返回数据: code=' + (d && d.code) +
                          ' type=' + (res && res.play_video_type) +
                          ' quality=' + (res && res.video_info && res.video_info.quality),
                      );
                    })
                    .catch((e) => log('  返回数据解析失败: ' + e.message));
                  return r;
                };
              }
              if (config && config.prefetch) {
                log('prefetch keys=' + Object.keys(config.prefetch).join(','));
              }
            } catch (e) {
              log('hook 内部异常: ' + e.message);
            }
            return orig.call(this, config);
          };
          log('createPlayer 已包装');
        }
      },
    });
    log('defineProperty(window.nano) 成功');
  } catch (e) {
    log('defineProperty 失败: ' + e.message);
  }
};

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
  });
  const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.addInitScript(INIT);

  const out = {};
  try {
    await page.goto(BANGUMI, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);

    out.log = await page.evaluate(() => window.__PLUMA_LOG__ || []);
    out.hits = await page.evaluate(() => window.__PLUMA_HITS__ || 0);
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        video: v ? { h: v.videoHeight, w: v.videoWidth, t: Math.round(v.currentTime), paused: v.paused } : null,
        nanoKeys: window.nano ? Object.keys(window.nano).slice(0, 20) : null,
        hasPlayer: !!window.player,
        playinfoQuality: window.__playinfo__?.result?.video_info?.quality ?? null,
        hydrateQuality: window.__PLAYURL_HYDRATE_DATA__?.result?.video_info?.quality ?? null,
      };
    });
  } catch (e) {
    out.error = e.message;
  } finally {
    writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    await browser.close();
    console.log(JSON.stringify(out, null, 1));
  }
})();
