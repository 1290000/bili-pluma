#!/usr/bin/env node
/**
 * 采样器自检：A3 / B1 的采样数差异（201 vs 3）是**API 行为**还是**采样器偏差**？
 *
 * ## 为什么要单独做这一步
 *
 * 第一版脚本的结果：
 *   A3（组合形式，一次调用） → 201 个样本，空窗 0
 *   B1（两次调用，当前写法） → 3 个样本，空窗 1
 *
 * 但 B1 的轮询循环里有个 bug 形状：`if (updateDone && samples.length > 0) return;`
 * —— 两次 `updateSessionRules` 之间是「微任务级」的连续 await，轮询器可能**来不及**
 * 发第二次 `getSessionRules`。所以「只采到 3 个样本」本身可疑：
 * **空窗可能是真的，也可能是采样器被饿死导致的假象。**
 *
 * 判据：如果空窗是**真的**，那么把「删」和「加」之间人为插入不同长度延迟
 * （0ms / 5ms / 50ms），空窗样本数应当**随之增长**。
 * 若 0ms 时空窗恰好 1 个、50ms 时空窗几十个，说明采样器能看见窗口，结论可信。
 * 若 0ms 时空窗 0 而 50ms 时空窗很多，说明**第一版的 B1 结果是采样器假象**。
 *
 * 用法：node poc/verify/dnr-atomicity-sampler-selftest.cjs
 * 不需要登录态。
 */

const { chromium } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');
const EXT_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const EDGE_PATH =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const OLD_ID = 10000;
const NEW_ID = 10001;

const RESULTS = [];

function makeRule(id, cookie) {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'set', value: cookie }],
    },
    condition: {
      urlFilter: '/x/player/wbi/playurl',
      requestDomains: ['api.bilibili.com'],
      resourceTypes: ['xmlhttprequest'],
      requestMethods: ['get'],
    },
  };
}

async function runCase(sw, delayMs) {
  await sw.evaluate(
    ({ ids }) =>
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).then(() => undefined),
    { ids: [OLD_ID, NEW_ID] },
  );
  await sw.evaluate(
    ({ id, cookie }) =>
      chrome.declarativeNetRequest
        .updateSessionRules({ addRules: [makeRuleInSW(id, cookie)] })
        .then(() => undefined),
    { id: OLD_ID, cookie: 'sessdata=OLD' },
  );

  const samples = await sw.evaluate(
    ({ oldId, newId, delay }) => {
      const readBoth = () =>
        chrome.declarativeNetRequest.getSessionRules().then((rules) => ({
          old: rules.some((r) => r.id === oldId),
          neu: rules.some((r) => r.id === newId),
        }));

      return new Promise((resolve) => {
        const out = [];
        let stopped = false;

        // 轮询器：**不受 update 进度影响**，一直读到 stop 为止
        const poll = () => {
          if (stopped) return;
          readBoth().then((s) => {
            out.push(s);
            poll();
          });
        };
        poll();

        // 用 setTimeout 而不是裸 await，让轮询器有真实的执行机会
        chrome.declarativeNetRequest
          .updateSessionRules({ removeRuleIds: [oldId] })
          .then(
            () =>
              new Promise((r) => {
                setTimeout(r, delay);
              }),
          )
          .then(() =>
            chrome.declarativeNetRequest.updateSessionRules({
              addRules: [makeRuleInSW(newId, 'sessdata=NEW')],
            }),
          )
          .then(() => {
            setTimeout(() => {
              stopped = true;
              resolve(out);
            }, 100);
          });
      });
    },
    { oldId: OLD_ID, newId: NEW_ID, delay: delayMs },
  );

  const gap = samples.filter((s) => !s.old && !s.neu);
  const oldOnly = samples.filter((s) => s.old && !s.neu);
  const newOnly = samples.filter((s) => !s.old && s.neu);
  return { delayMs, total: samples.length, gap: gap.length, oldOnly: oldOnly.length, newOnly: newOnly.length };
}

async function main() {
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    console.error(`${EXT_DIR} 里没有 manifest.json，先跑 pnpm build`);
    process.exit(2);
  }
  if (!fs.existsSync(EDGE_PATH)) {
    console.error(`找不到浏览器：${EDGE_PATH}`);
    process.exit(2);
  }

  const ctx = await chromium.launchPersistentContext('', {
    executablePath: EDGE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    await sw.evaluate(`globalThis.makeRuleInSW = ${makeRule.toString()}; true`);

    for (const delay of [0, 5, 50]) {
      const r = await runCase(sw, delay);
      RESULTS.push(r);
      console.log(
        `delay=${String(delay).padStart(2)}ms  总样本=${String(r.total).padStart(3)}  空窗=${String(r.gap).padStart(3)}  仅旧=${String(r.oldOnly).padStart(3)}  仅新=${String(r.newOnly).padStart(3)}`,
      );
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log('');
  const zero = RESULTS.find((r) => r.delayMs === 0);
  const fifty = RESULTS.find((r) => r.delayMs === 50);
  if (!zero || !fifty) {
    console.error('[sampler-selftest] 采样失败');
    process.exitCode = 2;
    return;
  }

  const scales = fifty.gap > zero.gap;
  console.log(`[sampler-selftest] delay=0 空窗 ${String(zero.gap)}，delay=50 空窗 ${String(fifty.gap)}`);
  console.log(
    scales
      ? '[sampler-selftest] ✅ 空窗数量随人为延迟增长 → 采样器能看见窗口，B1 结论可信'
      : '[sampler-selftest] ❌ 空窗数量不随延迟增长 → 采样器可能看不见窗口，B1 结论不可信',
  );
  if (!scales) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[sampler-selftest] 脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
