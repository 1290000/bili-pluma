/**
 * 通过 CDP 连接**用户正在运行的 Edge**，实测 4 个分 P。
 *
 * ## 两个必须注意的坑（都实际踩过）
 *
 * 1. **系统代理会拦 CDP**：环境里有 HTTP_PROXY=http://127.0.0.1:52263，
 *    Playwright 读它去连 127.0.0.1:9222，结果拿到 502。
 *    解决：启动 Node 前清空 proxy 环境变量（见调用方）。
 *
 * 2. **默认 profile 需要 --remote-allow-origins=***
 *    否则 WebSocket 握手被拒。
 */
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const VIDEOS = [1, 2, 3, 4].map((p) => ({
  p,
  url: `https://www.bilibili.com/video/BV1beNcz2ECq/${p > 1 ? `?p=${p}` : ''}`,
}));

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
console.log(`已连接 ${browser.version()}，当前标签页 ${ctx.pages().length} 个`);

const results = [];

for (const v of VIDEOS) {
  const page = await ctx.newPage();
  const playurls = [];

  page.on('response', async (resp) => {
    if (!/\/x\/player\/(wbi\/)?playurl/.test(resp.url())) return;
    try {
      playurls.push(await resp.json());
    } catch {}
  });

  try {
    await page.goto(v.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(16000);

    const state = await page.evaluate(() => {
      const video = document.querySelector('video');
      return {
        playingWidth: video?.videoWidth ?? 0,
        playingHeight: video?.videoHeight ?? 0,
        displayRange: window.matchMedia('(dynamic-range: high)').matches,
        videoRange: window.matchMedia('(video-dynamic-range: high)').matches,
        hasBadge: !!document.getElementById('pluma-badge-host'),
      };
    });

    const last = playurls[playurls.length - 1];
    const dash = last?.data?.dash;

    results.push({
      p: v.p,
      ...state,
      playurlCount: playurls.length,
      loggedIn: !!last?.data,
      dolbyVision: !!dash?.dolby?.vision,
      dolbyAudio: (dash?.dolby?.audio || []).length > 0,
      flac: !!dash?.flac?.audio,
      tracks: (dash?.video || []).map((t) => ({
        id: t.id, h: t.height, codecid: t.codecid,
        fps: parseFloat(t.frame_rate || '0'),
      })),
    });
  } catch (e) {
    results.push({ p: v.p, error: String(e).slice(0, 140) });
  }
  await page.close();
}

writeFileSync('probe-cdp.json', JSON.stringify(results, null, 2), 'utf-8');

const cc = (c) => ({ 7: 'H264', 12: 'AV1', 13: 'HEVC' })[c] || `cc${c}`;

for (const r of results) {
  console.log(`\n=== P${r.p} ===`);
  if (r.error) { console.log(`  错误: ${r.error}`); continue; }
  console.log(`  播放 ${r.playingWidth}x${r.playingHeight}  角标=${r.hasBadge}  playurl=${r.playurlCount}`);
  console.log(`  matchMedia: display=${r.displayRange}  video=${r.videoRange}`);
  console.log(`  dolby.vision=${r.dolbyVision}  dolby.audio=${r.dolbyAudio}  flac=${r.flac}`);
  const uniq = [...new Set((r.tracks || []).map((t) => `${t.id}:${t.h}p/${cc(t.codecid)}/${t.fps}fps`))];
  console.log(`  视频轨(${r.tracks?.length ?? 0}): ${uniq.slice(0, 9).join(' | ') || '无'}`);
}

await browser.close();
