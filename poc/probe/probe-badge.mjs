/**
 * 实测角标判定 —— 用真实浏览器抓真实 playurl 响应，
 * 把真实轨道数据喂进 buildBadge，看它到底输出什么。
 *
 * 不依赖登录态：即使拿不到会员轨道，"角标判定逻辑对不对"也能验证，
 * 因为判定只依赖 (height, codec, videoDynamicRange, dolbyVision, frameRate)。
 */
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const VIDEOS = [
  { p: 1, url: 'https://www.bilibili.com/video/BV1beNcz2ECq/' },
  { p: 2, url: 'https://www.bilibili.com/video/BV1beNcz2ECq/?p=2' },
  { p: 3, url: 'https://www.bilibili.com/video/BV1beNcz2ECq/?p=3' },
  { p: 4, url: 'https://www.bilibili.com/video/BV1beNcz2ECq/?p=4' },
];

const CHROME = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check'],
});

const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const results = [];

for (const v of VIDEOS) {
  const page = await ctx.newPage();
  const playurls = [];

  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/\/x\/player\/(wbi\/)?playurl/.test(u)) return;
    try {
      const j = await resp.json();
      playurls.push({ url: u.split('?')[0], data: j });
    } catch {}
  });

  try {
    await page.goto(v.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(12000);

    // 抓页面真实状态
    const state = await page.evaluate(() => {
      const video = document.querySelector('video');
      return {
        videoHeight: video?.videoHeight ?? 0,
        videoWidth: video?.videoWidth ?? 0,
        displayRange: window.matchMedia('(dynamic-range: high)').matches,
        videoRange: window.matchMedia('(video-dynamic-range: high)').matches,
        hasInitialState: typeof window.__INITIAL_STATE__ !== 'undefined',
      };
    });

    for (const pu of playurls) {
      const dash = pu.data?.data?.dash;
      if (!dash) {
        results.push({ p: v.p, note: '无 dash（可能未登录/番剧）', ...state });
        continue;
      }
      const tracks = (dash.video || []).map((t) => ({
        id: t.id, h: t.height, codecid: t.codecid,
        fps: parseFloat(t.frame_rate || '0'),
        bw: t.bandwidth,
      }));
      results.push({
        p: v.p,
        ...state,
        dolbyVision: !!dash.dolby?.vision,
        dolbyAudio: (dash.dolby?.audio || []).length > 0,
        flac: !!dash.flac?.audio,
        tracks,
      });
    }
  } catch (e) {
    results.push({ p: v.p, error: String(e).slice(0, 120) });
  }
  await page.close();
}

writeFileSync('probe-result.json', JSON.stringify(results, null, 2), 'utf-8');

for (const r of results) {
  console.log(`\n=== P${r.p} ===`);
  console.log(`  播放 ${r.videoHeight}p  编码窗口: display=${r.displayRange} video=${r.videoRange}`);
  if (r.dolbyVision !== undefined) {
    console.log(`  dolby.vision=${r.dolbyVision}  dolby.audio=${r.dolbyAudio}  flac=${r.flac}`);
    const ids = [...new Set((r.tracks || []).map((t) => `${t.id}/${t.h}p/cc${t.codecid}/${t.fps}fps`))];
    console.log(`  轨道: ${ids.join(' | ') || '无'}`);
  }
  if (r.error) console.log(`  错误: ${r.error}`);
}

await browser.close();
