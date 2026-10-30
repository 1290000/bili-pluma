#!/usr/bin/env node
/**
 * 文档对 `AGENTS.md` 的**章节/条目引用**必须指向真实存在的位置（2026-10-30）
 *
 * ## 为什么需要它
 *
 * 全仓有 **31 处** `AGENTS.md §N` 形式的引用，另有 **4 处**精确到「§N 第 M 条」。
 * 这些引用是**规则的索引**：AD..R 里写「这与 §3 决策 2 冲突」，
 * 读者要顺着它去查原文。
 *
 * ## 实测抓到的真实错误（2026-10-30）
 *
 * ```
 * docs/decisions/0011:37  | `AGENTS.md` §2 第 2 条 | "请求级代理，不切 cookie" |
 * docs/decisions/0012:171 | `AGENTS.md` §2 第 2 条 | 「不切 cookie」…           |
 * ```
 *
 * **两处都错了**：`§2` 是「先读什么」，**没有任何编号条目**；
 * 「请求级代理，不切 cookie」实际在 **§3 决策 2**（`AGENTS.md` 的 12 条不可翻案决策）。
 *
 * 之所以一直没人发现：**章节号 `§2` 是存在的**，所以"章节存在性"检查会放行。
 * 错的是"第 2 条"这个**条目级**的指向。
 *
 * ## 两级判据
 *
 * | 形态 | 判据 |
 * | --- | --- |
 * | `AGENTS.md §N` | 章节 N 必须存在（`## N.` 或 `### N.`） |
 * | `§N 第 M 条` / `§N 决策 M` | 章节 N 里必须有编号为 M 的条目（表格 `\| M \|` 或列表 `M. `） |
 *
 * ⚠️ 只查**结构**，不查"引用的内容是否与原文一致"——后者需要语义理解，不自动化。
 * 但那类错误的后果是"读到了错的理由"，比死链更隐蔽。
 *
 * ## 反例验证
 *
 * 把任一处引用改成 `§3 第 99 条`（不存在）→ 本脚本 exit 1。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-doc-sections.mjs
 * ```
 *
 * @see AGENTS.md §6.2「引用规则」
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const AGENTS = join(ROOT, 'AGENTS.md');

/** 扫描哪些目录/文件里的引用 */
const SCAN_DIRS = ['docs'];
const SCAN_FILES = ['AGENTS-TOOLS.md', 'README.md'];

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
      if (['node_modules', '.git', '.tmp'].includes(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

const agents = readFileSync(AGENTS, 'utf8');
const agentsLines = agents.split('\n');

/**
 * 收集 `AGENTS.md` 的结构：
 *   sections: 章节号 → 标题
 *   items:    章节号 → 该章节下的编号条目集合
 */
const sections = new Map();
const items = new Map();

let cur = null;
for (const line of agentsLines) {
  const m2 = /^## (\d+(?:\.\d+)?)\.?\s+(.*)$/.exec(line);
  const m3 = /^### (\d+(?:\.\d+)?)\s+(.*)$/.exec(line);
  const m = m2 ?? m3;
  if (m) {
    cur = m[1];
    sections.set(cur, m[2].replace(/\*/g, '').trim().slice(0, 40));
    if (!items.has(cur)) items.set(cur, new Set());
    continue;
  }
  if (!cur) continue;
  const row = /^\|\s*(\d+)\s*\|/.exec(line);
  if (row) items.get(cur).add(row[1]);
  const li = /^(\d+)\.\s/.exec(line);
  if (li) items.get(cur).add(li[1]);
}

if (sections.size === 0) {
  console.error('[doc-sections] ❌ 在 AGENTS.md 里没找到任何 `## N.` 章节 —— 结构变了？');
  process.exit(1);
}

// ── 扫描引用 ──

const files = [
  ...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...SCAN_FILES.map((f) => join(ROOT, f)),
];

const badSection = [];
const badItem = [];
let total = 0;

for (const abs of files) {
  let src;
  try {
    src = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const rel = relative(ROOT, abs).split('\\').join('/');
  const lines = src.split('\n');
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // 只查「AGENTS.md §N」形态（不查裸 §N —— 那可能是别的文档自己的章节）
    for (const m of line.matchAll(/AGENTS\.md`?\s*§\s*(\d+(?:\.\d+)?)/g)) {
      total += 1;
      const sec = m[1];
      if (!sections.has(sec)) {
        badSection.push({ file: rel, line: i + 1, sec, text: line.trim().slice(0, 90) });
        continue;
      }
      // 同行还说了「第 M 条 / 决策 M」吗？
      const tail = line.slice(m.index);
      const im = /§\s*\d+(?:\.\d+)?\s*(?:第\s*(\d+)\s*条|决策\s*(\d+))/.exec(tail);
      if (im) {
        const num = im[1] ?? im[2];
        const set = items.get(sec) ?? new Set();
        if (!set.has(num)) {
          badItem.push({
            file: rel,
            line: i + 1,
            sec,
            num,
            available: [...set].sort((a, b) => Number(a) - Number(b)),
            text: line.trim().slice(0, 90),
          });
        }
      }
    }
  }
}

if (badSection.length > 0 || badItem.length > 0) {
  console.error('');
  if (badSection.length > 0) {
    console.error(`[doc-sections] ❌ ${badSection.length} 处引用了不存在的 AGENTS.md 章节\n`);
    for (const b of badSection)
      console.error(`  ${b.file}:${b.line}  §${b.sec} 不存在\n    ${b.text}`);
    console.error(`\n  现存章节：${[...sections.keys()].sort().join(', ')}\n`);
  }
  if (badItem.length > 0) {
    console.error(`[doc-sections] ❌ ${badItem.length} 处引用了该章节里不存在的条目\n`);
    for (const b of badItem) {
      console.error(`  ${b.file}:${b.line}  §${b.sec} 没有第 ${b.num} 条\n    ${b.text}`);
      console.error(
        `    §${b.sec} 现有条目：${b.available.length > 0 ? b.available.join(', ') : '（无编号条目）'}\n`,
      );
    }
    console.error('  ⚠️ 章节存在但条目不存在，是最隐蔽的一类错 —— "§2 第 2 条"在');
    console.error('     §2（先读什么）里根本不存在，那句话实际在 §3 决策 2。\n');
  }
  process.exit(1);
}

console.log(
  `[doc-sections] ✅ ${String(total)} 处 AGENTS.md 章节引用全部指向真实位置` +
    `（${String(sections.size)} 个章节）`,
);
