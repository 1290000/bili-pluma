// 诊断：扩展到底有没有被加载
const { chromium } = require('playwright-core');
const path = require('node:path');
const os = require('node:os');
const EXT = path.resolve(__dirname);

(async () => {
  const channel = (process.argv.find((a) => a.startsWith('--browser=')) || '--browser=chrome').split('=')[1] === 'edge' ? 'msedge' : 'chrome';
  const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'pluma-dnr-diag-' + Date.now()), {
    channel,
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const page = await ctx.newPage();
  await page.goto('chrome://extensions');
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    const list = mgr?.shadowRoot?.querySelector('extensions-item-list');
    const items = list?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
    return [...items].map((i) => ({
      id: i.id,
      name: i.shadowRoot?.querySelector('#name')?.textContent?.trim(),
      errors: i.shadowRoot?.querySelector('#errors-button')?.textContent?.trim() ?? null,
      enabled: !!i.shadowRoot?.querySelector('#enableToggle'),
    }));
  });
  // 读错误详情
  let errText = null;
  try {
    await page.evaluate(() => {
      const it = document.querySelector('extensions-manager').shadowRoot
        .querySelector('extensions-item-list').shadowRoot.querySelector('extensions-item');
      it?.shadowRoot?.querySelector('#errors-button')?.click();
    });
    await page.waitForTimeout(1200);
    errText = await page.evaluate(() => {
      const dlg = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-error-page') 
        || document.querySelector('extensions-manager').shadowRoot.querySelector('#error-page');
      return dlg?.textContent?.slice(0, 3000) ?? null;
    });
  } catch (e) {
    errText = 'err read failed: ' + e.message;
  }
  console.log(JSON.stringify({ version: ctx.browser()?.version?.(), items: info, errText }, null, 1));
  console.log('SWs:', ctx.serviceWorkers().map((s) => s.url()));
  await ctx.close();
})();
