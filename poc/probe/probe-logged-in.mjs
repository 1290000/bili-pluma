/**
 * 用**日常 Chrome profile** 实测 4 个分 P 的真实轨道数据。
 *
 * ⚠️ 前置：Chrome 必须完全退出（profile 被占用会启动失败）。
 * ⚠️ 本脚本只读页面响应与 DOM 状态，**不读取 cookie 内容、不写 profile**。
 */
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VIDEOS = [
  { p: 1, url: 'https://www.bilibili.com/video/BV1beNcz2ECq/' },
  { p: 2, url: 'https://www.bilibili.com/video/BV1beNcz2ECq/?p=2' },
  { p: 3, url: 'https://www.bilibili.com/video/BV1beNcz2ECq/?p=3' },
  { p: 4, url: 'https://www.bilibili.com/video/BV1beNcz2ECq/?p=4' },
];

const CHROME = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA = join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: ['--profile-directory=Default', '--no-first-run', '--no-default-browser-check'],
});

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
    await page.waitForTimeout(15000);

    const state = await page.evaluate(() => {
      const video = document.querySelector('video');
      return {
        playingHeight: video?.videoHeight ?? 0,
        playingWidth: video?.videoWidth ?? 0,
        displayRange: window.matchMedia('(dynamic-range: high)').matches,
        videoRange: window.matchMedia('(video-dynamic-range: high)').matches,
        p: new URLSearchParams(location.search).get('p') || '1',
      };
    });

    // 取最后一次 playurl（切 P 后补发的那次更准）
    const last = playurls[playurls.length - 1];
    const dash = last?.data?.dash;

    results.push({
      p: v.p,
      ...state,
      loggedIn: !!last?.data,
      dolbyVision: !!dash?.dolby?.vision,
      dolbyAudio: (dash?.dolby?.audio || []).length > 0,
      flac: !!dash?.flac?.audio,
      tracks: (dash?.video || []).map((t) => ({
        id: t.id, h: t.height, codecid: t.codecid,
        fps: parseFloat(t.frame_rate || '0'),
      })),
      audioTracks: (dash?.audio || []).map((a) => ({ id: a.id, bw: a.bandwidth })),
    });
  } catch (e) {
    results.push({ p: v.p, error: String(e).slice(0, 150) });
  }
  await page.close();
}

writeFileSync('probe-logged-in.json', JSON.stringify(results, null, 2), 'utf-8');

for (const r of results) {
  console.log(`\n=== P${r.p} ===`);
  if (r.error) { console.log(`  错误: ${r.error}`); continue; }
  console.log(`  实际播放 ${r.playingWidth}x${r.playingHeight}`);
  console.log(`  matchMedia: display=${r.displayRange}  video=${r.videoRange}`);
  console.log(`  dolby.vision=${r.dolbyVision}  dolby.audio=${r.dolbyAudio}  flac=${r.flac}`);
  const vids = [...new Set((r.tracks || []).map((t) => `${t.id}:${t.h}p/cc${t.codecid}/${t.fps}fps`))];
  console.log(`  视频轨(${r.tracks?.length ?? 0}): ${vids.join(' | ') || '无'}`);
  const aud = (r.audioTracks || []).map((a) => `${a.id}@${Math.round(a.bw / 1000)}k`);
  console.log(`  音频轨: ${aud.join(',') || '无'}`);
}

await ctx.close();
