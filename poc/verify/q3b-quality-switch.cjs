// Q3 补测：只切「未登录可用」的档位（480P / 360P），确认切画质是否真的不发 playurl
const { chromium } = require('playwright');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const BASE = 'https://www.bilibili.com/video/BV1beNcz2ECq/?p=4';
const OUT = path.join(__dirname, 'result-q3b.json');
const PLAYURL_RE = /\/x\/player\/.*playurl|\/pgc\/player\/.*playurl/i;

const log = [];
let mark = 'init';

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
  });
  const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on('request', (r) => {
    if (!PLAYURL_RE.test(r.url())) return;
    const u = new URL(r.url());
    log.push({ mark, path: u.pathname, qn: u.searchParams.get('qn'), fnval: u.searchParams.get('fnval') });
  });

  const steps = [];

  async function pickQuality(labelPart) {
    await page.click('.bpx-player-ctrl-quality', { timeout: 5000 });
    await page.waitForTimeout(600);
    const items = await page.$$('.bpx-player-ctrl-quality-menu-item');
    for (const it of items) {
      const txt = (await it.textContent()) || '';
      if (txt.includes(labelPart)) {
        await it.click();
        return txt.trim().replace(/\s+/g, ' ');
      }
    }
    return null;
  }

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(9000);

    const before = log.length;
    steps.push({ step: '初次加载完成', playurlCount: before });

    mark = 'to480';
    const picked1 = await pickQuality('480P');
    await page.waitForTimeout(6000);
    steps.push({ step: '切到 480P', picked: picked1, newPlayurl: log.filter((l) => l.mark === 'to480').length });

    mark = 'to360';
    const picked2 = await pickQuality('360P');
    await page.waitForTimeout(6000);
    steps.push({ step: '切到 360P', picked: picked2, newPlayurl: log.filter((l) => l.mark === 'to360').length });

    mark = 'to480b';
    const picked3 = await pickQuality('480P');
    await page.waitForTimeout(6000);
    steps.push({ step: '再切回 480P', picked: picked3, newPlayurl: log.filter((l) => l.mark === 'to480b').length });

    // 当前实际播放分辨率
    steps.push({
      step: '当前播放状态',
      state: await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { h: v.videoHeight, w: v.videoWidth, t: Math.round(v.currentTime), paused: v.paused } : null;
      }),
    });
  } catch (e) {
    steps.push({ step: 'ERROR', error: e.message });
  } finally {
    writeFileSync(OUT, JSON.stringify({ steps, log }, null, 2), 'utf8');
    await browser.close();
    console.log(JSON.stringify(steps, null, 1));
  }
})();
