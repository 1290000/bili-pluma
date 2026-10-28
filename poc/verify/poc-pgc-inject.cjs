// PoC：端到端验证「异步取流注入」机制本身能否让播放器正常播。
//
// 验证的是**机制**，不是权益：
//   1. hook window.nano → 包住 createPlayer
//   2. 删掉 config.prefetch.playUrl（逼播放器走异步回调）
//   3. 把 requestConfig.reqHttpPlayUrlInfo 换成「自己 fetch /pgc/player/web/playurl」
//   4. 把响应包成 { status: 200, data: <json> } 交给播放器
//
// 只要视频能播、且时长/高度来自我们 fetch 的数据，就说明：
//   - 形状包对了（`data` 那一层不能少）
//   - 播放器接受异步回调返回的数据
//   - dash（番剧）与 durl（电影）两条消费路径都能走通
//
// 不需要登录态：用游客也能完整播放的免费番剧 / 试看电影即可。
//
//   POC_HEADLESS=1 node poc/verify/poc-pgc-inject.cjs
//   POC_TARGET=https://www.bilibili.com/bangumi/play/ss48001 POC_HEADLESS=1 node poc/verify/poc-pgc-inject.cjs
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET = process.env.POC_TARGET || 'https://www.bilibili.com/bangumi/play/ss47836';
const OUT = path.join(__dirname, 'result-pgc-inject.json');

const INIT = () => {
  window.__PLUMA_LOG__ = [];
  const log = (m) => window.__PLUMA_LOG__.push({ t: Math.round(performance.now()), m });
  window.__PLUMA_FETCH__ = null;

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
        if (!v || typeof v.createPlayer !== 'function') return;
        const orig = v.createPlayer;

        v.createPlayer = function (config) {
          try {
            const r0 = window.__playinfo__?.result;
            const cid = r0?.arc?.cid ?? r0?.video_info?.cid;
            log('createPlayer: cid=' + cid + ' prefetch.playUrl=' + !!(config?.prefetch?.playUrl));

            const rc = config?.requestConfig;
            if (!rc || typeof rc.reqHttpPlayUrlInfo !== 'function') {
              log('没有 requestConfig.reqHttpPlayUrlInfo，无法接管');
              return orig.call(this, config);
            }

            const origCb = rc.reqHttpPlayUrlInfo;
            delete config.prefetch.playUrl;
            log('已删除 prefetch.playUrl');

            rc.reqHttpPlayUrlInfo = async function () {
              const url =
                'https://api.bilibili.com/pgc/player/web/playurl' +
                `?cid=${cid}&avid=0&qn=80&fnval=4048&fnver=0&fourk=1`;
              try {
                const t0 = performance.now();
                const r = await fetch(url, { credentials: 'include' });
                const j = await r.json();
                window.__PLUMA_FETCH__ = {
                  http: r.status,
                  code: j.code,
                  ms: Math.round(performance.now() - t0),
                  resultKeys: Object.keys(j.result ?? {}),
                  hasDash: !!j.result?.dash,
                  dashHeights: (j.result?.dash?.video ?? []).map((x) => x.height),
                  durlGroups: (j.result?.durls ?? []).length,
                  timelength: j.result?.timelength ?? null,
                };
                log('★ 自取流 code=' + j.code + ' dash=' + !!j.result?.dash);
                if (j?.code !== 0 || !j.result) throw new Error('code=' + j?.code);

                /**
                 * ⚠️ **接口与 SSR 的 result 结构不同**，不能直接替换（实测：直接替换 → 黑屏、
                 * `video.readyState=0`、连 src 都不设）。
                 *
                 *   接口（扁平）：{ dash, durls, quality, timelength, accept_quality, … }
                 *   SSR（嵌套）：{ arc, play_check, play_video_type, watch_progress,
                 *                  video_info: { dash?, durl, durls, quality, timelength, … } }
                 *
                 * 播放器读的是 **SSR 形状**，所以要以 SSR 为骨架，只把流字段搬进 video_info。
                 */
                const ssr = window.__playinfo__;
                const base = ssr?.data ?? { code: 0, message: '0', ttl: 1, result: {} };
                const ssrResult = base.result ?? {};
                const vi = ssrResult.video_info ?? {};
                const api = j.result;

                const merged = {
                  ...base,
                  data: {
                    ...base.data,
                    code: 0,
                    result: {
                      ...ssrResult,
                      video_info: {
                        ...vi,
                        quality: api.quality ?? vi.quality,
                        timelength: api.timelength ?? vi.timelength,
                        format: api.format ?? vi.format,
                        // 流：有 dash 用 dash，否则用 durl 组
                        dash: api.dash ?? vi.dash,
                        durl: api.durl ?? api.durls?.[0]?.durl ?? vi.durl,
                        durls: api.durls ?? vi.durls,
                        accept_quality: api.accept_quality ?? vi.accept_quality,
                        accept_description: api.accept_description ?? vi.accept_description,
                        support_formats: api.support_formats ?? vi.support_formats,
                        is_preview: api.is_preview ?? false,
                      },
                      accept_quality: api.accept_quality ?? ssrResult.accept_quality,
                      accept_description: api.accept_description ?? ssrResult.accept_description,
                    },
                  },
                };
                window.__PLUMA_MERGED__ = {
                  hasDash: !!merged.data.result.video_info.dash,
                  durlGroups: (merged.data.result.video_info.durls ?? []).length,
                  timelength: merged.data.result.video_info.timelength,
                };
                log('已合并流字段到 SSR 骨架');
                return merged;
              } catch (e) {
                log('自取流失败，降级到 SSR: ' + e.message);
                return origCb();
              }
            };
            log('reqHttpPlayUrlInfo 已替换');
          } catch (e) {
            log('hook 异常: ' + e.message);
          }
          return orig.call(this, config);
        };
      },
    });
  } catch (e) {
    log('defineProperty(window.nano) 失败: ' + e.message);
  }
};

(async () => {
  // 看门狗：任何一步挂死都别让脚本无限跑（第一次踩过 5 分钟不返回）
  const watchdog = setTimeout(() => {
    writeFileSync(OUT, JSON.stringify({ error: 'watchdog timeout 90s' }, null, 2), 'utf8');
    console.error('watchdog: 90s 未完成，强制退出');
    process.exit(2);
  }, 90_000);
  watchdog.unref?.();

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
    // 等自取流 + 播放器装载
    await page.waitForTimeout(15000);
    // 触发一次播放。⚠️ **不能 await v.play()**：自动播放被拦时这个 Promise 永远不 settle，
    // 整个 evaluate 会挂死（第一次跑就这么挂了 5 分钟）。
    await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return;
        v.muted = true;
        void v.play().catch(() => {});
      })
      .catch(() => {});
    await page.waitForTimeout(8000);

    out.log = await page.evaluate(() => window.__PLUMA_LOG__ || []);
    out.fetchResult = await page.evaluate(() => window.__PLUMA_FETCH__);
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        t: Math.round(v?.currentTime ?? 0),
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
        paused: v?.paused ?? null,
        readyState: v?.readyState ?? null,
        err: v?.error?.code ?? null,
        src: (v?.currentSrc ?? '').slice(0, 60),
      };
    });
  } catch (e) {
    out.error = e.message;
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
  }

  out.verdict = {
    injected: !!out.fetchResult && out.fetchResult.code === 0,
    played: (out.state?.t ?? 0) > 0 && (out.state?.h ?? 0) > 0,
    height: out.state?.h ?? 0,
    duration: out.state?.dur ?? 0,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({ verdict: out.verdict, fetch: out.fetchResult, state: out.state }, null, 2));
  console.log('--- log ---');
  console.log((out.log || []).map((x) => `${x.t}ms ${x.m}`).join('\n'));
  if (out.error) console.log('ERROR: ' + out.error);
})();
