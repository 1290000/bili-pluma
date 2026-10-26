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
 * 已知的"只有类型、没有 handler"的请求。
 *
 * ⚠️ **加任何一条都必须写明：为什么现在不加、什么时候加。**
 * 只写"暂不需要"等于把检查关掉。
 *
 * @type {Record<string, string>}
 */
const ALLOWED_UNROUTED = {
  'playinfo/get':
    'P3 体检表才用；见 messages.ts 第 37 行注释与 ADR 0014。做完体检表必须删掉这条白名单。',
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

function sortByKey(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

async function main() {
  const verbose = process.argv.includes('--verbose');

  const [messagesSrc, routerSrc] = await Promise.all([
    readFile(join(ROOT, MESSAGES_FILE), 'utf8'),
    readFile(join(ROOT, ROUTER_FILE), 'utf8'),
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
