#!/usr/bin/env node
/**
 * DNR 回归凭据检查 —— 改了 `dnr.ts` 就必须**真的**跑过两个回归脚本（2026-10-30）
 *
 * ## 这条规则原文（AGENTS.md §4.3）
 *
 * > `src/platform/http/dnr.ts` → **重跑两个脚本**：`run-q2-auto.cjs`（约 3 分钟）
 * > **和** `dnr-disable-clears-tab-rules.cjs`（约 15 秒）。**两个都不需要登录态**。
 *
 * ## 为什么 `verify` 之前只能提醒
 *
 * 这两个脚本要启动真实浏览器，属于用户环境操作。**代跑会变成"看起来验过了"** ——
 * 这是设计上正确的取舍，但它导致：`verify` 全绿**不代表** DNR 回归跑过了。
 * 提醒很容易被忽略，于是这条规则实际上**没有任何保障**。
 *
 * ## 现在怎么保证
 *
 * DNR 脚本跑完会写一份凭据（`.tmp/dnr-regression-stamp.json`），记录
 * 「哪个脚本、什么时候、当时 dnr.ts 的内容指纹」。
 *
 * 本检查：
 * | 情况 | 结果 |
 * | --- | --- |
 * | `dnr.ts` 无未提交改动 | ✅ 跳过（回归是"改动时"的义务） |
 * | 有改动 + 两个脚本的凭据都在且指纹匹配 | ✅ 通过 |
 * | 有改动 + 凭据缺失 | ❌ 失败 |
 * | 有改动 + 凭据指纹不匹配（改完又没重跑） | ❌ 失败 |
 *
 * ## 信任级别说明
 *
 * 这是**诚实性约定**，不是防作弊 —— 和 git pre-commit 钩子同一级别。
 * 它能拦住"忘了跑"，拦不住"故意伪造"。后者不归自动化管。
 *
 * ## 反例验证
 *
 * 1. 改 `dnr.ts` 但不跑回归 → 本脚本 exit 1
 * 2. 跑完两个脚本后再改 `dnr.ts` → 凭据指纹过期 → exit 1
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-dnr-regression.mjs
 * ```
 *
 * @see poc/verify/dnr-stamp.mjs 凭据的读写实现
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const TARGET = 'src/platform/http/dnr.ts';
const STAMP_REL = '.tmp/dnr-regression-stamp.json';

/** 两个都必须跑的脚本 */
const REQUIRED = [
  { name: 'run-q2-auto', cmd: 'node poc/verify/run-q2-auto.cjs', cost: '约 3 分钟' },
  {
    name: 'dnr-disable-clears-tab-rules',
    cmd: 'node poc/verify/dnr-disable-clears-tab-rules.cjs',
    cost: '约 15 秒',
  },
];

function hasUncommittedChange() {
  try {
    const r = execSync(`git status --porcelain -- ${TARGET}`, { cwd: ROOT, encoding: 'utf8' });
    return r.trim().length > 0;
  } catch {
    // git 不可用时保守处理：不阻断（否则在非 git 环境里 verify 永远红）
    return false;
  }
}

function fingerprint() {
  const abs = join(ROOT, TARGET);
  if (!existsSync(abs)) return 'missing';
  return createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
}

// ── 主流程 ──

if (!hasUncommittedChange()) {
  console.log(`[dnr-regression] ✅ ${TARGET} 无未提交改动，无需回归`);
  process.exit(0);
}

const stampAbs = join(ROOT, STAMP_REL);
const current = fingerprint();

let stamp = null;
if (existsSync(stampAbs)) {
  try {
    stamp = JSON.parse(readFileSync(stampAbs, 'utf8'));
  } catch {
    stamp = null;
  }
}

/** 凭据是否覆盖当前 dnr.ts 内容 */
const fresh = stamp && stamp.fingerprint === current;
const scripts = fresh ? (stamp.scripts ?? {}) : {};

const missing = REQUIRED.filter((r) => !scripts[r.name]);

if (missing.length === 0 && fresh) {
  const when = scripts['run-q2-auto']?.at ?? '';
  console.log(
    `[dnr-regression] ✅ ${TARGET} 有改动，两个回归脚本的凭据齐全（指纹 ${current}，跑于 ${when}）`,
  );
  process.exit(0);
}

console.error('');
console.error(`[dnr-regression] ❌ ${TARGET} 有未提交改动，但 DNR 回归没跑全\n`);

if (stamp && !fresh) {
  console.error(`  凭据已过期：它记录的是指纹 ${String(stamp.fingerprint)}，`);
  console.error(`  而 dnr.ts 现在是 ${current} —— 说明"跑完之后又改了代码"。\n`);
}

if (missing.length > 0) {
  console.error('  还缺这些脚本的凭据：');
  for (const m of missing) {
    console.error(`    - ${m.name}  （${m.cost}）`);
    console.error(`      ${m.cmd}`);
  }
  console.error('');
}

console.error('  为什么要这样卡：单测测不到 DNR 行为（AGENTS.md §5.4），');
console.error('  而 DNR 规则写错的后果是「画质静默异常，而 popup 上一切正常」——');
console.error('  能骗过用户的 bug，比报错严重。');
console.error('');
console.error('  ⚠️ 这两个脚本**不需要登录态**，各跑一次即可，跑完自动写凭据。');
console.error(`  凭据文件：${STAMP_REL}（本地验证状态，不进版本库）\n`);

process.exit(1);
