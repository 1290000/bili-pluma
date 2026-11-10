#!/usr/bin/env node
/**
 * CSS 自定义属性（设计令牌）存在性检查。
 *
 * ## 为什么需要这个脚本
 *
 * `src/design/tokens.css` 是视觉的唯一真相源，但 CSS 有一条**静默失败**的机制：
 *
 * ```css
 * color: var(--pluma-not-exist, red);
 * ```
 *
 * 写错一个 token 名，浏览器不会报错 —— 它会安静地用 fallback 值 `red`。
 * 于是代码"看起来能用"，但：
 *   1. 日后改主题**不会**跟着变（这一处是硬编码的）
 *   2. 没有任何检查会告诉你有问题
 *
 * 这个坑 2026-11-10 真实踩过：`entrypoints/need-incognito/style.css` 写了
 * `var(--pluma-success, #2e7d32)` 与 `var(--pluma-warning-bg, #fff4e5)`，
 * 而这两个 token 在 `tokens.css` 里**根本不存在**。`check-design-imports.mjs`
 * 只管"谁能 import `@design/*`"，管不到变量名。
 *
 * ## 判据
 *
 * 1. 从 `src/design/tokens.css` 解析出所有 `--xxx:` 定义（全局可用）
 * 2. 扫描 `src/**`、`entrypoints/**` 下每个 `.css` 里的 `var(--xxx)`
 * 3. 引用了**既不在 tokens.css、也不在本文件内定义**的变量 → 报错
 *
 * ## 三个必须处理的细节（都是会让这项检查变成"假检查"的地方）
 *
 * - **`var(--x, #fff)` 的 fallback 形态必须照查。** 这正是踩过的形态：
 *   fallback 让错误看起来"能跑"，最容易被放过。**有 fallback 不是豁免理由。**
 * - **同文件内定义的局部变量不报错。** 组件自己写 `--local-gap: 8px` 再用
 *   `var(--local-gap)` 是合法的。只看"本文件有没有定义过它"。
 * - **注释里的 `var()` 跳过。** 但**掩码逻辑必须有反例验证** —— 掩码写坏了会把
 *   真违规一起掩掉，那就是最糟的"假绿"。见本文件末尾的 maskCssComments 说明。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-css-tokens.mjs
 * ```
 *
 * 有违规时退出码 1。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

/** 令牌定义的唯一真相源 */
const TOKENS_FILE = 'src/design/tokens.css';

/** 要扫描引用的目录（相对仓库根） */
const SCAN_DIRS = ['src', 'entrypoints'];

/**
 * 把 CSS 注释替换成等长空白。
 *
 * ⚠️ **必须等长**：报错要给出准确的行号与列号，长度一变位置就全错了。
 *
 * ⚠️ **这个函数是整项检查最容易写坏的地方**：如果它多吞了字符，
 * 真实的 `var(--bad)` 会被一起掩掉 → 检查静默变绿 → 比没有检查更糟。
 * 所以它是纯函数、可单独测，且反例验证里专门有一条"注释后的真违规仍被抓到"。
 *
 * 处理两种注释：
 *   - 块注释 `/* … *\/`（可跨行）
 *   - 行注释 `// …`（在 CSS 里不是标准语法，但 Sass/Less 与手写时会出现）
 *
 * @param {string} css
 * @returns {string} 与输入**等长**的字符串，注释内容被空格覆盖
 */
function maskCssComments(css) {
  const out = css.split('');
  let i = 0;
  while (i < css.length) {
    // 块注释
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      for (let k = i; k < stop; k++) {
        if (out[k] !== '\n') out[k] = ' ';
      }
      i = stop;
      continue;
    }
    // 行注释
    if (css[i] === '/' && css[i + 1] === '/') {
      const end = css.indexOf('\n', i);
      const stop = end === -1 ? css.length : end;
      for (let k = i; k < stop; k++) out[k] = ' ';
      i = stop;
      continue;
    }
    // 字符串里的 // 不是注释（如 url("http://…")）——跳过整段字符串
    if (css[i] === '"' || css[i] === "'") {
      const quote = css[i];
      let k = i + 1;
      while (k < css.length && css[k] !== quote) {
        if (css[k] === '\\') k++; // 转义
        k++;
      }
      i = k + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

function lineAndColumn(src, index) {
  const before = src.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return { line, column };
}

/**
 * 递归收集 .css 文件（不跟随 node_modules，跳过隐藏目录）。
 *
 * @param {string} dir
 * @param {string[]} acc
 * @returns {Promise<string[]>}
 */
async function collectCss(dir, acc = []) {
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
      await collectCss(full, acc);
    } else if (/\.css$/i.test(ent.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** 匹配所有 `var(--name` 形式（含带 fallback 的） */
const VAR_REF_RE = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/** 匹配自定义属性定义 `--name:` */
const DEF_RE = /(^|[\s;{])(--[A-Za-z0-9_-]+)\s*:/g;

/**
 * 从一段 CSS 里取出所有**定义**的变量名。
 *
 * @param {string} css 已经过注释掩码的 CSS
 * @returns {Set<string>}
 */
function definedVarsIn(css) {
  const set = new Set();
  for (const m of css.matchAll(DEF_RE)) set.add(m[2]);
  return set;
}

async function main() {
  // ── 1. 收集全局令牌 ──
  const tokensPath = join(ROOT, TOKENS_FILE);
  let tokensRaw;
  try {
    tokensRaw = await readFile(tokensPath, 'utf8');
  } catch {
    console.error(`[css-tokens] ❌ 找不到 ${TOKENS_FILE} —— 这是令牌的唯一真相源，检查无法进行`);
    process.exitCode = 2;
    return;
  }
  const globalVars = definedVarsIn(maskCssComments(tokensRaw));

  if (globalVars.size === 0) {
    console.error(`[css-tokens] ❌ ${TOKENS_FILE} 里一个 --变量 都没解析到，解析规则可能坏了`);
    process.exitCode = 2;
    return;
  }

  // ── 2. 扫描所有 CSS ──
  const files = (await Promise.all(SCAN_DIRS.map((d) => collectCss(join(ROOT, d))))).flat();

  const violations = [];
  let refCount = 0;

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/');
    // ⚠️ tokens.css 自己不需要检查引用（它只定义）
    if (rel === TOKENS_FILE) continue;

    const raw = await readFile(file, 'utf8');
    const masked = maskCssComments(raw);

    // 本文件内定义的局部变量（组件自己的 --local-x）也算合法
    const localVars = definedVarsIn(masked);

    for (const m of masked.matchAll(VAR_REF_RE)) {
      refCount++;
      const name = m[1];
      if (globalVars.has(name) || localVars.has(name)) continue;

      const idx = m.index ?? 0;
      const { line, column } = lineAndColumn(masked, idx);
      const rawLine = raw.split('\n')[line - 1] ?? '';
      violations.push({
        file: rel,
        line,
        column,
        name,
        snippet: rawLine.trim().slice(0, 100),
      });
    }
  }

  console.log(
    `[css-tokens] ${TOKENS_FILE} 定义 ${globalVars.size} 个令牌；扫描 ${files.length - 1} 个 CSS、${refCount} 处 var() 引用`,
  );

  if (violations.length === 0) {
    console.log('[css-tokens] ✅ 所有 var() 引用的变量都有定义');
    return;
  }

  console.error(`\n[css-tokens] ❌ ${violations.length} 处引用了不存在的 CSS 变量\n`);
  for (const v of violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  )) {
    console.error(`  ${v.file}:${v.line}:${v.column}   ${v.name} 未定义`);
    console.error(`    ${v.snippet}`);
  }
  console.error(
    '\n  ⚠️ 写错变量名**不会**有任何运行时错误 —— CSS 会安静地用 fallback 值（如果有）。' +
      '\n     修法：改成 tokens.css 里真实存在的名字，或在该 CSS 里先定义它。\n',
  );

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(
    `[css-tokens] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 2;
});
