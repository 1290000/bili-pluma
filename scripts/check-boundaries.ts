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

import { maskCommentsAndStrings } from './lib/mask-source';

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
 * ⚠️ 抹白逻辑在 `scripts/lib/mask-source.ts`（2026-11-17 抽出）。
 *
 * 抽出的原因：`tests/unit/content/panel/entry-panel-update-sync.test.ts` 也要用它
 * （断言"某行代码真的会被执行"，被注释掉时必须看不见），而本文件以 `void main()`
 * 结尾、**import 就会跑一遍扫描**，测试不能 import 它。
 *
 * **不要在这里再写一份** —— 两份抹白逻辑会以不同的 bug 方式漂移，
 * 而这个函数的错误是静的（该报的不报 / 不该报的报）。
 */

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
