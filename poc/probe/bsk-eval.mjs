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
 * node poc/probe/bsk-eval.mjs <session> <tabId> <file.js> [context] [expectJson]
 * ```
 * 文件中写一个表达式（IIFE），脚本把它作为表达式传给 bsk。
 *
 * ## 0.5.0 起：`evaluate` 必须带 `--context`，并二选一给观测依据
 *
 * `evaluate` 是"任意脚本"，bsk 无法判断它读什么，所以它**不属于** target policy
 * 放宽的那一档（放宽的是有 DOM 目标的动作）：
 *
 * | 给什么 | 语义 | 对 B站页可用？ |
 * | --- | --- | --- |
 * | `--observation <id>` | 整页**一次性严格**观测，页面一变动就作废 | ❌ `document_changed` |
 * | `--expect '<facts>'`，省略 observation | 只校验声明的那几条事实，其余页面随便变 | ✅ |
 *
 * 本项目所有探针都跑在**持续变化**的 B站页上 ⇒ 只有后者可用。
 * 默认事实取 `body exists`（读页面 JS 的探针不依赖具体业务内容）；
 * 要校验业务事实就显式传第 5 个参数。
 *
 * `context` 从 `bsk open` / `bsk sync` 的 `ctx` 字段取（`c1` 这种短别名）。
 *
 * ## 纪律
 *
 * - **只读**：本探针不点视频、不发写请求、不登录登出
 * - 不打印凭据：`bsk evaluate` 拿到的响应已在页面侧过滤
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [sid, tab, file, context, expectJson] = process.argv.slice(2);
if (!sid || !tab || !file) {
  console.error('用法: node bsk-eval.mjs <session> <tabId> <expr-file> [context] [expectJson]');
  console.error('  context 取 `bsk open` / `bsk sync` 返回的 ctx（如 c1）；0.5.0 起必填。');
  process.exit(2);
}

const DEFAULT_EXPECT = '[{"target":"body","field":"exists","equals":true}]';
const expr = readFileSync(file, 'utf8').trim();

const args = ['evaluate', '--session', sid, '--tab-id', tab];
if (context) args.push('--context', context, '--expect', expectJson ?? DEFAULT_EXPECT);
args.push(expr);

try {
  const out = execFileSync('bsk', args, {
    encoding: 'utf8',
    env: { ...process.env, BSK_AUTO_START: '0' },
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(out);
} catch (e) {
  const err = e;
  if (err.stdout) process.stdout.write(err.stdout);
  if (err.stderr) process.stderr.write(err.stderr);
  if (!context) {
    process.stderr.write(
      '\n提示：0.5.0 起 `bsk evaluate` 需要 --context（从 `bsk open`/`bsk sync` 的 ctx 取），' +
        '否则会被拒为 "requires a valid control context"。\n',
    );
  }
  process.exit(1);
}
