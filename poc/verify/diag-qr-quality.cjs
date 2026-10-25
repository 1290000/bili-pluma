// 用代码检查 canvas 渲染质量：不是肉眼看图，而是量化验证
const { chromium } = require('playwright');
const path = require('node:path');
const os = require('node:os');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const USER_DATA = path.join(os.tmpdir(), 'pluma-qrcheck-' + Date.now());

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 420, height: 560 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
    ],
  });

  const out = {};
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/login-window.html`, { waitUntil: 'domcontentloaded' });

    // 等 canvas 出现（容忍冷启动）
    await page.waitForFunction(() => !!document.querySelector('canvas.qr-canvas'), { timeout: 45000 });
    await page.waitForTimeout(500);

    out.canvas = await page.evaluate(() => {
      const c = document.querySelector('canvas.qr-canvas');
      if (!c) return null;

      const ctx2d = c.getContext('2d');
      const { width, height } = c;
      const img = ctx2d.getImageData(0, 0, width, height).data;

      const px = (x, y) => {
        const i = (y * width + x) * 4;
        return { r: img[i], g: img[i + 1], b: img[i + 2], a: img[i + 3] };
      };

      let dark = 0;
      let light = 0;
      for (let i = 0; i < img.length; i += 4) {
        const r = img[i];
        if (r < 64) dark += 1;
        else if (r > 220) light += 1;
      }
      const total = width * height;

      // 四角颜色（应为白色静区）
      const corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)];

      // 中心区域应有深色模块
      const centerDark = (() => {
        let n = 0;
        for (let y = Math.floor(height / 2) - 10; y < Math.floor(height / 2) + 10; y += 1) {
          for (let x = Math.floor(width / 2) - 10; x < Math.floor(width / 2) + 10; x += 1) {
            if (px(x, y).r < 64) n += 1;
          }
        }
        return n;
      })();

      return {
        width,
        height,
        darkRatio: +(dark / total).toFixed(4),
        lightRatio: +(light / total).toFixed(4),
        cornersWhite: corners.every((c) => c.r > 220 && c.g > 220 && c.b > 220),
        centerDarkPixels: centerDark,
        cssSize: { w: c.clientWidth, h: c.clientHeight },
      };
    });

    out.texts = await page.evaluate(() => ({
      title: document.querySelector('.title')?.textContent ?? null,
      subtitle: document.querySelector('.subtitle')?.textContent ?? null,
      status: document.querySelector('.status')?.textContent ?? null,
      footnote: document.querySelector('.footnote')?.textContent ?? null,
    }));

    out.layout = await page.evaluate(() => {
      const card = document.querySelector('.qr-card');
      const cs = card ? getComputedStyle(card) : null;
      return {
        cardSize: card ? { w: card.clientWidth, h: card.clientHeight } : null,
        cardRadius: cs?.borderRadius ?? null,
        bodyFontSize: getComputedStyle(document.body).fontSize,
        hasScrollbar: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      };
    });
  } catch (e) {
    out.error = e.message;
  } finally {
    await ctx.close().catch(() => {});
    console.log(JSON.stringify(out, null, 1));
    process.exit(0);
  }
})();
