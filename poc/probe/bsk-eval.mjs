/**
 * 用 Node 调 `bsk evaluate`，**绕开 PowerShell 的引号剥离**。
 *
 * ## 为什么需要这个包装
 *
 * 在 pwsh 里直接写：
 * ```powershell
 * bsk evaluate --session jjpu --tab-id 123 "(async () => { ... })()"
 * ```
 * 表达式里的 `(`, `)`, `[`, `]`, `"`, `'` 会被 PowerShell 的参数解析吃掉，
 * 报 `unexpected argument '.map(a' found` / `SyntaxError: missing )`。
 *
 * `execFileSync('bsk', [ ... ])` 把表达式作为**单个 argv 元素**传下去，
 * 不经过任何 shell 解析 —— 这是唯一可靠的形态。
 *
 * ## 用法
 *
 * ```bash
 * node poc/probe/search-identity/ev.mjs <session> <tabId> <file.js>
 * ```
 * 文件中写一个表达式（IIFE），脚本把它作为表达式传给 bsk。
 *
 * ## 纪律
 *
 * - **只读**：本探针不点视频、不发写请求、不登录登出
 * - 不打印凭据：`bsk evaluate` 拿到的响应已在页面侧过滤
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [sid, tab, file] = process.argv.slice(2);
if (!sid || !tab || !file) {
  console.error('用法: node ev.mjs <session> <tabId> <expr-file>');
  process.exit(2);
}

const expr = readFileSync(file, 'utf8').trim();

try {
  const out = execFileSync('bsk', ['evaluate', '--session', sid, '--tab-id', tab, expr], {
    encoding: 'utf8',
    env: { ...process.env, BSK_AUTO_START: '0' },
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(out);
} catch (e) {
  const err = e;
  if (err.stdout) process.stdout.write(err.stdout);
  if (err.stderr) process.stderr.write(err.stderr);
  process.exit(1);
}
