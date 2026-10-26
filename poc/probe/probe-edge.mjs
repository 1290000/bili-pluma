/**
 * 用**日常 Edge profile** 实测 4 个分 P 的真实轨道与角标输入。
 *
 * 前置：Edge 主程序已退出（webview2 无所谓）。
 * 只读页面响应与 DOM 状态，不读 cookie 内容、不写 profile。
 */
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const VIDEOS = [1, 2, 3, 4].map((p) => ({
  p,
  url: `https://www.bilibili.com/video/BV1beNcz2ECq/${p > 1 ? `?p=${p}` : ''}`,
}));

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Chrome 默认 profile（Chrome 允许在默认 profile 上开调试端口，Edge 不允许）
const USER_DATA = join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

/**
 * 启动前先确认 Edge 退干净。
 *
 * profile 被占用时 launchPersistentContext 只抛一句
 * "Target page, context or browser has been closed"，加一长串 call log，
 * 完全看不出是"浏览器还开着"。提前探测能给出直接结论。
 */
function edgeRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
      encoding: 'latin1',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toLowerCase().includes('chrome.exe');
  } catch {
    return false;
  }
}

if (edgeRunning()) {
  console.error('\n❌ Chrome 仍在运行，profile 被占用。请完全退出 Chrome 后再跑。\n');
  process.exit(1);
}
console.log('✅ Chrome 已退出，启动受控实例…\n');

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    // ⚠️ Playwright 默认会加 --disable-extensions。
    // 本次要测的是扩展注入的角标，必须显式关掉这个默认行为。
    '--disable-extensions-except=',
  ],
  /**
   * ⚠️ 必须移除 Playwright 默认的 `--force-color-profile=srgb`。
   *
   * 它把渲染强制成 sRGB，于是：
   *   - `matchMedia('(dynamic-range: high)')` 恒为 false
   *   - B站播放器探测到"显示链路不支持 HDR"，**画质菜单里就不提供 HDR / 杜比视界**
   *   - `dash` 里也不下发对应轨道（`dolby.vision` 恒为 false）
   *
   * 这解释了"用户环境有 HDR 选项，实测环境没有"的差异。
   */
  ignoreDefaultArgs: ['--disable-extensions', '--force-color-profile'],
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
        playingWidth: video?.videoWidth ?? 0,
        playingHeight: video?.videoHeight ?? 0,
        displayRange: window.matchMedia('(dynamic-range: high)').matches,
        videoRange: window.matchMedia('(video-dynamic-range: high)').matches,
        hasPluma: !!document.getElementById('pluma-badge-host'),
      };
    });

    const last = playurls[playurls.length - 1];
    const dash = last?.data?.dash;

    results.push({
      p: v.p,
      ...state,
      playurlCount: playurls.length,
      dolbyVision: !!dash?.dolby?.vision,
      dolbyAudio: (dash?.dolby?.audio || []).length > 0,
      flac: !!dash?.flac?.audio,
      tracks: (dash?.video || []).map((t) => ({
        id: t.id, h: t.height, codecid: t.codecid,
        fps: parseFloat(t.frame_rate || '0'),
      })),
    });
  } catch (e) {
    results.push({ p: v.p, error: String(e).slice(0, 150) });
  }
  await page.close();
}

writeFileSync('probe-chrome.json', JSON.stringify(results, null, 2), 'utf-8');

const ccName = (cc) => ({ 7: 'H264', 12: 'AV1', 13: 'HEVC' })[cc] || `cc${cc}`;

for (const r of results) {
  console.log(`\n=== P${r.p} ===`);
  if (r.error) { console.log(`  错误: ${r.error}`); continue; }
  console.log(`  实际播放 ${r.playingWidth}x${r.playingHeight}   角标注入=${r.hasPluma}`);
  console.log(`  matchMedia: display=${r.displayRange}  video=${r.videoRange}`);
  console.log(`  playurl 次数=${r.playurlCount}`);
  console.log(`  dolby.vision=${r.dolbyVision}  dolby.audio=${r.dolbyAudio}  flac=${r.flac}`);
  const uniq = [...new Set((r.tracks || []).map(
    (t) => `${t.id}:${t.h}p/${ccName(t.codecid)}/${t.fps}fps`,
  ))];
  console.log(`  视频轨(${r.tracks?.length ?? 0}): ${uniq.join(' | ') || '无'}`);
}

await ctx.close();
