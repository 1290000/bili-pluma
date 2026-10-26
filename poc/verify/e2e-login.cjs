// 端到端验证扫码登录：加载真实扩展 → 打开登录窗口 → 等用户扫码 → 检查凭据是否落库
// 安全：只检查凭据"是否存在"，不打印任何值；临时 profile，结束即销毁
const { chromium } = require('playwright-core');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const OUT = path.join(__dirname, 'result-e2e-login.json');
const SHOT_OK = path.join(__dirname, 'e2e-login-qr.png');
const SHOT_DONE = path.join(__dirname, 'e2e-login-success.png');
const USER_DATA = path.join(os.tmpdir(), 'pluma-e2e-' + Date.now());

(async () => {
  const report = { startedAt: new Date().toISOString(), steps: [] };

  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    console.log(JSON.stringify({ error: '未找到构建产物，先跑 wxt build' }));
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    channel: 'msedge',
    // POC_HEADLESS=1 时无窗口运行（CI / 无显示器环境）。默认 false 保持原行为。
    headless: process.env.POC_HEADLESS === '1',
    viewport: { width: 420, height: 620 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    report.extId = extId;
    report.steps.push('service worker 已启动');

    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

    await page.goto(`chrome-extension://${extId}/login-window.html`, { waitUntil: 'domcontentloaded' });
    report.steps.push('登录窗口已打开');

    // 等二维码画出来（canvas 有尺寸）
    await page.waitForFunction(
      () => {
        const c = document.querySelector('canvas.qr-canvas');
        return c instanceof HTMLCanvasElement && c.width > 0 && c.height > 0;
      },
      { timeout: 30000 },
    );
    report.steps.push('二维码已渲染');
    report.qrCanvasSize = await page.evaluate(() => {
      const c = document.querySelector('canvas.qr-canvas');
      return c ? { w: c.width, h: c.height } : null;
    });
    await page.screenshot({ path: SHOT_OK });

    // 等扫码成功（最多 4 分钟，期间自动刷新过期二维码）
    const deadline = Date.now() + 4 * 60 * 1000;
    let success = false;

    while (Date.now() < deadline) {
      const state = await page.evaluate(() => {
        const el = document.querySelector('.status');
        return el ? el.className + '|' + (el.textContent || '') : null;
      });

      if (state && state.includes('登录成功')) {
        success = true;
        break;
      }

      if (state && state.includes('expired')) {
        report.steps.push('二维码过期，自动刷新');
        await page.click('.refresh').catch(() => {});
        await page.waitForTimeout(1500);
        continue;
      }

      await page.waitForTimeout(2000);
    }

    report.success = success;
    report.finalStatus = await page.evaluate(() => document.querySelector('.status')?.textContent ?? null);

    if (success) {
      await page.waitForTimeout(800);
      await page.screenshot({ path: SHOT_DONE });

      // 检查凭据是否落库（只返回布尔，不返回值）
      report.credential = await sw.evaluate(async () => {
        const bag = await chrome.storage.session.get('pluma:playback-credential');
        const c = bag['pluma:playback-credential'];
        if (!c || typeof c !== 'object') return null;
        return {
          hasSessdata: typeof c.sessdata === 'string' && c.sessdata.length > 0,
          hasBiliJct: typeof c.biliJct === 'string' && c.biliJct.length > 0,
          hasDedeUserId: typeof c.dedeUserId === 'string' && c.dedeUserId.length > 0,
        };
      });
    }

    report.logs = logs.slice(-20);
  } catch (e) {
    report.error = e.message;
    try {
      const pages = ctx.pages();
      if (pages.length) await pages[pages.length - 1].screenshot({ path: SHOT_OK });
    } catch {}
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    await ctx.close().catch(() => {});
    console.log(JSON.stringify(report, null, 1));
    process.exit(0);
  }
})();
