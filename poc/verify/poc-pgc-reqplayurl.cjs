// PoC：番剧页的播放器在「没有 prefetch.playUrl」时，会不会回退去调 reqHttpPlayUrlInfo？
//
// 为什么这个问题决定架构：
//   PGC 页的取流数据由服务端写进 HTML（`playurlSSRData`），页面零请求，DNR 无从下手（ADR 0007）。
//   但 SSR 里给播放器的配置长这样：
//       config.prefetch = { playUrl: playurlSSRData.data }      // 同步的「数据对象」
//       requestConfig.reqHttpPlayUrlInfo = () => Promise.resolve(playurlSSRData)  // 异步的「取流回调」
//   如果删掉 prefetch.playUrl 后播放器会去调 reqHttpPlayUrlInfo，那我们就能把后者换成
//   「用播放账号身份 fetch /pgc/player/web/playurl」——异步、无需预取、无需二次加载。
//
// 不需要登录态：用一个游客也能完整播放的免费番剧页即可。
//
//   node poc/verify/poc-pgc-reqplayurl.cjs            # 有窗口
//   POC_HEADLESS=1 node poc/verify/poc-pgc-reqplayurl.cjs
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET = process.env.POC_TARGET || 'https://www.bilibili.com/bangumi/play/ss47836';
const OUT = path.join(__dirname, 'result-pgc-reqplayurl.json');

/**
 * @param {boolean} dropPrefetch true = 删掉 config.prefetch.playUrl（测回退）
 */
const INIT = (dropPrefetch) => {
  window.__PLUMA_LOG__ = [];
  const log = (m) => window.__PLUMA_LOG__.push({ t: Math.round(performance.now()), m });
  window.__PLUMA_HITS__ = 0;

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
        log('nano 被赋值 keys=' + (v && typeof v === 'object' ? Object.keys(v).join(',') : typeof v));
        if (!v || typeof v.createPlayer !== 'function') return;

        const orig = v.createPlayer;
        v.createPlayer = function (config) {
          try {
            const pf = config && config.prefetch;
            log('createPlayer: prefetch keys=' + (pf ? Object.keys(pf).join(',') : 'none'));
            const hasPlayUrl = !!(pf && pf.playUrl);
            log('prefetch.playUrl present=' + hasPlayUrl + ' type=' + (hasPlayUrl ? typeof pf.playUrl : '-'));

            const rc = config && config.requestConfig;
            if (rc && typeof rc.reqHttpPlayUrlInfo === 'function') {
              const o = rc.reqHttpPlayUrlInfo;
              rc.reqHttpPlayUrlInfo = function (...args) {
                window.__PLUMA_HITS__ += 1;
                log('★ reqHttpPlayUrlInfo 被调用 #' + window.__PLUMA_HITS__);
                return o.apply(this, args);
              };
              log('reqHttpPlayUrlInfo 已包装');
            } else {
              log('requestConfig.reqHttpPlayUrlInfo 不存在 keys=' + (rc ? Object.keys(rc).join(',') : 'none'));
            }

            if (dropPrefetch && hasPlayUrl) {
              delete pf.playUrl;
              log('★ 已删除 prefetch.playUrl');
            }
          } catch (e) {
            log('hook 内部异常: ' + e.message);
          }
          return orig.call(this, config);
        };
        log('createPlayer 已包装 (dropPrefetch=' + dropPrefetch + ')');
      },
    });
  } catch (e) {
    log('defineProperty(window.nano) 失败: ' + e.message);
  }
};

async function run(dropPrefetch) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.POC_HEADLESS === '1',
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
  });
  const ctx = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const playurlReqs = [];
  page.on('request', (r) => {
    if (/playurl|playview/i.test(r.url())) playurlReqs.push(r.url().slice(0, 140));
  });

  await page.addInitScript(INIT, dropPrefetch);

  const out = { target: TARGET, dropPrefetch };
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(20000);

    out.log = await page.evaluate(() => window.__PLUMA_LOG__ || []);
    out.hits = await page.evaluate(() => window.__PLUMA_HITS__ || 0);
    out.playurlReqs = playurlReqs;
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        video: v
          ? {
              h: v.videoHeight,
              w: v.videoWidth,
              t: Math.round(v.currentTime),
              paused: v.paused,
              src: (v.currentSrc || '').slice(0, 100),
            }
          : null,
        playinfoQuality: window.__playinfo__?.result?.video_info?.quality ?? null,
        hasPlayer: !!window.player,
      };
    });
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close();
  }
  return out;
}

(async () => {
  const keep = await run(false);
  const drop = await run(true);
  const result = {
    note: 'keep=保留 prefetch.playUrl（现状）；drop=删掉它（测回退到 reqHttpPlayUrlInfo）',
    keep,
    drop,
    verdict: {
      keepHits: keep.hits,
      dropHits: drop.hits,
      keepPlayed: (keep.state?.video?.h ?? 0) > 0,
      dropPlayed: (drop.state?.video?.h ?? 0) > 0,
    },
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result.verdict, null, 2));
  console.log('--- keep.log ---');
  console.log((keep.log || []).map((x) => `${x.t}ms ${x.m}`).join('\n'));
  console.log('--- drop.log ---');
  console.log((drop.log || []).map((x) => `${x.t}ms ${x.m}`).join('\n'));
  console.log('--- drop.playurlReqs ---');
  console.log((drop.playurlReqs || []).join('\n') || '(none)');
})();
