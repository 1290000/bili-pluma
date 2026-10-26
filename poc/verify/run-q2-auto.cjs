// Q2 DNR 并发验证 —— 自动跑
// 加载 poc/q2-dnr-concurrency 扩展，操作测试页，抓取结论
const { chromium } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const EXT_DIR = path.resolve(__dirname, '../../poc/q2-dnr-concurrency');
const OUT = path.join(__dirname, 'result-q2-auto.full.json');
const SHOT = path.join(__dirname, 'q2-lab.png');

(async () => {
  const report = { startedAt: new Date().toISOString() };

  const ctx = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'pluma-q2-' + Date.now()),
    {
      channel: 'msedge',
      // POC_HEADLESS=1 时无窗口运行（CI / 无显示器环境）。默认 false 保持原行为。
    headless: process.env.POC_HEADLESS === '1',
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        '--no-first-run',
      ],
    },
  );

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    report.extId = extId;

    // 打开测试页（扩展自己的 lab.html）
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/lab.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // 看页面上的可用按钮
    report.buttons = await page.evaluate(() =>
      [...document.querySelectorAll('button')].map((b) => ({
        id: b.id,
        text: (b.textContent || '').trim().slice(0, 40),
      })),
    );

    await page.screenshot({ path: SHOT });

    // 点「测 L1」
    const l1 = page.locator('button', { hasText: /L1/ }).first();
    if (await l1.count()) {
      await l1.click();
      await page.waitForTimeout(12000);
      report.l1 = await page.evaluate(() => {
        const el = document.querySelector('#log, .log, #output, pre');
        return el ? el.textContent.slice(-2000) : null;
      });
    }

    // 点「跑完整测试」
    const full = page.locator('button', { hasText: /完整|全部|跑全/ }).first();
    if (await full.count()) {
      await full.click();
      // 4 策略 × 3 轮，等 3 分钟
      await page.waitForTimeout(180000);
      report.full = await page.evaluate(() => {
        const el = document.querySelector('#log, .log, #output, pre');
        return el ? el.textContent.slice(-6000) : null;
      });
    }

    await page.screenshot({ path: SHOT.replace('.png', '-done.png') });

    // 从 storage 读结构化报告（如果 Q2 写了 lastReport）
    report.stored = await sw.evaluate(async () => {
      const bag = await chrome.storage.local.get('lastReport');
      return bag.lastReport ?? null;
    });
  } catch (e) {
    report.error = e.message;
    try {
      const pages = ctx.pages();
      if (pages.length) await pages[pages.length - 1].screenshot({ path: SHOT });
    } catch {}
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    await ctx.close().catch(() => {});
    console.log(JSON.stringify(report, null, 1).slice(0, 4000));
    process.exit(0);
  }
})();
