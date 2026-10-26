#!/usr/bin/env node
/**
 * 文档一致性检查 —— 把 `docs/README.md` §「文档检查命令」里那段散装 bash 固化。
 *
 * ## 为什么需要这个脚本
 *
 * `AGENTS.md` §6.3 规定「改完文档必跑两项检查」，`docs/README.md` 给了实现，
 * 但那是一段**要人手动复制粘贴的 bash**。而本项目出过两次事故：
 *
 *   - 一次自检修出 **11 处矛盾**（两套实施路线、两个 `## 13`、3 个缺失文件、4 处悬空引用）
 *   - 一次发现 `docs/README.md` 自己写着「Q4 未做」，而 `03` §0 写着「Q4 已实测」
 *
 * 散装命令的问题是：**要先想起来去跑它**。固化成一个命令、并进 `verify` 链，才是真防住。
 *
 * ## 检查三项
 *
 * 1. **死链**：`[text](./relative/path)` 指向的文件必须存在
 * 2. **章节编号连号**：`## N` 必须从 0 起、步长为 1、不许重复
 * 3. **只读引用完整性**：被 `AGENTS.md` / `docs/` 引用的文件必须真实存在（由 1 覆盖）
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-docs.mjs
 * ```
 *
 * 有违规时退出码 1。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = process.cwd();

/** 参与检查的 Markdown 文件（相对仓库根，glob 在代码里手写以保持零依赖） */
const SCAN_TARGETS = ['README.md', 'AGENTS.md', 'ADDITIONAL-TERMS.md', 'docs'];

/** 章节编号检查只针对这几份主文档 —— 子目录文件（ADR/guides）不按 `## N` 编号 */
const NUMBERED_DOCS = [
  'docs/01-architecture.md',
  'docs/02-ui-spec.md',
  'docs/03-open-questions.md',
  'docs/04-project-structure.md',
];

/**
 * 递归收集 Markdown。
 *
 * @param {string} target 相对路径（文件或目录）
 * @returns {Promise<string[]>} 绝对路径
 */
async function collectMarkdown(target) {
  const abs = join(ROOT, target);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return abs.endsWith('.md') ? [abs] : [];

  const out = [];
  const entries = await readdir(abs, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = join(abs, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectMarkdown(relative(ROOT, full))));
    } else if (ent.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 找出所有相对链接目标，校验文件是否存在。
 *
 * 只检查 `./` 与 `../` 开头的相对链接——绝对 URL（http/https）与纯锚点（#）跳过。
 * 带 `#锚点` 的会先剥掉锚点再判文件。
 *
 * @param {string} fileAbs
 * @param {string} src
 * @returns {Promise<Array<{line:number, link:string, raw:string}>>}
 */
async function checkLinks(fileAbs, src) {
  const dir = dirname(fileAbs);
  const lines = src.split('\n');
  const dead = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // ![alt](path) 与 [text](path) 都算；排除 ![](http…)
    for (const m of line.matchAll(/\]\((\.\.?\/[^)\s]*)\)/g)) {
      const link = m[1];
      const withoutAnchor = link.split('#')[0];
      if (!withoutAnchor) continue;

      // 链接可能带行内 title：`path "title"`
      const pure = withoutAnchor.split(/\s+/)[0] ?? withoutAnchor;
      const target = resolve(dir, pure);

      try {
        await stat(target);
      } catch {
        dead.push({ line: i + 1, link: pure, raw: line.trim().slice(0, 90) });
      }
    }
  }
  return dead;
}

/**
 * 章节编号连号检查。
 *
 * 规则：`## N` 出现的序列必须严格等于 0,1,2,…N（允许从 0 开始）。
 * 本项目所有主文档都从 `## 0.` 开始，所以起点固定为 0。
 *
 * @param {string} src
 * @returns {Array<{line:number, issue:string, actual:string}>}
 */
function checkNumbering(src) {
  const lines = src.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^## (\d+)[.、\s]/.exec(lines[i] ?? '');
    if (m) found.push({ line: i + 1, num: Number(m[1]), raw: (lines[i] ?? '').slice(0, 60) });
  }

  const issues = [];
  const seen = new Map();
  for (let k = 0; k < found.length; k += 1) {
    const cur = found[k];
    if (seen.has(cur.num)) {
      issues.push({
        line: cur.line,
        issue: `编号 ${cur.num} 重复（首次出现在第 ${seen.get(cur.num)} 行）`,
        actual: cur.raw,
      });
      continue;
    }
    seen.set(cur.num, cur.line);

    if (cur.num !== k) {
      issues.push({
        line: cur.line,
        issue: `编号不连号：第 ${k + 1} 个 ## 章节应为 ${k}，实际是 ${cur.num}`,
        actual: cur.raw,
      });
    }
  }
  return issues;
}

async function main() {
  const files = (await Promise.all(SCAN_TARGETS.map(collectMarkdown))).flat();
  const uniqueFiles = [...new Set(files)];

  const deadLinks = [];
  const numberingIssues = [];

  for (const file of uniqueFiles) {
    const src = await readFile(file, 'utf8');
    const rel = relative(ROOT, file).split(sep).join('/');

    for (const d of await checkLinks(file, src)) {
      deadLinks.push({ file: rel, ...d });
    }

    if (NUMBERED_DOCS.includes(rel)) {
      for (const n of checkNumbering(src)) {
        numberingIssues.push({ file: rel, ...n });
      }
    }
  }

  console.log(`[docs] 扫描 ${uniqueFiles.length} 个 Markdown`);
  console.log(`[docs] 死链检查 + ${NUMBERED_DOCS.length} 份主文档的章节连号检查`);

  if (deadLinks.length === 0 && numberingIssues.length === 0) {
    console.log('[docs] ✅ 无死链、章节编号连号');
    return;
  }

  if (deadLinks.length > 0) {
    console.error(`\n[docs] ❌ ${deadLinks.length} 处死链\n`);
    for (const d of deadLinks) {
      console.error(`  ${d.file}:${d.line}  → ${d.link}`);
      console.error(`    ${d.raw}\n`);
    }
  }

  if (numberingIssues.length > 0) {
    console.error(`\n[docs] ❌ ${numberingIssues.length} 处章节编号问题\n`);
    for (const n of numberingIssues) {
      console.error(`  ${n.file}:${n.line}  ${n.issue}`);
      console.error(`    ${n.actual}\n`);
    }
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[docs] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
