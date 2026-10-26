#!/usr/bin/env node
/**
 * 验收判据 5 的回归：**关掉总开关后，DNR 规则必须一条不剩**
 *
 * ## 为什么需要这个脚本
 *
 * 2026-10-27 用户实测发现：关掉总开关 → 刷新视频页 → **画质没回落**，还是杜比/4K。
 *
 * 根因是 `disableProxy()` 只删 10000 段的全局路径规则，
 * **20000 段的标签页规则从来没被删过**。那条规则 priority 2、带 `tabIds`，
 * 刷新后 tabId 不变，于是一直在生效 —— popup 显示「已停用」，实际仍在代理。
 *
 * 这不只是"少删了一类规则"，而是**界面与事实不一致**，属于最坏的一类 bug。
 *
 * ## 为什么不能放进 `scripts/verify.mjs`
 *
 * 它要 `chrome.declarativeNetRequest`，而那是扩展上下文才有的 API。
 * 单测环境（Vitest + jsdom）没有。所以归到这一档：
 * **改过 `dnr.ts` 就必须跑**（AGENTS.md §4.3 路由表）。
 *
 * ## 判据（三条，缺一不可）
 *
 * 1. 开关**开着**时：标签页规则存在（否则功能根本没工作）
 * 2. 关掉开关后：**path 和 tab 两类规则都为 0**
 * 3. 再打开开关并刷新页面后：规则重新出现（证明不是"关掉就再也起不来"）
 *
 * ## 用法
 *
 * ```bash
 * node poc/verify/dnr-disable-clears-tab-rules.cjs
 * ```
 *
 * ⚠️ 需要**已加载扩展**且有真实登录态。无头环境跑不了，会直接报错退出。
 */

const { chromium } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');
const EXT_DIR = path.join(ROOT, '.output', 'chrome-mv3');

/**
 * 用本机 Edge，而不是 Playwright 自带的 Chromium。
 *
 * 理由：项目目标是 Chrome + Edge，用 Edge 验更贴近真实；
 * 而且不必为了跑一个回归去下载一份 Chromium（`npx playwright install`）。
 *
 * 可用 `EDGE_PATH` 覆盖。
 */
const EDGE_PATH =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/** 从 target 页面里通过扩展页面拿规则 —— 实际用 background 的诊断消息更好 */
const PASS = [];
const FAIL = [];

function check(name, ok, detail) {
  (ok ? PASS : FAIL).push({ name, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    console.error(`${EXT_DIR} 里没有 manifest.json，先跑 pnpm build`);
    process.exit(2);
  }

  if (!fs.existsSync(EDGE_PATH)) {
    console.error(`找不到浏览器：${EDGE_PATH}（用 EDGE_PATH 环境变量覆盖）`);
    process.exit(2);
  }

  const ctx = await chromium.launchPersistentContext('', {
    executablePath: EDGE_PATH,
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });

  try {
    // 等 MV3 service worker 起来
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

    const extId = new URL(sw.url()).host;

    /**
     * 在 **service worker 上下文**里执行 —— `chrome.declarativeNetRequest` 在那里可用。
     *
     * 这是本项目验证 DNR 的唯一可靠姿势：页面上下文拿不到这些 API，
     * 扩展页又会被 bsk 的沙箱拒绝（见 `browser-skill-setup.md` §7a）。
     */
    const readRules = () =>
      sw.evaluate(() =>
        chrome.declarativeNetRequest.getSessionRules().then((rules) => ({
          path: rules.filter((r) => r.id >= 10000 && r.id < 11000).length,
          tab: rules.filter((r) => r.id >= 20000 && r.id < 30000).length,
        })),
      );

    const page = await ctx.newPage();

    // ── 前置：必须有可用的播放账号凭据，否则根本装不了规则 ──
    //
    // ⚠️ **这一步漏了会让整个脚本变成空检验**：2026-10-27 首跑就是
    // 全新 profile、没配账号 → `handlePageActivate` 在 `not-configured` 就返回 →
    // path=0 tab=0 → 后面三条"清零"断言**全都轻松通过**，什么也没验。
    //
    // 这类"因为前提不成立所以测试永远绿"的问题，比 bug 本身更危险：
    // 它会让人以为验过了。
    const hasCred = await sw.evaluate(() =>
      chrome.storage.local.get('pluma:vault').then((b) => {
        const v = b['pluma:vault'];
        return Boolean(v && typeof v === 'object' && Object.keys(v).length > 0);
      }),
    );
    if (!hasCred) {
      console.error(
        [
          '[dnr-disable] 跳过：当前 profile 没有播放账号凭据。',
          '',
          '  这个脚本**必须**在已登录播放账号的 profile 上跑，否则规则根本不会装，',
          '  三条"清零"断言会全部空过 —— 看着是绿的，其实什么也没验。',
          '',
          '  做法：先在这个 browser 里手动扫码登录一次播放账号，再重跑。',
        ].join('\n'),
      );
      process.exitCode = 3;
      return;
    }

    // 打开一个视频页，让 content script 报到 → 装标签页规则
    await page.goto('https://www.bilibili.com/video/BV1jt421t7XH/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const before = await readRules();
    check(
      '开关开着时存在标签页规则',
      before.tab > 0,
      `path=${String(before.path)} tab=${String(before.tab)}`,
    );

    // ── 关掉总开关 ──
    //
    // ⚠️ 必须在**扩展页**里发这条消息。普通页面没有 `chrome.runtime`，
    // 发了也是静默失败 —— 那会让下面的断言"看起来通过了"（因为规则本来就没删）。
    // 这类"检测手段本身无效"的坑，比 bug 更难发现。
    const extPage = await ctx.newPage();
    await extPage.goto(`chrome-extension://${extId}/options.html#/account`);
    await extPage.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'proxy/set', enabled: false }, () => resolve(undefined));
        }),
    );
    await extPage.waitForTimeout(800);

    const after = await readRules();
    check('关掉开关后路径规则清零', after.path === 0, `path=${String(after.path)}`);
    check(
      '关掉开关后**标签页**规则清零（本次修的 bug）',
      after.tab === 0,
      `tab=${String(after.tab)}`,
    );

    // ── 关掉后刷新视频页，规则不许回来 ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const afterReload = await readRules();
    check(
      '关掉后刷新页面，规则不许被重新装上',
      afterReload.path === 0 && afterReload.tab === 0,
      `path=${String(afterReload.path)} tab=${String(afterReload.tab)}`,
    );
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log('');
  if (FAIL.length === 0) {
    console.log(`[dnr-disable] ✅ ${String(PASS.length)} 项全过`);
    return;
  }
  console.error(`[dnr-disable] ❌ ${String(FAIL.length)} 项未过`);
  for (const f of FAIL) console.error(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[dnr-disable] 脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
