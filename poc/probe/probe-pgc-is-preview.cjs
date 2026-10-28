// 对照：如果 SSR 数据本身就是"完整集"（模拟播放账号身份），播放器会不会播满时长？
//
// 目的：区分两种可能 ——
//   A. 播放器按 `is_preview` / `play_check` 自己截断（那我们换流也没用，必须改字段）
//   B. 播放器只是吃了我们给的 durl（那我们只要把完整流给对就行）
//
// 做法：把 `__playinfo__` 的 `video_info.is_preview` 改成 false 再交给播放器，
//   其余完全不动，看 `video.duration` 是否从 360 变成 1440。
//
//   POC_HEADLESS=1 node poc/probe/probe-pgc-is-preview.cjs
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET = process.env.POC_TARGET || 'https://www.bilibili.com/bangumi/play/ss34412';
const OUT = path.join(__dirname, 'result-pgc-is-preview.json');

/** @param {boolean} patch 是否把 is_preview/play_check 改成"完整" */
const INIT = (patch) => {
  window.__L__ = [];
  const L = (m, e) => window.__L__.push({ m, ...(e || {}) });

  // 在 __playinfo__ 赋值之后、createPlayer 之前改（用 nano setter 保证时机）
  let nanoRef;
  Object.defineProperty(window, 'nano', {
    configurable: true,
    enumerable: true,
    get() {
      return nanoRef;
    },
    set(v) {
      nanoRef = v;
      if (!v || typeof v.createPlayer !== 'function' || v.__wrapped) return;
      v.__wrapped = true;
      const orig = v.createPlayer;
      v.createPlayer = function (config) {
        if (patch) {
          const r = window.__playinfo__ && window.__playinfo__.result;
          if (r) {
            if (r.video_info) r.video_info.is_preview = false;
            if (r.play_check) r.play_check.play_detail = 'PLAY_WHOLE';
            if (r.play_video_type) r.play_video_type = 'whole';
            L('patched', {
              type: r.play_video_type,
              isPreview: r.video_info && r.video_info.is_preview,
              durlMs: r.video_info && r.video_info.durls && r.video_info.durls[0].durl[0].length,
            });
          }
        }
        return orig.apply(this, arguments);
      };
    },
  });
};

async function run(patch) {
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
  await page.addInitScript(INIT, patch);

  const out = { patch };
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
    await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (v) {
          v.muted = true;
          void v.play().catch(() => {});
        }
      })
      .catch(() => {});
    await page.waitForTimeout(6000);
    out.log = await page.evaluate(() => window.__L__ || []);
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        dur: Math.round(v?.duration ?? 0),
        h: v?.videoHeight ?? 0,
        t: Math.round(v?.currentTime ?? 0),
        err: v?.error?.code ?? null,
      };
    });
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close();
  }
  return out;
}

(async () => {
  const baseline = await run(false);
  const patched = await run(true);
  const result = {
    baseline: baseline.state,
    patched: patched.state,
    patchedLog: patched.log,
    verdict: {
      baselineDur: baseline.state && baseline.state.dur,
      patchedDur: patched.state && patched.state.dur,
      // 若 patchedDur > baselineDur，说明播放器会按 is_preview 截断 → 必须改字段
      durChanged: !!(baseline.state && patched.state && baseline.state.dur !== patched.state.dur),
    },
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 1));
})();
