// 自动化跑 P0：启动 Edge（全新 profile）→ 加载未打包扩展 → 打开测试页 → 点按钮 → 读结果
// 不碰用户任何 profile / 登录态
const { chromium } = require('playwright');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXT = path.resolve(__dirname, '../q2-dnr-concurrency');
const OUT = path.join(__dirname, 'p0-result.json');
const SHOT = path.join(__dirname, 'p0-result.png');
const USER_DATA = path.join(os.tmpdir(), 'pluma-p0-' + Date.now());

// 起本地 echo 服务（与被测扩展无关，只是靶子）
require('../q2-dnr-concurrency/echo-server.cjs');

(async () => {
  const result = { startedAt: new Date().toISOString(), extPath: EXT };

  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1100, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) {
      try {
        sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
      } catch {
        throw new Error(
          '扩展 service worker 未出现。可能原因：Edge 156 已禁用 --load-extension，或扩展加载失败。',
        );
      }
    }
    const extId = new URL(sw.url()).host;
    result.extId = extId;

    const page = await ctx.newPage();
    const consoleLines = [];
    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

    await page.goto(`chrome-extension://${extId}/test.html`, { waitUntil: 'domcontentloaded' });
    result.pageLoaded = true;

    await page.click('#run');

    // 等按钮恢复可用 = 全部测试跑完（含 T0 失败后的 T0b 降级）
    await page.waitForFunction(
      () => {
        const b = document.getElementById('run');
        return b && b.disabled === false && document.querySelector('table tbody tr');
      },
      { timeout: 180000 },
    );

    result.verdict = (await page.textContent('#verdict'))?.trim() || null;
    result.verdictClass = await page.getAttribute('#verdict', 'class');

    result.rows = await page.$$eval('table tbody tr', (trs) =>
      trs.map((tr) => ({
        name: tr.children[0]?.innerText?.trim(),
        result: tr.children[1]?.innerText?.trim(),
        count: tr.children[2]?.innerText?.trim(),
        detail: tr.children[3]?.innerText?.trim()?.slice(0, 600),
      })),
    );

    result.console = consoleLines.slice(-30);
    await page.screenshot({ path: SHOT, fullPage: true });
  } catch (e) {
    result.error = e.message;
    try {
      const pages = ctx.pages();
      if (pages.length) await pages[pages.length - 1].screenshot({ path: SHOT, fullPage: true });
    } catch {}
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    await ctx.close().catch(() => {});
    console.log(JSON.stringify(result, null, 1));
    process.exit(result.error ? 1 : 0);
  }
})();
