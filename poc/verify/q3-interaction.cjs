// Q3 交互验证：切画质 / 拖进度 / 切P 是否触发新的 playurl
// 同时 dump 完整 dash 轨道，用于判断"accept_quality 是否可信"
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const BASE = 'https://www.bilibili.com/video/BV1beNcz2ECq/';
const OUT = path.join(__dirname, 'result-q3.json');

const PLAYURL_RE = /\/x\/player\/.*playurl|\/pgc\/player\/.*playurl|\/ogv\/player\/playview/i;

const events = [];
let mark = 'init';

function now() {
  return Date.now();
}

function tracksOf(dash) {
  if (!dash) return [];
  return (dash.video || []).map((v) => ({
    id: v.id,
    h: v.height,
    w: v.width,
    codecid: v.codecid,
    fr: v.frameRate,
    bw: Math.round((v.bandwidth || 0) / 1000),
  }));
}

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    // POC_HEADLESS=1 时无窗口运行（CI / 无显示器环境）。默认 false 保持原行为。
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

  page.on('request', (r) => {
    if (!PLAYURL_RE.test(r.url())) return;
    const u = new URL(r.url());
    events.push({
      t: now(),
      mark,
      type: 'req',
      path: u.pathname,
      qn: u.searchParams.get('qn'),
      fnval: u.searchParams.get('fnval'),
      fullUrl: r.url(),
    });
  });

  page.on('response', async (r) => {
    if (!PLAYURL_RE.test(r.url())) return;
    try {
      const b = await r.json();
      const d = b.data ?? b.result ?? {};
      events.push({
        t: now(),
        mark,
        type: 'resp',
        path: new URL(r.url()).pathname,
        code: b.code,
        accept_quality: d.accept_quality ?? null,
        tracks: tracksOf(d.dash),
        hasFlac: !!d.dash?.flac?.audio,
        hasDolby: !!(d.dash?.dolby?.audio?.length),
      });
    } catch (e) {
      events.push({ t: now(), mark, type: 'resp-err', path: new URL(r.url()).pathname });
    }
  });

  const out = { steps: [], domProbe: null, events };

  try {
    mark = 'load';
    await page.goto(BASE + '?p=4', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(9000);

    out.domProbe = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        return el ? { sel, cls: el.className, text: el.textContent?.trim().slice(0, 30) } : null;
      };
      return {
        qualityBtn: pick('.bpx-player-ctrl-quality') || pick('.bilibili-player-video-btn-quality'),
        qualityResult: pick('.bpx-player-ctrl-quality-result'),
        video: (() => {
          const v = document.querySelector('video');
          return v ? { paused: v.paused, duration: Math.round(v.duration), currentTime: Math.round(v.currentTime) } : null;
        })(),
        qualityMenuItems: [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')].map((e) => ({
          cls: e.className,
          text: e.textContent?.trim().slice(0, 20),
        })),
      };
    });

    // 1) 静置 30 秒，看是否周期性刷新
    mark = 'idle-30s';
    await page.waitForTimeout(30000);
    out.steps.push({ step: '静置 30 秒', playurlReqs: events.filter((e) => e.type === 'req' && e.mark === 'idle-30s').length });

    // 2) 切画质：点开菜单 → 选第一个非当前项
    mark = 'switch-quality';
    try {
      await page.click('.bpx-player-ctrl-quality', { timeout: 5000 });
      await page.waitForTimeout(800);
      const items = await page.$$('.bpx-player-ctrl-quality-menu-item');
      out.steps.push({ step: '打开画质菜单', menuItemCount: items.length });
      if (items.length >= 2) {
        await items[1].click();
        await page.waitForTimeout(6000);
      }
    } catch (e) {
      out.steps.push({ step: '切画质', error: e.message });
    }
    out.steps.push({ step: '切画质后', playurlReqs: events.filter((e) => e.type === 'req' && e.mark === 'switch-quality').length });

    // 3) 拖进度
    mark = 'seek';
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) v.currentTime = Math.min(v.duration * 0.6, 300);
    });
    await page.waitForTimeout(6000);
    out.steps.push({ step: '拖进度到 60%', playurlReqs: events.filter((e) => e.type === 'req' && e.mark === 'seek').length });

    // 4) 切 P（同一视频多P）
    mark = 'switch-p';
    await page.goto(BASE + '?p=5', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    out.steps.push({ step: '切到 P5', playurlReqs: events.filter((e) => e.type === 'req' && e.mark === 'switch-p').length });
  } catch (e) {
    out.error = e.message;
  } finally {
    writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    await browser.close();
    console.log('done ->', OUT);
  }
})();
