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
 * ## 为什么不再需要真实登录态（2026-10-27 改造）
 *
 * 旧版要求"已登录播放账号的 profile"，否则**整个脚本跳过**。两个问题：
 *
 * 1. 它用 `launchPersistentContext('')` —— 空字符串 = 每次新建临时 profile，关掉就删。
 *    所以旧提示里那句"先在这个 browser 里扫码登录一次，再重跑"**根本做不到**：
 *    扫完关掉窗口，profile 就没了。
 * 2. 更关键：这条判据**不需要真实凭据**。它验的是 `disableProxy()` 删不删两类规则，
 *    跟 cookie 是谁无关 —— `run-q2-auto.cjs` 早就用 `FAKE-1-0-xxx` 假 cookie 验过 DNR 行为。
 *
 * 现在改成**手工造状态**：直接在 SW 里装一条 10000 段 + 一条 20000 段规则
 * （形态与 `dnr.ts` 的 `buildPathRule` / `installTabRule` 一致），
 * 然后发 `proxy/set {enabled:false}`，看它删不删。
 *
 * ## 判据（四条，前三条零依赖）
 *
 * 1. **前置自检**：手工装的两类规则确实存在（`path=1 tab=1`）。
 *    没有这一步，后面的"清零"可能只是"本来就没有"。
 * 2. **反例自检**：只删 path 段时，tab 段**必须残留**。
 *    这证明"如果代码只删 path，tab 会留下"——也就是那个 bug 的形状。
 *    **这是本脚本能自证的关键**：不依赖"改代码让它变红"，而是在内部造出"只删一类"的情形。
 * 3. **核心判据**：`proxy/set {enabled:false}` 后，两类都归零。
 * 4. **状态一致**：`storage.local` 的 `pluma:proxy-enabled` 变成 `false`。
 *
 * ## 可选：真实登录态下的端到端
 *
 * 若当前 profile **碰巧**有播放账号凭据，额外验三条：真实视频页会装 tab 规则、
 * 关开关后清零、刷新后不回来。**没有凭据时明确报「未验」，而不是跳过整个脚本**——
 * 前三项无论如何都会给出结论。
 *
 * ## 用法
 *
 * ```bash
 * node poc/verify/dnr-disable-clears-tab-rules.cjs
 * ```
 *
 * 需要先 `pnpm build`（读 `.output/chrome-mv3`）。会开一个可见窗口，约 15 秒。
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

/** 与 `dnr.ts` 的段位保持一致（10000 / 20000），否则 `removeAll*Rules` 认不出来 */
const PATH_RULE_ID = 10001;
const TAB_RULE_ID = 20001;
const PATH_BAND = [10000, 11000];
const TAB_BAND = [20000, 30000];

/** 假凭据：内容不重要，只要是个非空 cookie 串（真凭据反而会被写进日志的风险） */
const FAKE_COOKIE = 'sessdata=FAKE-DISABLE-TEST; bili_jct=jct0';

const PASS = [];
const FAIL = [];
const SKIPPED = [];

function check(name, ok, detail) {
  (ok ? PASS : FAIL).push({ name, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function skip(name, why) {
  SKIPPED.push({ name, why });
  console.log(`--    ${name}（未验：${why}）`);
}

/** 数当前会话里的两类规则 */
function countRules(sw) {
  return sw.evaluate(
    ({ pathBand, tabBand }) =>
      chrome.declarativeNetRequest.getSessionRules().then((rules) => ({
        path: rules.filter((r) => r.id >= pathBand[0] && r.id < pathBand[1]).length,
        tab: rules.filter((r) => r.id >= tabBand[0] && r.id < tabBand[1]).length,
      })),
    { pathBand: PATH_BAND, tabBand: TAB_BAND },
  );
}

/** 手工装一条 path 规则 + 一条 tab 规则，形态与 dnr.ts 一致 */
function installFakeRules(sw) {
  return sw.evaluate(
    ({ pathRuleId, tabRuleId, fakeCookie }) => {
      const action = {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'set', value: fakeCookie }],
      };
      const baseCondition = {
        urlFilter: '/x/player/wbi/playurl',
        requestDomains: ['api.bilibili.com'],
        resourceTypes: ['xmlhttprequest'],
        requestMethods: ['get'],
      };

      return chrome.declarativeNetRequest
        .updateSessionRules({
          removeRuleIds: [pathRuleId, tabRuleId],
          addRules: [
            { id: pathRuleId, priority: 1, action, condition: baseCondition },
            // tabIds 只要求是数字；DNR 不校验该标签页是否真的存在
            { id: tabRuleId, priority: 2, action, condition: { ...baseCondition, tabIds: [1] } },
          ],
        })
        .then(() => undefined);
    },
    { pathRuleId: PATH_RULE_ID, tabRuleId: TAB_RULE_ID, fakeCookie: FAKE_COOKIE },
  );
}

/** 只删 path 段（模拟旧 bug 的行为），用于反例自检 */
function removePathBandOnly(sw) {
  return sw.evaluate(
    ({ pathBand }) =>
      chrome.declarativeNetRequest.getSessionRules().then((rules) =>
        chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: rules
            .filter((r) => r.id >= pathBand[0] && r.id < pathBand[1])
            .map((r) => r.id),
        }),
      ),
    { pathBand: PATH_BAND },
  );
}

/**
 * 通过**真实消息**关掉总开关 —— 必须走 `proxy/set`，不能直接删规则，
 * 否则测的是脚本自己而不是 `disableProxy()`。
 *
 * 优先在扩展页里发（那里一定有 `chrome.runtime`）；
 * 扩展页打不开时退回到 SW 自发（SW 给自己发消息同样会触发 onMessage）。
 */
async function disableViaMessage(ctx, sw, extId) {
  try {
    const extPage = await ctx.newPage();
    await extPage.goto(`chrome-extension://${extId}/options.html#/account`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await extPage.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'proxy/set', enabled: false }, () =>
            resolve(undefined),
          );
        }),
    );
    await extPage.close();
    return 'ext-page';
  } catch {
    await sw.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'proxy/set', enabled: false }, () =>
            resolve(undefined),
          );
        }),
    );
    return 'sw-self';
  }
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
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });

  try {
    // 等 MV3 service worker 起来
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

    const extId = new URL(sw.url()).host;

    // ══════════════════════════════════════════════════════════════
    // 阶段 A：零依赖，手工造状态（前三项判据）
    // ══════════════════════════════════════════════════════════════

    await installFakeRules(sw);
    const installed = await countRules(sw);
    check(
      '前置自检：两类规则都装上了',
      installed.path === 1 && installed.tab === 1,
      `path=${String(installed.path)} tab=${String(installed.tab)}`,
    );

    // 反例自检：只删 path，tab 必须还在
    await removePathBandOnly(sw);
    const afterPathOnly = await countRules(sw);
    check(
      '反例自检：只删 path 段时，tab 段会残留（这就是那个 bug 的形状）',
      afterPathOnly.path === 0 && afterPathOnly.tab === 1,
      `path=${String(afterPathOnly.path)} tab=${String(afterPathOnly.tab)}`,
    );

    // 恢复成"两类都在"的状态，再走真实关开关流程
    await installFakeRules(sw);
    const beforeDisable = await countRules(sw);
    check(
      '重新装好后两类都在',
      beforeDisable.path === 1 && beforeDisable.tab === 1,
      `path=${String(beforeDisable.path)} tab=${String(beforeDisable.tab)}`,
    );

    const channel = await disableViaMessage(ctx, sw, extId);
    await new Promise((r) => setTimeout(r, 800));

    const afterDisable = await countRules(sw);
    check('关掉开关后路径规则清零', afterDisable.path === 0, `path=${String(afterDisable.path)}`);
    check(
      '关掉开关后**标签页**规则清零（本次修的 bug）',
      afterDisable.tab === 0,
      `tab=${String(afterDisable.tab)}`,
    );

    const enabledFlag = await sw.evaluate(() =>
      chrome.storage.local.get('pluma:proxy-enabled').then((b) => b['pluma:proxy-enabled']),
    );
    check('总开关状态置为 false', enabledFlag === false, `enabled=${String(enabledFlag)}`);
    console.log(`     （关开关走的通道：${channel}）`);

    // ══════════════════════════════════════════════════════════════
    // 阶段 B：有真实凭据才跑的端到端（第四项判据）
    // ══════════════════════════════════════════════════════════════

    const hasCred = await sw.evaluate(() =>
      chrome.storage.local.get('pluma:vault').then((b) => {
        const v = b['pluma:vault'];
        return Boolean(v && typeof v === 'object' && Object.keys(v).length > 0);
      }),
    );

    if (!hasCred) {
      skip(
        '真实视频页会装 tab 规则 → 关开关清零 → 刷新后不回来',
        '当前临时 profile 没有播放账号凭据（要验这三条得手动扫码，见文件头「可选」一节）',
      );
    } else {
      const page = await ctx.newPage();
      await page.goto('https://www.bilibili.com/video/BV1jt421t7XH/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(4000);

      const live = await countRules(sw);
      check('真实视频页会装标签页规则', live.tab > 0, `path=${String(live.path)} tab=${String(live.tab)}`);

      await disableViaMessage(ctx, sw, extId);
      await new Promise((r) => setTimeout(r, 800));
      const liveAfter = await countRules(sw);
      check(
        '关开关后清零（真实页面）',
        liveAfter.path === 0 && liveAfter.tab === 0,
        `path=${String(liveAfter.path)} tab=${String(liveAfter.tab)}`,
      );

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      const afterReload = await countRules(sw);
      check(
        '关掉后刷新页面，规则不许被重新装上',
        afterReload.path === 0 && afterReload.tab === 0,
        `path=${String(afterReload.path)} tab=${String(afterReload.tab)}`,
      );
      await page.close();
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log('');
  if (SKIPPED.length > 0) {
    console.log(`[dnr-disable] ⚠️  ${String(SKIPPED.length)} 项未验（不是失败，但别当它过了）`);
    for (const s of SKIPPED) console.log(`  - ${s.name}：${s.why}`);
  }
  if (FAIL.length === 0) {
    console.log(`[dnr-disable] ✅ ${String(PASS.length)} 项全过`);
    /**
     * 写「跑过了」的凭据 —— 让 verify 能验证这条义务被履行了（2026-10-30）。
     *
     * 为什么必须有：`AGENTS.md` §4.3 要求改 dnr.ts 就跑本脚本，
     * 但 verify 只能提醒（代跑会变成"看起来验过了"）。凭据把提醒变成**可检查**。
     *
     * ⚠️ 必须 `await`：本函数返回后 main() 就结束了，
     * 不 await 的话凭据可能**来不及写**（进程已退出）—— 那会造成假的"没跑过"。
     */
    try {
      const m = await import('./dnr-stamp.mjs');
      m.writeStamp('dnr-disable-clears-tab-rules', {
        passed: PASS.length,
        skipped: SKIPPED.length,
      });
      console.log(`[dnr-disable] 📝 已记录回归凭据（verify 会据此判定 dnr.ts 改动已验）`);
    } catch (e) {
      console.log(`[dnr-disable] ⚠️  凭据写入失败（不影响本次结论）：${String(e && e.message)}`);
    }
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
