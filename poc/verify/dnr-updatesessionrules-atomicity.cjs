#!/usr/bin/env node
/**
 * `chrome.declarativeNetRequest.updateSessionRules()` 的**原子性**实测（2026-10-30）
 *
 * ## 为什么需要这个脚本
 *
 * O1（`dnr.ts` 删白名单中间项留残留）的修法被拍板为「**add 前先清空整个 ID 段**」：
 *
 * ```ts
 * await removeAllPathRules();                          // 调用 1：删
 * await updateSessionRules({ addRules });              // 调用 2：加
 * ```
 *
 * 中间**存在一个规则表为空的窗口**：这段窗口内任何 B站 playurl 请求都拿不到
 * 播放账号 Cookie。
 *
 * 另一条更干净的写法是**一次调用**：
 *
 * ```ts
 * await updateSessionRules({ removeRuleIds, addRules });  // 组合形式
 * ```
 *
 * 如果它严格原子，窗口就不存在，`installPathRules()` 可以收敛成一次调用。
 *
 * **但「是否严格原子」从来没有实测过** —— 它是推演
 * （`.workbuddy-ai/plans/2026-10-30-refactor-plan-v2.md` §O1 的「开工前置」）。
 * 本脚本就是把这条推演变成事实。
 *
 * ## 为什么不能放进 `scripts/verify.mjs`
 *
 * 它要 `chrome.declarativeNetRequest`，只有扩展上下文才有。单测环境（Vitest + jsdom）没有。
 * 归到 `poc/verify/` 这一档。
 *
 * ## 为什么不需要登录态（与 `dnr-disable-clears-tab-rules.cjs` 同理）
 *
 * 它验的是**DNR API 自身的时序语义**，与 cookie 是谁无关。全程用假 cookie。
 * 临时 profile（`launchPersistentContext('')`），关掉即删。
 *
 * ## 判据设计 —— 每条都配「反例自检」
 *
 * 本脚本不依赖「改代码让它变红」，而是在**内部构造对照组**：
 *
 * | # | 判据 | 反例自检 |
 * | --- | --- | --- |
 * | A1 | 组合形式：remove 与 add 同 ID 时，调用返回后规则是**新 Cookie** | —— 这是核心行为 |
 * | A2 | 组合形式里 add 一条**非法规则**时，整批回滚（旧规则仍在）还是部分生效 | 若部分生效 = 不原子 |
 * | B1 | **两次调用**之间确实存在可观测的空窗口（证明当前写法有窗口） | 若观测不到，说明窗口小于探测精度 |
 * | C1 | 组合形式下，`getSessionRules()` 在调用**进行中**是否读到中间态 | 需要并发探测 |
 *
 * ## ⚠️ 探测精度说明（必须诚实写出来）
 *
 * `getSessionRules()` 是异步 API，单次往返在毫秒级。**窗口可能比一次往返更短**。
 * 所以「探测不到空窗口」**不等于「窗口不存在」**，只等于「窗口小于探测精度」。
 * 本脚本对 B1 的结论会明确区分这两种情况，不写成「已验证无窗口」。
 *
 * ## 用法
 *
 * ```bash
 * node poc/verify/dnr-updatesessionrules-atomicity.cjs
 * ```
 *
 * 需要先 `pnpm build`（读 `.output/chrome-mv3`）。会开一个可见窗口，约 20 秒。
 * 不需要登录态。
 */

const { chromium } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');
const EXT_DIR = path.join(ROOT, '.output', 'chrome-mv3');

/**
 * 用本机 Edge，而不是 Playwright 自带的 Chromium。
 * 理由与 `dnr-disable-clears-tab-rules.cjs` 一致：项目目标就是 Chrome + Edge。
 */
const EDGE_PATH =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/** 与 `dnr.ts` 的 PATH_RULE_BASE 一致，避免与扩展自己装的规则互相干扰 */
const RULE_ID = 10000;
const EXTRA_RULE_ID = 10001;

const COOKIE_OLD = 'sessdata=FAKE-OLD; bili_jct=jct0';
const COOKIE_NEW = 'sessdata=FAKE-NEW; bili_jct=jct0';

const PASS = [];
const FAIL = [];
const NOTES = [];

function check(name, ok, detail) {
  (ok ? PASS : FAIL).push({ name, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function note(name, detail) {
  NOTES.push({ name, detail });
  console.log(`note  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 造一条与 `dnr.ts` `buildPathRule()` 形态一致的规则 */
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

/** 读某条规则的 cookie 值 */
function readCookie(sw, id) {
  return sw.evaluate(
    (ruleId) =>
      chrome.declarativeNetRequest.getSessionRules().then((rules) => {
        const r = rules.find((x) => x.id === ruleId);
        if (!r) return null;
        return r.action?.requestHeaders?.[0]?.value ?? 'NO-HEADER';
      }),
    id,
  );
}

/** 清场：删掉本脚本可能用到的 ID，让每个判据从同一起点开始 */
function resetRules(sw) {
  return sw.evaluate(
    ({ ids }) =>
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).then(() => undefined),
    { ids: [RULE_ID, EXTRA_RULE_ID] },
  );
}

// ══════════════════════════════════════════════════════════════════
// A 组：组合形式（removeRuleIds + addRules 在同一次调用里）
// ══════════════════════════════════════════════════════════════════

/**
 * A1：**同 ID 换 Cookie** —— 这是 `installTabRule()` 正在生产里用的形态（`dnr.ts:454`）。
 *
 * 问题：调用返回的那一刻，规则是「新 Cookie」还是「没有规则」？
 * 如果是「没有规则」，说明同 ID 时 remove 与 add 之间有中间态。
 */
async function caseA1(sw) {
  await resetRules(sw);
  await sw.evaluate(
    ({ id, cookie }) =>
      chrome.declarativeNetRequest
        .updateSessionRules({ addRules: [makeRuleInSW(id, cookie)] })
        .then(() => undefined),
    { id: RULE_ID, cookie: COOKIE_OLD },
  );

  const before = await readCookie(sw, RULE_ID);
  check('A1 前置：旧规则已装好', before === COOKIE_OLD, `cookie=${String(before)}`);

  await sw.evaluate(
    ({ id, cookie }) =>
      chrome.declarativeNetRequest
        .updateSessionRules({
          removeRuleIds: [id],
          addRules: [makeRuleInSW(id, cookie)],
        })
        .then(() => undefined),
    { id: RULE_ID, cookie: COOKIE_NEW },
  );

  const after = await readCookie(sw, RULE_ID);
  check(
    'A1 组合形式同 ID 换 Cookie：返回后规则是新 Cookie（不是空）',
    after === COOKIE_NEW,
    `cookie=${String(after)}`,
  );
  return after;
}

/**
 * A2：组合形式里**夹一条非法规则**，看整批是回滚还是部分生效。
 *
 * 非法规则用 `priority: -1`（DNR 要求 priority >= 1）。
 *
 * - 若整批回滚 → 旧规则（`COOKIE_OLD`）仍在 → **原子**
 * - 若部分生效 → 合法的旧规则被删、新的没加上（或非法那条被跳过但合法那条生效）→ **不原子**
 *
 * ⚠️ 这条同时验证「`updateSessionRules` 失败时会不会留下半成品」。
 */
async function caseA2(sw) {
  await resetRules(sw);
  await sw.evaluate(
    ({ id, cookie }) =>
      chrome.declarativeNetRequest
        .updateSessionRules({ addRules: [makeRuleInSW(id, cookie)] })
        .then(() => undefined),
    { id: RULE_ID, cookie: COOKIE_OLD },
  );

  // 非法规则：priority = -1
  const err = await sw.evaluate(
    ({ id, extraId, cookie }) => {
      const bad = makeRuleInSW(extraId, cookie);
      bad.priority = -1; // DNR 要求 >= 1
      return chrome.declarativeNetRequest
        .updateSessionRules({
          removeRuleIds: [id, extraId],
          addRules: [makeRuleInSW(id, cookie), bad],
        })
        .then(
          () => null,
          (e) => String(e && e.message ? e.message : e),
        );
    },
    { id: RULE_ID, extraId: EXTRA_RULE_ID, cookie: COOKIE_NEW },
  );

  const after = await readCookie(sw, RULE_ID);
  const extra = await readCookie(sw, EXTRA_RULE_ID);

  if (err === null) {
    note('A2 非法规则未被拒绝（priority=-1 被接受）', '改用其它非法手段重试');
    check('A2 非法规则必须被拒绝', false, 'priority=-1 竟然通过了');
    return;
  }

  note('A2 非法规则被拒绝', err.slice(0, 120));
  check(
    'A2 整批回滚：旧规则仍在且未被改动（原子性关键）',
    after === COOKIE_OLD && extra === null,
    `rule10000=${String(after)} rule10001=${String(extra)}`,
  );
}

/**
 * A3：**删除与添加指向不同 ID**，验证组合形式下 getSessionRules 是否看到中间态。
 *
 * 这是 `installPathRules()` 收敛成一次调用后的形态：删掉整个段的旧 ID，加新 ID。
 * 若中间态可观测到「旧已删、新未加」，则组合形式**不是**严格原子。
 *
 * 探测方式：密集轮询 `getSessionRules()`，每次记录 `{old, new}` 的存在性。
 * 在调用**发起后不 await**，而是同时开 N 个轮询，看有没有「两者都不存在」的样本。
 */
async function caseA3(sw) {
  await resetRules(sw);
  await sw.evaluate(
    ({ id, cookie }) =>
      chrome.declarativeNetRequest
        .updateSessionRules({ addRules: [makeRuleInSW(id, cookie)] })
        .then(() => undefined),
    { id: RULE_ID, cookie: COOKIE_OLD },
  );

  const result = await sw.evaluate(
    ({ id, extraId, cookie }) => {
      const readBoth = () =>
        chrome.declarativeNetRequest.getSessionRules().then((rules) => ({
          old: rules.some((r) => r.id === id),
          neu: rules.some((r) => r.id === extraId),
        }));

      return new Promise((resolve) => {
        const samples = [];
        let done = false;

        // 轮询器：不停读，直到 update 完成后再多读几次
        const poll = () => {
          if (done && samples.length > 200) return;
          readBoth().then((s) => {
            samples.push(s);
            poll();
          });
        };
        poll();

        chrome.declarativeNetRequest
          .updateSessionRules({
            removeRuleIds: [id],
            addRules: [makeRuleInSW(extraId, cookie)],
          })
          .then(() => {
            done = true;
            // 让它再读几轮，确保覆盖返回后的状态
            setTimeout(() => resolve(samples), 120);
          });
      });
    },
    { id: RULE_ID, extraId: EXTRA_RULE_ID, cookie: COOKIE_NEW },
  );

  const gap = result.filter((s) => !s.old && !s.neu);
  const both = result.filter((s) => s.old && s.neu);
  const oldOnly = result.filter((s) => s.old && !s.neu);
  const newOnly = result.filter((s) => !s.old && s.neu);

  note(
    'A3 组合形式下的中间态采样',
    `总${String(result.length)} 空窗=${String(gap.length)} 两者都在=${String(both.length)} 仅旧=${String(oldOnly.length)} 仅新=${String(newOnly.length)}`,
  );

  check(
    'A3 组合形式（删旧ID+加新ID）未观测到「两者都不存在」的空窗',
    gap.length === 0,
    `空窗样本=${String(gap.length)}/${String(result.length)}`,
  );
}

// ══════════════════════════════════════════════════════════════════
// B 组：两次调用（当前 `installPathRules()` 的实际写法）
// ══════════════════════════════════════════════════════════════════

/**
 * B1：**当前写法的窗口有多大** —— 这是对照组。
 *
 * 明确分离「删」与「加」两次 await，中间密集轮询。
 * 如果这里能稳定观测到「两者都不存在」，就证明**当前写法确实有窗口**，
 * 而 A3 的零空窗才有意义（说明组合形式更好）。
 */
async function caseB1(sw) {
  await resetRules(sw);
  await sw.evaluate(
    ({ id, cookie }) =>
      chrome.declarativeNetRequest
        .updateSessionRules({ addRules: [makeRuleInSW(id, cookie)] })
        .then(() => undefined),
    { id: RULE_ID, cookie: COOKIE_OLD },
  );

  const result = await sw.evaluate(
    ({ id, extraId, cookie }) => {
      const readBoth = () =>
        chrome.declarativeNetRequest.getSessionRules().then((rules) => ({
          old: rules.some((r) => r.id === id),
          neu: rules.some((r) => r.id === extraId),
        }));

      return new Promise((resolve) => {
        const samples = [];
        let updateDone = false;

        const poll = () => {
          if (updateDone && samples.length > 0) return;
          readBoth().then((s) => {
            samples.push(s);
            if (!updateDone) poll();
          });
        };
        poll();

        // 当前写法：先删整个段，再加新规则（两次独立调用）
        chrome.declarativeNetRequest
          .updateSessionRules({ removeRuleIds: [id] })
          .then(() =>
            chrome.declarativeNetRequest.updateSessionRules({
              addRules: [makeRuleInSW(extraId, cookie)],
            }),
          )
          .then(() => {
            updateDone = true;
            setTimeout(() => resolve(samples), 120);
          });
      });
    },
    { id: RULE_ID, extraId: EXTRA_RULE_ID, cookie: COOKIE_NEW },
  );

  const gap = result.filter((s) => !s.old && !s.neu);
  const samplesAtGap = result.length;

  note(
    'B1 两次调用（当前 installPathRules 写法）的中间态采样',
    `总${String(samplesAtGap)} 空窗=${String(gap.length)}`,
  );

  // 这里是**预期**观测到空窗 —— 它证明当前写法确有窗口，是 A3 结论的对照组。
  check(
    'B1 两次调用之间能观测到「两者都不存在」的窗口（证明当前写法有窗口）',
    gap.length > 0,
    `空窗样本=${String(gap.length)}/${String(samplesAtGap)}`,
  );

  if (gap.length === 0) {
    note(
      'B1 未观测到空窗',
      '窗口可能短于 getSessionRules 一次往返（毫秒级）—— 不等于窗口不存在',
    );
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
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

    // `makeRule` 要在页面/SW 上下文里可用，所以注入一份到 SW
    await sw.evaluate(`globalThis.makeRuleInSW = ${makeRule.toString()}; true`);

    console.log('');
    console.log('── A 组：组合形式（removeRuleIds + addRules 同一次调用）──');
    await caseA1(sw);
    await caseA2(sw);
    await caseA3(sw);

    console.log('');
    console.log('── B 组：两次调用（当前 installPathRules 的实际写法，对照组）──');
    await caseB1(sw);
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log('');
  if (NOTES.length > 0) {
    console.log('[dnr-atomic] 📝 观测记录');
    for (const n of NOTES) console.log(`  - ${n.name}：${n.detail ?? ''}`);
  }
  if (FAIL.length === 0) {
    console.log(`[dnr-atomic] ✅ ${String(PASS.length)} 项全过`);
    return;
  }
  console.error(`[dnr-atomic] ❌ ${String(FAIL.length)} 项未过`);
  for (const f of FAIL) console.error(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[dnr-atomic] 脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
