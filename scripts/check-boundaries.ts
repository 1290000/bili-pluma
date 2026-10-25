/**
 * 分层边界检查 —— ESLint 的补充，不是替代。
 *
 * ## 为什么需要这个脚本
 *
 * ESLint 只能看**静态 import 语句**。下面这些它全看不见：
 *
 * ```ts
 * const c = globalThis['chrome'];        // 动态属性访问
 * const c = (globalThis as any).chrome;  // 类型断言绕过
 * eval('fetch("/api")');                 // 运行时求值
 * ```
 *
 * 而这个项目的分层约束（core 不许碰浏览器）是 192 个单测能在 Node 跑的前提，
 * 一旦被绕过，测试会挂、然后有人去 mock、测试从此失去意义。
 *
 * ## 检查方式
 *
 * 扫 `src/core/` 与 `src/shared/` 下的每个 .ts 文件，找禁止符号出现。
 * 注释和字符串字面量会被跳过（避免"注释里提到 chrome 就报错"的误报）。
 *
 * ## 用法
 *
 * ```bash
 * pnpm check:boundaries
 * ```
 *
 * 有违规时退出码 1，可直接用于 CI。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** 受检查的目录（相对仓库根） */
const CHECKED_DIRS = ['src/core', 'src/shared'];

/**
 * 禁止在 core/shared 出现的符号。
 *
 * ⚠️ 浏览器全局对象的正则是 `\bchrome\b`（不带 `.`）——
 * 因为 `globalThis.chrome` / `('chrome' in x)` / `const c = chrome`
 * 这些形式拿到的是同一个对象，只拦 `chrome.` 会漏掉。
 * （实测踩过：`(globalThis as any).chrome` 就这么绕过去了。）
 */
const FORBIDDEN = [
  { pattern: /\bchrome\b/, label: 'chrome', hint: '请通过接口注入（见 AGENTS.md §5.1）' },
  { pattern: /\bbrowser\s*\./, label: 'browser.*', hint: '请通过接口注入' },
  { pattern: /\bwindow\b/, label: 'window', hint: 'core 应纯逻辑，不碰 DOM' },
  { pattern: /\bdocument\b/, label: 'document', hint: 'core 应纯逻辑，不碰 DOM' },
  { pattern: /\bfetch\s*\(/, label: 'fetch(', hint: 'HTTP 请求应在 platform/http' },
  { pattern: /\blocalStorage\b/, label: 'localStorage', hint: '存储应在 platform/storage' },
  { pattern: /\bsessionStorage\b/, label: 'sessionStorage', hint: '存储应在 platform/storage' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest', hint: 'HTTP 应在 platform/http' },
];

interface Violation {
  file: string;
  line: number;
  column: number;
  label: string;
  hint: string;
  snippet: string;
}

/**
 * 把源码里的注释和字符串替换成等长空白，保持列号不变。
 *
 * 为什么不用正则直接删：删掉会改变列号，报错位置就指错了。
 */
function maskCommentsAndStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // 行注释
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // 块注释
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    // 模板字符串（含 ${} 里的代码保持原样太复杂，整体当字符串处理）
    if (ch === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }

    // 单/双引号字符串
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collectTsFiles(full)));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const violations: Violation[] = [];
  let scanned = 0;

  for (const dir of CHECKED_DIRS) {
    const files = await collectTsFiles(join(root, dir));
    for (const file of files) {
      scanned += 1;
      const raw = await readFile(file, 'utf8');
      const masked = maskCommentsAndStrings(raw);
      const rawLines = raw.split('\n');
      const maskedLines = masked.split('\n');

      for (let li = 0; li < maskedLines.length; li += 1) {
        const line = maskedLines[li] ?? '';
        for (const rule of FORBIDDEN) {
          const m = rule.pattern.exec(line);
          if (!m) continue;
          violations.push({
            file: relative(root, file).replace(/\\/g, '/'),
            line: li + 1,
            column: m.index + 1,
            label: rule.label,
            hint: rule.hint,
            snippet: (rawLines[li] ?? '').trim().slice(0, 80),
          });
        }
      }
    }
  }

  console.log(`[boundaries] 扫描 ${scanned} 个文件（${CHECKED_DIRS.join(', ')}）`);

  if (violations.length === 0) {
    console.log('[boundaries] ✅ 无违规');
    return;
  }

  console.error(`[boundaries] ❌ 发现 ${violations.length} 处违规\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}  ${v.label}`);
    console.error(`    ${v.snippet}`);
    console.error(`    → ${v.hint}\n`);
  }
  process.exitCode = 1;
}

void main();
