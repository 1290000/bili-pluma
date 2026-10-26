// P1 第 6 步最终验收：打开真实视频页，看页面是否真的请求到了高画质
// 判据：B站页面自己的 playurl 响应里 dash.video 出现 height >= 2160
// 这不是我们自己 fetch 的结果，而是页面播放器拿到的结果
const { chromium } = require('playwright-core');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const OUT = path.join(__dirname, 'result-page-e2e.json');
const VIDEO = 'https://www.bilibili.com/video/BV1beNcz2ECq/?p=4';

(async () => {
  const ctx = await chromium.launchPersistentContext(path.resolve(__dirname, '../../.tmp/page-profile'), {
    channel: 'msedge',
    // POC_HEADLESS=1 时无窗口运行（CI / 无显示器环境）。默认 false 保持原行为。
    headless: process.env.POC_HEADLESS === '1',
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const report = { startedAt: new Date().toISOString() };

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });

    const has = await sw.evaluate(async () => {
      const a = await chrome.storage.local.get('pluma:vault:blob');
      return !!a['pluma:vault:blob'];
    });
    report.hasCredential = has;

    if (!has) {
      // 先登录
      const extId = new URL(sw.url()).host;
      const login = await ctx.newPage();
      await login.goto(`chrome-extension://${extId}/login-window.html`, { waitUntil: 'domcontentloaded' });
      await login.waitForFunction(() => !!document.querySelector('canvas.qr-canvas'), { timeout: 45000 });
      console.log('NEED_LOGIN');

      const deadline = Date.now() + 4 * 60 * 1000;
      let ok = false;
      while (Date.now() < deadline) {
        const txt = await login.evaluate(() => document.querySelector('.status')?.textContent ?? '');
        if (txt.includes('登录成功')) {
          ok = true;
          break;
        }
        if (txt.includes('失效')) await login.click('.refresh').catch(() => {});
        await login.waitForTimeout(2000);
      }
      report.loginSuccess = ok;
      await login.close().catch(() => {});
      if (!ok) throw new Error('登录未完成');
    }

    // 打开真实视频页，抓页面自己的 playurl 响应
    const page = await ctx.newPage();
    const playurls = [];

    page.on('response', async (res) => {
      const u = new URL(res.url());
      if (!u.pathname.includes('/x/player/wbi/playurl')) return;
      try {
        const b = await res.json();
        const d = b?.data ?? {};
        const hs = (d.dash?.video ?? []).map((v) => v.height);
        playurls.push({
          t: Date.now(),
          code: b.code,
          maxHeight: hs.length ? Math.max(...hs) : null,
          trackCount: hs.length,
          hasFlac: !!d.dash?.flac?.audio,
          hasDolby: !!(d.dash?.dolby?.audio?.length),
        });
      } catch {
        playurls.push({ parseError: true });
      }
    });

    await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);

    report.pagePlayurls = playurls;
    report.actualVideo = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { h: v.videoHeight, w: v.videoWidth, paused: v.paused } : null;
    });
    report.currentQualities = await page.evaluate(() =>
      [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')].map((e) =>
        (e.textContent || '').trim().replace(/\s+/g, ' '),
      ),
    );
    report.activeQuality = await page.evaluate(
      () => document.querySelector('.bpx-player-ctrl-quality-result')?.textContent?.trim() ?? null,
    );

    // 标签页规则是否装上
    report.tabRules = await sw.evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      return rules
        .filter((r) => r.id >= 20000)
        .map((r) => ({ id: r.id, tabIds: r.condition.tabIds ?? null, filter: r.condition.urlFilter }));
    });
  } catch (e) {
    report.error = e.message;
  } finally {
    await ctx.close().catch(() => {});
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 1));
    process.exit(0);
  }
})();
