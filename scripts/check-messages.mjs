#!/usr/bin/env node
/**
 * 消息路由对齐检查。
 *
 * ## 为什么需要这个脚本
 *
 * `src/shared/types/messages.ts` 用判别联合定义了所有请求类型，
 * `entrypoints/background.ts` 用一串 `if (type === '...')` 分发。
 *
 * **两者之间没有任何编译期约束。** 定义一个请求类型却忘了加分支，`tsc` 完全看不出来——
 * 判别联合的 `never` 检查只在 `switch` 的 `default` 分支里成立，而这里用的是 `if` 链。
 *
 * 后果是**静默失败**：发出去拿到 `undefined`，没有任何报错。
 *
 * 已知案例（2026-10-26）：`playinfo/get` 定义了、注释还写着"当前只有类型，没有 handler"，
 * 但没有任何机制在它该被补上时提醒人。注释防不住下一次。
 * （该类型已于 2026-10-27 删除 —— 体检表被 ADR 0016 砍掉后它再无实现可能。）
 *
 * ## 检查什么
 *
 * 1. 定义了请求类型，但 background 不路由 → 孤儿定义
 * 2. background 路由了，但类型里没定义 → 幽灵分支（多半是改名后漏改）
 *
 * `ALLOWED_UNROUTED` 里显式白名单的可以被豁免，**必须写明理由和计划**。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-messages.mjs
 * node scripts/check-messages.mjs --verbose   # 同时列出已对齐的项
 * ```
 *
 * 有违规时退出码 1，可直接用于 CI。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 请求类型的定义处 */
const MESSAGES_FILE = 'src/shared/types/messages.ts';

/** 路由分发处 */
const ROUTER_FILE = 'entrypoints/background.ts';

/**
 * content 侧的**直连**消息处理（不走 background 分发）。
 *
 * ## 为什么需要单独对账（2026-10-30 加，O6）
 *
 * `messages.ts` 里有 4 个类型**刻意不走 background**：
 *
 * | 类型 | 去向 |
 * | --- | --- |
 * | `PageQueryMsg` / `PageQueryReply` | 扩展页 → content 直连（`page/summary:get`） |
 * | `PageSnapshotMsg` / `PageSnapshotReply` | 页面 → content 直连（`page/snapshot:get`） |
 *
 * 理由写在 `messages.ts:162-166`：这份数据只对"当前这个标签页"有意义，
 * 而 content 本来就在那个页面里，绕到 SW 再回来只是多一份要维护的缓存。
 *
 * **但它们不在本脚本原来的扫描范围里**（`MESSAGES_FILE` + `ROUTER_FILE` 两个文件），
 * 于是"改了类型名却忘了改 content 的字符串判断"**不会有任何检查变红** ——
 * 而这正是本脚本存在的理由（见文件头"漏处理不会编译报错"）。
 *
 * 所以补这第三组对账：`messages.ts` 声明的直连类型 ↔ `content.ts` 实际处理的字面量。
 */
const CONTENT_FILE = 'entrypoints/content.ts';

/**
 * 直连消息的类型 ↔ 期望在 content 侧出现的字面量。
 *
 * ⚠️ 加条目时必须确认 `content.ts` 真的处理它；没处理的要写明为什么。
 *
 * @type {Record<string, string>}
 */
const DIRECT_TYPES = {
  PageQueryMsg: 'page/summary:get',
  PageSnapshotMsg: 'page/snapshot:get',
  PageQueryReply: 'page/summary:ok',
  // `PageQueryReply` 是判别联合，有两个应答分支，都要对账
  PageQueryReplyNone: 'page/summary:none',
  PageSnapshotReply: 'page/snapshot:ok',
};

/**
 * 出现但**不需要**纳入直连对账的字面量。
 *
 * ⚠️ 加任何一条必须写明为什么 —— 只写"不需要"等于把检查关掉。
 */
const DIRECT_LITERALS_IGNORED = {
  // 这是 `page/activate` 的应答，走 background 分发（messages.ts 的 ResponseMsg 联合），
  // 已被第一组对账（声明 ↔ background.ts 路由）覆盖，不属于"直连"。
  'page/activate:ok': '走 background 分发，非直连；由第一组对账覆盖',
};

/**
 * 已知的"只有类型、没有 handler"的请求。
 *
 * ⚠️ **加任何一条都必须写明：为什么现在不加、什么时候加。**
 * 只写"暂不需要"等于把检查关掉。
 *
 * @type {Record<string, string>}
 */
const ALLOWED_UNROUTED = {
  // 当前没有任何豁免。
  //
  // 曾经这里有一条 `playinfo/get`（体检表预留），但体检表被 ADR 0016 砍掉后
  // 那个类型永远不会被实现，2026-10-27 已连同两条响应类型一起删除。
  // 教训：豁免理由里写"做完 X 再删"时，X 被砍掉就必须真的来删——否则它会永远留着。
};

/**
 * 从 messages.ts 里抽出 `RequestMsg` 联合的 `type` 字面量。
 *
 * 只在 `export type RequestMsg =` 到 `export type ResponseMsg` 之间匹配，
 * 避免把 ResponseMsg 的 `:ok` / `:err` 也扫进来。
 *
 * @param {string} src
 * @returns {Set<string>}
 */
function extractDeclaredRequests(src) {
  const start = src.indexOf('export type RequestMsg');
  if (start < 0) throw new Error(`${MESSAGES_FILE} 里找不到 'export type RequestMsg'`);

  const end = src.indexOf('export type ResponseMsg', start);
  if (end < 0)
    throw new Error(
      `${MESSAGES_FILE} 里找不到 'export type ResponseMsg'，无法界定 RequestMsg 的范围`,
    );

  const block = src.slice(start, end);
  const found = new Set();
  for (const m of block.matchAll(/type:\s*'([a-zA-Z0-9/-]+)'/g)) {
    found.add(m[1]);
  }
  return found;
}

/**
 * 从 background.ts 里抽出实际路由的 `type === '...'`。
 *
 * 同时识别单引号和双引号，以及 `===` / `!==` 两侧任意顺序的写法。
 *
 * @param {string} src
 * @returns {Map<string, number>} type → 首次出现的行号
 */
function extractRoutedTypes(src) {
  const lines = src.split('\n');
  const found = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const m of line.matchAll(/type\s*===\s*['"]([a-zA-Z0-9/-]+)['"]/g)) {
      if (!found.has(m[1])) found.set(m[1], i + 1);
    }
  }
  return found;
}

/**
 * 核验「直连消息」类型与 content 侧处理是否对齐。
 *
 * 三类问题都要报：
 *   1. `messages.ts` 里声明的字面量，content.ts 里找不到
 *      → 改了类型名却忘了改 content 的字符串判断（**静默失效**）
 *   2. content.ts 里出现了直连前缀的字面量，但 `DIRECT_TYPES` 没登记
 *      → 新增直连消息却没纳入对账
 *   3. `DIRECT_TYPES` 登记的类型在 messages.ts 里已不存在
 *      → 类型被删/改名，对账表过期
 *
 * @param {string} messagesSrc
 * @param {string} contentSrc
 * @returns {{ok: boolean, problems: string[]}}
 */
function checkDirectMessages(messagesSrc, contentSrc) {
  /** @type {string[]} */
  const problems = [];

  // 1) 声明的类型必须真的存在于 messages.ts
  for (const [typeName, literal] of Object.entries(DIRECT_TYPES)) {
    const declRe = new RegExp(`type\\s*:\\s*'${literal.replace(/[/:]/g, '.')}'`);
    if (!declRe.test(messagesSrc)) {
      problems.push(
        `DIRECT_TYPES 里登记的 ${typeName} → '${literal}'，但 ${MESSAGES_FILE} 里已没有这个类型（表过期了）`,
      );
      continue;
    }
    // 2) content.ts 必须真的处理这个字面量
    if (!contentSrc.includes(literal)) {
      problems.push(
        `${typeName} 声明的 '${literal}' 在 ${CONTENT_FILE} 里找不到 —— 改了类型名却忘了改 content 的字符串判断，消息会静默失效`,
      );
    }
  }

  // 3) content.ts 里的直连字面量都要在表里登记过
  const declaredLiterals = new Set(Object.values(DIRECT_TYPES));
  for (const m of contentSrc.matchAll(/'(page\/[a-z]+:(?:get|ok|err|none))'/g)) {
    const lit = m[1];
    if (declaredLiterals.has(lit)) continue;
    if (lit in DIRECT_LITERALS_IGNORED) continue;
    problems.push(
      `'${lit}' 出现在 ${CONTENT_FILE} 里，但既没登记进 DIRECT_TYPES 也没在 DIRECT_LITERALS_IGNORED 写明理由 —— 它不受对账保护`,
    );
  }

  return { ok: problems.length === 0, problems };
}

function sortByKey(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

async function main() {
  const verbose = process.argv.includes('--verbose');

  const [messagesSrc, routerSrc, contentSrc] = await Promise.all([
    readFile(join(ROOT, MESSAGES_FILE), 'utf8'),
    readFile(join(ROOT, ROUTER_FILE), 'utf8'),
    readFile(join(ROOT, CONTENT_FILE), 'utf8'),
  ]);

  const declared = extractDeclaredRequests(messagesSrc);
  const routed = extractRoutedTypes(routerSrc);

  const orphans = [...declared].filter((t) => !routed.has(t)).sort();
  const ghosts = [...routed.keys()].filter((t) => !declared.has(t)).sort();

  const allowed = orphans.filter((t) => t in ALLOWED_UNROUTED);
  const unallowed = orphans.filter((t) => !(t in ALLOWED_UNROUTED));

  // 白名单失效检测：白名单里的类型其实已经被路由了 → 该删掉
  const staleAllowlist = Object.keys(ALLOWED_UNROUTED).filter((t) => routed.has(t));

  console.log(
    `[messages] 定义 ${declared.size} 个请求类型 · 路由 ${routed.size} 个（${MESSAGES_FILE} ↔ ${ROUTER_FILE}）`,
  );

  if (allowed.length > 0) {
    console.log(`[messages] ${allowed.length} 个已豁免（白名单）：`);
    for (const t of allowed) console.log(`  ${t} —— ${ALLOWED_UNROUTED[t]}`);
  }

  if (staleAllowlist.length > 0) {
    console.error(
      `\n[messages] ⚠️  白名单已过期，这些类型现在已经有路由了，请从 ALLOWED_UNROUTED 删掉：`,
    );
    for (const t of staleAllowlist) console.error(`  ${t}`);
  }

  if (unallowed.length === 0 && ghosts.length === 0 && staleAllowlist.length === 0) {
    if (verbose) {
      console.log('[messages] 已对齐的：');
      for (const [t, line] of [...routed].sort(sortByKey)) {
        console.log(`  ${t}  (${ROUTER_FILE}:${line})`);
      }
    }
    console.log('[messages] ✅ 无孤儿、无幽灵分支');
    // 直连消息（不走 background 的那 4 个类型）单独对账
    const direct = checkDirectMessages(messagesSrc, contentSrc);
    if (direct.ok) {
      console.log(
        `[messages] ✅ 直连消息已对齐（${Object.keys(DIRECT_TYPES).length} 个类型 ↔ ${CONTENT_FILE}）`,
      );
    } else {
      console.error(`\n[messages] ❌ 直连消息（content 侧 ${CONTENT_FILE}）与实际处理不一致：\n`);
      for (const p of direct.problems) console.error(`  ${p}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (unallowed.length > 0) {
    console.error(
      `\n[messages] ❌ ${unallowed.length} 个请求类型已定义但没有 handler（发送它会静默拿到 undefined）：\n`,
    );
    for (const t of unallowed) {
      console.error(`  ${t}`);
      console.error(`    → 在 ${ROUTER_FILE} 加分支，或加进本脚本的 ALLOWED_UNROUTED 并写明计划\n`);
    }
  }

  if (ghosts.length > 0) {
    console.error(
      `\n[messages] ❌ ${ghosts.length} 个分支路由了但类型里没定义（多半是改名后漏改）：\n`,
    );
    for (const t of ghosts) {
      console.error(`  ${t}  (${ROUTER_FILE}:${routed.get(t)})`);
      console.error(`    → 在 ${MESSAGES_FILE} 补类型，或删掉这个分支\n`);
    }
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[messages] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
