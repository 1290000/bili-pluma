// 验证：能否通过 hook window.__playinfo__ 的 setter，
// 原地修改 SSR 数据对象（durl / durls 的 url），并让播放器真的去请求改后的地址。
// 用假 URL 指向本地 echo，只要 echo 收到请求，就说明注入点有效。
const { chromium } = require('playwright-core');
const http = require('node:http');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const BANGUMI = 'https://www.bilibili.com/bangumi/play/ep3854821';
const ECHO_PORT = 8799;
const FAKE_URL = `http://127.0.0.1:${ECHO_PORT}/pluma-fake.m4s`;
const OUT = path.join(__dirname, 'result-hook-playinfo.json');

const hits = [];

const echo = http.createServer((req, res) => {
  hits.push({ t: Date.now(), url: req.url });
  res.writeHead(200, { 'content-type': 'video/mp4', 'access-control-allow-origin': '*' });
  res.end(Buffer.alloc(0));
});

const INIT = (fakeUrl) => {
  window.__PLUMA_LOG__ = [];
  const log = (m) => window.__PLUMA_LOG__.push({ t: Math.round(performance.now()), m });

  let real;
  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      enumerable: true,
      get() {
        return real;
      },
      set(v) {
        log('__playinfo__ 被赋值, top keys=' + (v && typeof v === 'object' ? Object.keys(v).join(',') : String(v)));
        try {
          const r = v && v.result;
          const vi = r && r.video_info;
          if (vi) {
            log(
              '  quality=' + vi.quality +
                ' is_preview=' + vi.is_preview +
                ' durl=' + (vi.durl || []).length +
                ' durls=' + (vi.durls || []).length +
                ' timelength=' + vi.timelength,
            );
            if (vi.durl && vi.durl[0]) {
              vi.durl[0].url = fakeUrl;
              vi.durl[0].backup_url = [];
              log('  ★ 已改 durl[0].url → ' + fakeUrl);
            }
            if (Array.isArray(vi.durls)) {
              let n = 0;
              for (const g of vi.durls) {
                if (g && Array.isArray(g.durl) && g.durl[0]) {
                  g.durl[0].url = fakeUrl;
                  g.durl[0].backup_url = [];
                  n += 1;
                }
              }
              log('  ★ 已改 durls[' + n + '].durl[0].url → ' + fakeUrl);
            }
          } else {
            log('  result.video_info 不存在, result keys=' + (r ? Object.keys(r).join(',') : 'none'));
          }
        } catch (e) {
          log('  修改失败: ' + e.message);
        }
        real = v;
      },
    });
    log('defineProperty(window.__playinfo__) 成功');
  } catch (e) {
    log('defineProperty 失败: ' + e.message);
  }
};

(async () => {
  await new Promise((r) => echo.listen(ECHO_PORT, '127.0.0.1', r));

  const browser = await chromium.launch({
    channel: 'chrome',
    // POC_HEADLESS=1 时无窗口运行（CI / 无显示器环境）。默认 false 保持原行为。
    headless: process.env.POC_HEADLESS === '1',
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
  });
  const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(INIT, FAKE_URL);

  const out = {};
  try {
    await page.goto(BANGUMI, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(18000);

    out.log = await page.evaluate(() => window.__PLUMA_LOG__ || []);
    out.echoHits = hits;
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      const pi = window.__playinfo__;
      return {
        video: v ? { h: v.videoHeight, w: v.videoWidth, t: Math.round(v.currentTime), paused: v.paused, src: (v.currentSrc || '').slice(0, 120) } : null,
        currentDurl: pi?.result?.video_info?.durl?.[0]?.url?.slice(0, 120) ?? null,
        playerError: (() => {
          const e = document.querySelector('.bpx-player-error, .bilibili-player-error');
          return e ? e.textContent?.trim().slice(0, 100) : null;
        })(),
      };
    });
  } catch (e) {
    out.error = e.message;
  } finally {
    writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    await browser.close();
    echo.close();
    console.log(JSON.stringify({ log: out.log, echoHitCount: hits.length, echoHits: hits.slice(0, 5), state: out.state, error: out.error }, null, 1));
  }
})();
