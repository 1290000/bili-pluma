// Q3 补充探针：运行时"切换账号"必然要重建规则吗？
//
// 问题：规则数不变、只改 credential 值（modifyHeaders 的 value），
// 有没有办法**不调 updateSessionRules** 就生效？
//
// 可测的候选路径只有三条：
//   P1  action 里引用变量 / 占位符                → 看 schema 是否接受
//   P2  `chrome.declarativeNetRequest.updateSessionRules` 之外有 noop 吗 → 看 API 面
//   P3  redirect 到自建端点                        → 需要 webRequestBlocking，MV3 没有
//
// 这条探针只做 P1/P2 的"能力面"实测（不需要真实账号）。

const { chromium } = require('playwright-core');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXT = __dirname;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'pluma-q3-' + Date.now()), {
    executablePath: EDGE,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
    ],
  });

  const out = {};
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 25000 });
    const extId = new URL(sw.url()).host;
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/probe.html`, { waitUntil: 'domcontentloaded' });

    out.apiSurface = await p.evaluate(() => ({
      keys: Object.keys(chrome.declarativeNetRequest).sort(),
      hasUpdateSessionRules: typeof chrome.declarativeNetRequest.updateSessionRules === 'function',
      hasUpdateDynamicRules: typeof chrome.declarativeNetRequest.updateDynamicRules === 'function',
      hasUpdateStaticRules: typeof chrome.declarativeNetRequest.updateStaticRules === 'function',
      isRegexSupported: typeof chrome.declarativeNetRequest.isRegexSupported === 'function',
    }));

    // P1：action.value 里放占位符，看是否被当成字面量接受（= 不存在变量替换）
    const placeholder = await p.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.declarativeNetRequest.updateSessionRules(
            {
              removeRuleIds: [99001],
              addRules: [
                {
                  id: 99001,
                  priority: 1,
                  action: {
                    type: 'modifyHeaders',
                    requestHeaders: [{ header: 'cookie', operation: 'set', value: '${PLUMA_ACCOUNT}' }],
                  },
                  condition: { urlFilter: 'placeholder-probe', requestDomains: ['httpbin.org'] },
                },
              ],
            },
            async () => {
              const err = chrome.runtime.lastError?.message ?? null;
              const rules = await chrome.declarativeNetRequest.getSessionRules();
              const r = rules.find((x) => x.id === 99001);
              resolve({ error: err, persisted: r ?? null });
            },
          );
        }),
    );
    out.placeholderValue = placeholder;

    // P1b：action 用 redirect（不可行性确认：需要 host 权限 + 无法携带动态凭据）
    const redirectProbe = await p.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.declarativeNetRequest.updateSessionRules(
            {
              removeRuleIds: [99002],
              addRules: [
                {
                  id: 99002,
                  priority: 1,
                  action: { type: 'redirect', redirect: { url: 'https://example.invalid/echo' } },
                  condition: { urlFilter: 'redirect-probe', requestDomains: ['httpbin.org'] },
                },
              ],
            },
            (cb) => {
              resolve({ error: chrome.runtime.lastError?.message ?? null, cb: cb ?? null });
            },
          );
        }),
    );
    out.redirectAccepted = redirectProbe;

    // 清理
    await p.evaluate(
      () =>
        new Promise((r) => {
          chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [99001, 99002] }, () => r(true));
        }),
    );
  } catch (e) {
    out.error = String((e && e.stack) || e);
  } finally {
    fs.writeFileSync(path.join(__dirname, 'result-q3.json'), JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(out, null, 1));
    await ctx.close().catch(() => {});
  }
})();
