#!/usr/bin/env node
/**
 * 代码注释里的 **ADR 引用**必须指向真实存在的 ADR（2026-10-30）
 *
 * ## 为什么需要它
 *
 * 代码里有 **200+ 处**注释写着「见 ADR 0020」「ADR 0030 方案 c」——
 * 这些引用是**知识索引**：读代码时顺着编号去查「为什么当初这么定」。
 *
 * 而 ADR 会被重新编号、合并、作废。**没有任何东西在检查这些编号还在不在。**
 * 一旦失效，注释会静默指向空——读者点进去发现没有，或者更糟：
 * 编号被复用后指向**另一份** ADR，于是读到的是错的理由。
 *
 * ## 为什么单独成脚本（不并进 check-docs / check-patch-scope）
 *
 * | 脚本 | 职责 |
 * | --- | --- |
 * | `check-docs.mjs` | **文档**之间的引用与篇幅 |
 * | `check-patch-scope.mjs` | 改写**授权**边界（越权风险，合规相关） |
 * | 本脚本 | 代码注释 ↔ **知识索引**（ADR 还在不在） |
 *
 * 三者对象不同。混进任何一个都会让那个脚本的职责边界变模糊。
 *
 * ## 判据
 *
 * 扫 `src/`、`entrypoints/`、`scripts/` 下的源码，提取所有 `ADR <数字>` 形态，
 * 断言 `docs/decisions/` 下存在同名编号的文件。
 *
 * **不跳过"否定语境"**（如「ADR 0017 里没有提到…」）—— 那仍然是在引用一个
 * 必须存在的 ADR。只有**真正不存在的编号**才失败。
 *
 * ## 反例验证
 *
 * 把任一注释改成指向一个**不存在的编号**（大于现存最大号）→ 本脚本 exit 1 并报出行号。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-adr-refs.mjs
 * ```
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DECISIONS = join(ROOT, 'docs', 'decisions');

/** 扫描哪些源码目录 */
const SCAN_ROOTS = ['src', 'entrypoints', 'scripts'];

/** 源码扩展名 */
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;

/**
 * 递归收集源码文件。
 *
 * 跳过构建产物与本地临时目录——它们不是"注释"，而且可能很大。
 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', '.output', '.wxt', '.tmp', 'dist'].includes(e.name)) continue;
      walk(p, out);
    } else if (CODE_EXT.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 现有 ADR 编号集合（四位补零）。
 *
 * 从文件名前缀取，不看内容——文件名是唯一权威（`docs/decisions/` 下
 * `NNNN-slug.md` 是既有惯例）。
 */
function existingAdrNumbers() {
  const set = new Set();
  for (const f of readdirSync(DECISIONS)) {
    const m = /^(\d{4})-/.exec(f);
    if (m) set.add(m[1]);
  }
  return set;
}

/**
 * 从一行里提取所有 ADR 编号。
 *
 * ⚠️ **必须逐个提取，不能只取第一个**：实测有 3 处一行引用两个 ADR
 * （`main-world.js` 的 `ADR 0021…ADR 0022`、`summary-view.ts` 的 `ADR 0014…ADR 0026`）。
 * 只取第一个会漏掉后半段的失效。
 *
 * ## 必须排掉的误报形态（实测踩过）
 *
 * | 形态 | 为什么不是引用 |
 * | --- | --- |
 * | `ADR 引用…（2026-10-30）` | 正则从「ADR」跨到后面的日期，抓到 `2026` |
 * | 本脚本自己的反例说明 | 它讲的是"不存在的编号"，用于验证检查本身有效 |
 * | `ADR 0030 方案 c：**2**` | —— 这个是**真引用**，必须保留 |
 *
 * 判据收紧：`ADR` 与数字之间只允许**空白或一个冒号**，不允许任意字符，
 * 且数字后不能紧跟 `-`（日期）或更多数字。
 *
 * @param {string} line
 * @returns {Array<{raw:string, num:string}>}
 */
function extractAdrNums(line) {
  const out = [];
  // 主形态：`ADR 0020` / `ADR0020` / `ADR：0020`
  for (const m of line.matchAll(/\bADR\s*[:：]?\s*(\d{2,4})(?![\d-])/g)) {
    out.push({ raw: m[0].trim(), num: m[1].padStart(4, '0') });
  }
  // 附带形态：`ADR 0002 / 0006` —— 斜杠后直接跟编号
  for (const m of line.matchAll(/\bADR\s*[:：]?\s*\d{2,4}\s*[/／]\s*(\d{2,4})(?![\d-])/g)) {
    out.push({ raw: `(斜杠后) ${m[1]}`, num: m[1].padStart(4, '0') });
  }
  return out;
}

const existing = existingAdrNumbers();
if (existing.size === 0) {
  console.error('[adr-refs] ❌ docs/decisions/ 下没有任何 NNNN-slug.md —— 路径或命名变了？');
  process.exit(1);
}

const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));

let totalRefs = 0;
const bad = [];

for (const abs of files) {
  const src = readFileSync(abs, 'utf8');
  const rel = relative(ROOT, abs).split('\\').join('/');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.includes('ADR')) continue;

    for (const { raw, num } of extractAdrNums(line)) {
      totalRefs += 1;
      if (!existing.has(num)) {
        bad.push({ file: rel, line: i + 1, raw, num });
      }
    }
  }
}

if (bad.length > 0) {
  console.error(`\n[adr-refs] ❌ ${bad.length} 处引用了不存在的 ADR\n`);
  for (const b of bad) {
    console.error(`  ${b.file}:${b.line}  → ${b.raw}（ADR ${b.num} 不存在）`);
    console.error(
      `    ${(readFileSync(join(ROOT, b.file), 'utf8').split('\n')[b.line - 1] ?? '').trim().slice(0, 110)}`,
    );
  }
  console.error('');
  console.error('  代码注释里的 ADR 编号是**知识索引**，必须指向真实存在的文件。');
  console.error('  改编号，或确认那份 ADR 是否被合并/作废了。');
  console.error(`  现存 ADR：0001 … ${[...existing].sort().pop()}`);
  process.exit(1);
}

console.log(
  `[adr-refs] ✅ ${String(totalRefs)} 处 ADR 引用全部有效` +
    `（扫描 ${String(files.length)} 个文件，现存 ${String(existing.size)} 份 ADR）`,
);
