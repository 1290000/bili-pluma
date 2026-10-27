#!/usr/bin/env node
/**
 * Workflow 日志安全检查 —— 防止 Actions 日志里出现不该出现的运行时数据。
 *
 * ## 为什么需要它
 *
 * `check-secrets.mjs` 扫的是**文件内容**，而泄露发生在**运行时打印**。
 * 两者不在一个层面，所以那个检查全绿，也证明不了日志干净。
 *
 * 2026-10-27 的真实案例：诊断步骤把 Telegram `getUpdates` 的完整响应打进日志，
 * 里面有每个 chat 的 id、类型、标题 —— 包括私聊对象的名字。
 * 公开仓库的 Actions 日志人人可看，而 `check-secrets` 永远抓不到这种东西。
 *
 * ## 只查 100% 有害、零误报的写法
 *
 * - `set -x` / `set -o xtrace`：把每条命令的变量展开打到 stderr
 * - `printenv` / `env` / `set` 不带参数：打印全部环境变量
 *
 * ## ⚠️ 它查不到什么（这部分只能靠人）
 *
 * `echo "$RESP"`、`cat response.json`、`curl ... | jq` —— 这些会不会泄露，
 * 取决于**响应里有什么**，静态看不出来。判据只有一句：
 *
 *     这个响应里有没有属于别人的字段？
 *
 * 所以改了 `.github/workflows/**` 必须人工过一遍每个打印点，见 AGENTS.md §4.3。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-workflow-logs.mjs
 * ```
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.github/workflows';

/** @type {{ re: RegExp, why: string }[]} */
const RULES = [
  { re: /^\s*set\s+-[a-zA-Z]*x/, why: 'set -x 会把每条命令的变量展开打到 stderr' },
  { re: /^\s*set\s+-o\s+xtrace/, why: 'set -o xtrace 同上' },
  { re: /^\s*printenv\s*$/, why: 'printenv 不带参数会打印全部环境变量' },
  { re: /^\s*env\s*$/, why: 'env 不带参数会打印全部环境变量' },
  { re: /^\s*set\s*$/, why: 'set 不带参数会打印全部 shell 变量' },
];

let files = [];
try {
  files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
} catch {
  console.log('[workflow-logs] 没有 .github/workflows 目录，跳过');
  process.exit(0);
}

/** @type {{ file: string, line: number, text: string, why: string }[]} */
const problems = [];

for (const file of files) {
  const lines = readFileSync(join(DIR, file), 'utf8').split('\n');
  let inRun = false;
  let runIndent = 0;

  lines.forEach((line, i) => {
    // 注意 `- run: |` 前面有列表符号，正则必须容忍；缩进基准取 `run:` 之前那段的长度，
    // 否则 `      - run: |`（8）会被误判成比内容（10）还深，永远进不了检查分支。
    const start = line.match(/^(\s*(?:-\s+)?)run:\s*[|>][-+]?/);
    if (start) {
      inRun = true;
      runIndent = start[1].length;
      return;
    }
    if (!inRun) return;

    // 缩进退回 run 同级或更浅，说明这个 run 块结束了
    const indent = line.match(/^\s*/)[0].length;
    if (line.trim() && indent <= runIndent) {
      inRun = false;
      return;
    }

    for (const rule of RULES) {
      if (rule.re.test(line)) {
        problems.push({ file, line: i + 1, text: line.trim(), why: rule.why });
      }
    }
  });
}

if (problems.length === 0) {
  console.log(`[workflow-logs] ✅ ${files.length} 个 workflow，没有必泄露写法`);
  process.exit(0);
}

console.error('[workflow-logs] ❌ 发现会往 Actions 日志打印敏感数据的写法：\n');
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  ${p.text}`);
  console.error(`    → ${p.why}`);
}
console.error('\n⚠️ 本检查只覆盖 100% 有害的写法。');
console.error('   `echo "$RESP"` / `cat x.json` 这类静态看不出来，必须人工过一遍 ——');
console.error('   判据：这个响应里有没有属于别人的字段？');
process.exit(1);
