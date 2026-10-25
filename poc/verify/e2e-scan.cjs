// 截图登录窗口的真实渲染效果 + 端到端扫码
const { chromium } = require('playwright');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXT_DIR = path.resolve(__dirname, '../../.output/chrome-mv3');
const SHOT = path.join(__dirname, 'login-window-shot.png');
const SHOT_DARK = path.join(__dirname, 'login-window-dark.png');
const USER_DATA = path.join(os.tmpdir(), 'pluma-shot-' + Date.now());

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 420, height: 560 },
    colorScheme: 'light',
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
    ],
  });

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;

    // 预热 SW：先发一次消息，避免冷启动导致超时
    const warm = await ctx.newPage();
    await warm.goto(`chrome-extension://${extId}/login-window.html`, { waitUntil: 'domcontentloaded' });
    await warm.waitForFunction(
      () => !!document.querySelector('canvas.qr-canvas'),
      { timeout: 40000 },
    );
    await warm.close();

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/login-window.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('canvas.qr-canvas'), { timeout: 40000 });
    await page.waitForTimeout(600);

    await page.screenshot({ path: SHOT });
    console.log('light ->', SHOT);

    // 深色模式
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOT_DARK });
    console.log('dark  ->', SHOT_DARK);

    await page.emulateMedia({ colorScheme: 'light' });

    // 保持窗口打开，等用户扫码
    console.log('WAITING_FOR_SCAN');
    const deadline = Date.now() + 4 * 60 * 1000;
    let success = false;

    while (Date.now() < deadline) {
      const txt = await page.evaluate(() => document.querySelector('.status')?.textContent ?? '');
      if (txt.includes('登录成功')) {
        success = true;
        break;
      }
      if (txt.includes('失效')) {
        await page.click('.refresh').catch(() => {});
      }
      await page.waitForTimeout(2000);
    }

    const result = { success, finalStatus: await page.evaluate(() => document.querySelector('.status')?.textContent ?? null) };

    if (success) {
      result.credential = await sw.evaluate(async () => {
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

    fs.writeFileSync(path.join(__dirname, 'result-e2e.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 1));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
  } finally {
    await ctx.close().catch(() => {});
    process.exit(0);
  }
})();
