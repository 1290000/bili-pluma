// 逐个验证三个分P + 8K 的轨道属性
// 重点：dash.video 里的 HDR / 杜比视界字段，以及 qn 与 hdr 参数
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const PROFILE = path.resolve(__dirname, '../../.tmp/page-profile');
const OUT = path.join(__dirname, 'result-hdr-check.json');

const BASE = 'https://www.bilibili.com/video/BV1beNcz2ECq/';
const TARGETS = [
  { label: 'P1', url: BASE },
  { label: 'P2', url: `${BASE}?p=2` },
  { label: 'P3', url: `${BASE}?p=3` },
  { label: 'P4(8K目标)', url: `${BASE}?p=4` },
];

function summarizeDash(d) {
  const v = d?.dash?.video ?? [];
  return {
    count: v.length,
    maxHeight: v.length ? Math.max(...v.map((x) => x.height)) : null,
    // 逐条列出所有轨道的关键属性，用于判断 HDR / 杜比视界
    tracks: v.map((x) => ({
      id: x.id,
      h: x.height,
      w: x.width,
      codecid: x.codecid,
      fr: x.frameRate,
      // 这些字段是判断 HDR 的依据
      hdrType: x.hdr_type ?? null,
      // B站把 HDR / 杜比视界信息放在 dash.dolby 和 dash.video 的扩展字段里
      colorPrimaries: x.color_primaries ?? null,
      colorTransfer: x.color_transfer ?? null,
      colorSpace: x.color_space ?? null,
      // 音轨
    })),
    flac: !!d?.dash?.flac?.audio,
    dolbyAudio: (d?.dash?.dolby?.audio ?? []).length,
    dolbyVision: (d?.dash?.dolby?.vision ?? []).length,
    dolbyVisionTracks: (d?.dash?.dolby?.vision ?? []).map((x) => ({ id: x.id, h: x.height, codecid: x.codecid })),
    supportFormats: (d?.support_formats ?? []).map((f) => ({
      quality: f.quality,
      desc: f.new_description || f.description,
      codecs: f.codecs,
      needVip: f.need_vip,
      attribute: f.attribute,
    })),
  };
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const report = { targets: [] };

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });

    const has = await sw.evaluate(async () => {
      const a = await chrome.storage.local.get('pluma:vault:blob');
      return !!a['pluma:vault:blob'];
    });
    report.hasCredential = has;
    if (!has) throw new Error('无凭据，需要先扫码登录');

    for (const t of TARGETS) {
      const page = await ctx.newPage();
      const captured = [];

      page.on('response', async (res) => {
        if (!new URL(res.url()).pathname.includes('/x/player/wbi/playurl')) return;
        try {
          const b = await res.json();
          captured.push({ code: b.code, ...summarizeDash(b.data ?? {}) });
        } catch {
          /* ignore */
        }
      });

      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(12000);

      const state = await page.evaluate(() => {
        const v = document.querySelector('video');
        return {
          title: document.title.slice(0, 60),
          video: v ? { h: v.videoHeight, w: v.videoWidth } : null,
          activeQuality: document.querySelector('.bpx-player-ctrl-quality-result')?.textContent?.trim() ?? null,
          qualities: [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')].map((e) =>
            (e.textContent || '').trim().replace(/\s+/g, ' '),
          ),
        };
      });

      report.targets.push({ label: t.label, url: t.url, state, playurls: captured });
      await page.close();
    }
  } catch (e) {
    report.error = e.message;
  } finally {
    await ctx.close().catch(() => {});
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log('done ->', OUT);
    process.exit(0);
  }
})();
