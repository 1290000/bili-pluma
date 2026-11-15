/**
 * 静态穷举守卫：`data.logsMeta.X` 的直接链式访问一律红（task-28 判据 D / Lead 硬要求 ii）。
 *
 * 判据：整个 `src/content/panel/` 下，`logsMeta` 后面**紧跟 `.` 或 `[`** 的二次访问
 * 只允许出现在两个地方：
 *   1. 绑定点本身（`data.logsMeta ?? …` —— 这里是"取"，不是"解引用"）
 *   2. `describeLogsMetaFallback()` 函数体内部
 *
 * 为什么这条比"跑一遍用例"强：它是**穷举式**的，不依赖我想到哪个输入形状。
 * engineer 将来在别处新加一行 `data.logsMeta.count` 照样红。
 *
 * ⚠️ 这条本身必须带 RV（Lead 硬要求 ii）：插一行 `const x = data.logsMeta.count;`
 * 必须真红。否则它就是个恒绿的摆设。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ## 怎么找仓库根（踩了三坑）
 *
 * 探针 config 把 `root` 设成了本探针目录，于是：
 * 1. `import.meta.url` 不再是 `file:` 方案 → `fileURLToPath` 抛 `The URL must be of scheme file`
 * 2. `process.cwd()` 也不是探针目录（实测解析出 `D:\src\content\panel`）
 * 3. `import.meta.dirname` 在本环境不可用
 *
 * 所以用 `require.resolve` 定位本测试文件自身 —— Node 自己知道它在哪。
 */
const HERE = dirname(createRequire(import.meta.url).resolve(import.meta.filename ?? process.argv[1] ?? ''));
const ROOT = join(HERE, '..', '..', '..');
const PANEL_DIR = join(ROOT, 'src/content/panel');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** 剥注释，但**保留行号**（用空格替换，长度不变） */
function stripCommentsKeepLines(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        mode = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    // block
    if (c === '*' && n === '/') {
      mode = 'code';
      out += '  ';
      i += 2;
      continue;
    }
    out += c === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}

/** 找出所有 `logsMeta` 后紧跟 `.` 或 `[` 的位置 */
function chainAccesses(code: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  const re = /logsMeta\s*(?:[.?\[])/g;
  for (const m of code.matchAll(re)) {
    const idx = m.index ?? 0;
    // 排除绑定点：`logsMeta ?? foo()` 被上面的 `?` 命中了，但那不是解引用
    const after = code.slice(idx, idx + 40);
    // 排除类型声明里的可选标记：`logsMeta?: LogsMeta` 里的 `?` 后面跟的是类型名，
    // 不是解引用（但它确实匹配了 `logsMeta\s*[.?]`，所以单独放行）
    if (/^logsMeta\?:\s/.test(after)) continue;
    if (/^logsMeta\s*\?\?/.test(after)) continue;
    const line = code.slice(0, idx).split('\n').length;
    const lineText = code.split('\n')[line - 1]?.trim() ?? '';
    hits.push({ line, text: lineText });
  }
  return hits;
}

describe('静态穷举 · `data.logsMeta.X` 链式访问', () => {
  it('整个 src/content/panel/ 里不允许出现（fallback 内部与绑定点除外）', () => {
    const files = walk(PANEL_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length, 'src/content/panel/ 下没扫到 .ts 文件，路径坏了').toBeGreaterThan(5);

    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split('\\').join('/');
      const code = stripCommentsKeepLines(readFileSync(file, 'utf8'));
      for (const hit of chainAccesses(code)) {
        violations.push(`${rel}:${String(hit.line)}  ${hit.text}`);
      }
    }

    expect(
      violations,
      `禁止 data.logsMeta.X 的链式二次访问 —— 必须先收敛成 meta 变量：\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
