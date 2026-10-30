#!/usr/bin/env node
/**
 * `AGENTS-RULES.md` §3「规则 → 机械保障 对照表」的自校验（2026-10-30）
 *
 * ## 为什么这张表需要被检查
 *
 * 它声称"某条规则有机械保障"。**如果这个声称是错的，它比没有表更糟** ——
 * 下一个人会以为"有检查兜着"，于是放心违反。
 *
 * ## 判据
 *
 * 1. 表里每个 `✅ 自动` 行提到的检查名，必须在 `scripts/verify.mjs` 的 `STEPS`
 *    里**真实存在**（这保证"自动化"不是空话）
 * 2. 表里引用的 `§N` 由 `check-doc-sections` 负责（这里不重复）
 * 3. 表里出现的检查名拼错 → 红（这是最容易发生的漂移）
 *
 * ⚠️ **不检查"条数"** —— 那是人工统计，随 `AGENTS.md` 改动而变，
 * 机械比对会频繁误报。条数只作为"大致规模"参考，不参与断言。
 *
 * ## 反例验证
 *
 * 把表里 `required-files` 改成 `required-filez`（拼错）→ 本脚本 exit 1。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-rule-map.mjs
 * ```
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const MAP = join(ROOT, 'AGENTS-RULES.md');
const VERIFY = join(ROOT, 'scripts', 'verify.mjs');

/** verify 里真实存在的检查项名 */
function actualChecks() {
  const src = readFileSync(VERIFY, 'utf8');
  const names = new Set();
  // 只取 STEPS 数组里的 name: 'xxx'
  for (const m of src.matchAll(/name:\s*'([a-z][a-z0-9-]*)'/g)) names.add(m[1]);
  return names;
}

/**
 * 表格第 4 列里**不是检查项名**的词。
 *
 * 它们出现在"保障"列里描述机制（如"`verify` 会提示"），不是 verify 的步骤名。
 * 显式列出而不用模糊规则：**每加一个都要问"这真的不是检查项吗"**。
 */
const NOT_CHECK_NAMES = new Set([
  'verify', // 指整个验收入口，不是一个步骤
  'eslint', // 外部工具
  'tsc', // 外部工具
  'git', // 外部工具
]);

/**
 * 从对照表里抽出"声称的检查名"。
 *
 * 表格第 4 列是检查项，形态如 `required-files`、`dnr-regression`、`patch`。
 * 只从**表格行**里抽（反引号包裹的短横线标识符），避免抓到散文里的词。
 */
function claimedChecks(src) {
  const out = new Map(); // 检查名 → 首次出现的行号
  const lines = src.split('\n');
  let inSection = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^## 3\. 规则/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) break;
    if (!inSection) continue;
    if (!/^\|/.test(line)) continue;
    // 第 4 列
    const cols = line.split('|').map((c) => c.trim());
    const last = cols[cols.length - 2] ?? '';
    for (const m of last.matchAll(/`([a-z][a-z0-9-]*)`/g)) {
      const name = m[1];
      if (NOT_CHECK_NAMES.has(name)) continue;
      if (!out.has(name)) out.set(name, i + 1);
    }
  }
  return out;
}

const actual = actualChecks();
const claimed = claimedChecks(readFileSync(MAP, 'utf8'));

if (claimed.size === 0) {
  console.error('[rule-map] ❌ 在 AGENTS-RULES.md §3 的对照表里没找到任何检查名 —— 表结构变了？');
  process.exit(1);
}

const unknown = [...claimed.entries()].filter(([name]) => !actual.has(name));

if (unknown.length > 0) {
  console.error(`\n[rule-map] ❌ 对照表里 ${String(unknown.length)} 个检查名在 verify 里不存在\n`);
  for (const [name, line] of unknown) {
    console.error(`  AGENTS-RULES.md:${String(line)}  → \`${name}\``);
  }
  console.error('');
  console.error('  这张表声称"某条规则有机械保障"。**声称错了比没有表更糟** ——');
  console.error('  下一个人会以为有检查兜着，于是放心违反。');
  console.error('');
  console.error(`  verify 里实际存在：${[...actual].join(', ')}\n`);
  process.exit(1);
}

console.log(`[rule-map] ✅ 对照表里 ${String(claimed.size)} 个检查名全部在 verify 里真实存在`);
