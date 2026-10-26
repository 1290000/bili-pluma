#!/usr/bin/env node
/**
 * 设计令牌引用边界检查。
 *
 * ## 为什么需要这个脚本
 *
 * `src/design/tokens.css` 是**视觉的唯一真相源**，属于 UI 概念。
 * 业务层（`shared` / `core` / `platform`）不该知道"颜色"和"字号"——
 * 一旦 `core/` 里出现设计令牌，它就没法在 Node 里测了（要读 CSS），分层会从内部塌掉。
 *
 * `docs/04-project-structure.md` §4 明确写着这条规则，
 * 但也白纸黑字承认：**「这条尚未加进 ESLint 配置（当前没有跨层引用 design 的情况），加的时候记得补」**。
 *
 * 这个脚本就是来补那个"记得补"。规则只允许 `entrypoints/*` 引用 `@design/*`。
 *
 * ## 检查什么
 *
 * 扫描 `shared` / `core` / `platform` 下的 .ts/.tsx：
 *   - 静态 import / export from '@design/…'
 *   - 动态 import('@design/…')
 *   - 相对路径的 '../design/…'（绕过别名）
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-design-imports.mjs
 * ```
 *
 * 有违规时退出码 1。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

/** 禁止引用 design 的目录（相对仓库根） */
const FORBIDDEN_DIRS = ['src/shared', 'src/core', 'src/platform'];

/** 允许引用的目录 —— 仅供文档化，不参与扫描 */
const ALLOWED_DIR_NOTE = 'entrypoints/*';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * 命中就违规的四类写法。
 *
 * ⚠️ 正则直接扫原文，**不做注释掩码**——因为 import 语句极少写在注释里，
 * 而掩码逻辑一旦有 bug，可能把真违规一起掩掉。这里宁可极少数误报（注释里写示例），
 * 也不接受漏报。若真出现"注释里提到 @design 被误报"，改成 `mask` 即可。
 *
 * ⚠️ **副作用导入必须单独一条规则。** `import '@design/tokens.css'` 没有 `from`，
 * 2026-10-26 实装时第一版漏了它，反例验证当场抓到（注入后脚本仍报通过）。
 * 这是整个脚本最容易再犯的错——加规则时先问"这种写法有没有 from"。
 */
const RULES = [
  {
    id: 'side-effect-import',
    // import '@design/x'  /  import "@design/x"
    re: /(?:^|[\s;}])import\s*['"](@design\/[^'"]+)['"]/g,
    label: "副作用 import '@design/…'（无 from）",
    hint: '设计令牌属于 UI 层。业务层要用，改成通过参数注入，或把该值挪进 shared/constants。',
  },
  {
    id: 'static-import',
    // import x from '@design/x'  /  export { a } from '@design/x'
    re: /(?:^|[\s;}])(?:import|export)\s[^;']*?from\s*['"](@design\/[^'"]+)['"]/g,
    label: "静态 import/export from '@design/…'",
    hint: '设计令牌属于 UI 层。业务层要用，改成通过参数注入，或把该值挪进 shared/constants。',
  },
  {
    id: 'dynamic-import',
    re: /import\s*\(\s*['"](@design\/[^'"]+)['"]\s*\)/g,
    label: "动态 import('@design/…')",
    hint: '同上。动态 import 也绕不过分层规则。',
  },
  {
    id: 'relative-path',
    // 任何位置出现的 '../design/…' 或 './design/…' 字符串都算。
    // ⚠️ 不强制 from —— 相对路径同样可能是副作用导入（`import '../design/tokens.css'`）。
    // 2026-10-26 实测：第一版写了 from 要求，该写法漏报。
    re: /['"](\.{1,2}\/(?:[^'"]*\/)?design\/[^'"]+)['"]/g,
    label: '相对路径引用 design/',
    hint: '相对路径绕过别名同样违反规则。改用 @design/ 之外的方式，或确认这行属于 entrypoints/。',
  },
];

/**
 * 递归收集文件（不跟随 node_modules，跳过隐藏目录）。
 *
 * @param {string} dir
 * @param {string[]} acc
 * @returns {Promise<string[]>}
 */
async function collect(dir, acc = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await collect(full, acc);
    } else if (SOURCE_EXT.has(ent.name.slice(ent.name.lastIndexOf('.')))) {
      acc.push(full);
    }
  }
  return acc;
}

function lineAndColumn(src, index) {
  const before = src.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return { line, column };
}

async function main() {
  const files = (await Promise.all(FORBIDDEN_DIRS.map((d) => collect(join(ROOT, d))))).flat();

  const violations = [];
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    if (!raw.includes('design')) continue; // 快速跳过，绝大多数文件不含这个词

    const rawLines = raw.split('\n');
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of raw.matchAll(rule.re)) {
        const idx = m.index ?? 0;
        const { line, column } = lineAndColumn(raw, idx);
        violations.push({
          file: relative(ROOT, file).split(sep).join('/'),
          line,
          column,
          label: rule.label,
          hint: rule.hint,
          snippet: (rawLines[line - 1] ?? '').trim().slice(0, 90),
        });
      }
    }
  }

  // 同一位置可能被多条规则命中，去重
  const seen = new Set();
  const unique = violations.filter((v) => {
    const key = `${v.file}:${v.line}:${v.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[design] 扫描 ${files.length} 个文件（${FORBIDDEN_DIRS.join(', ')}）`);
  console.log(`[design] 规则：只允许 ${ALLOWED_DIR_NOTE} 引用 @design/*`);

  if (unique.length === 0) {
    console.log('[design] ✅ 无越层引用');
    return;
  }

  console.error(`\n[design] ❌ 发现 ${unique.length} 处越层引用\n`);
  for (const v of unique.sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line))) {
    console.error(`  ${v.file}:${v.line}:${v.column}  ${v.label}`);
    console.error(`    ${v.snippet}`);
    console.error(`    → ${v.hint}\n`);
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[design] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
