#!/usr/bin/env node
/**
 * `AGENTS-TOOLS.md` 的完整性检查 —— **每个工具都必须有登记处**
 *
 * ## 为什么需要它
 *
 * 2026-10-30 发现一个真实的失败模式：`poc/probe/reload-extension.mjs`
 * （能自动重载扩展）在 `AGENTS.md` 里**一次都没被提到**，
 * 只躺在 `docs/guides/browser-skill-setup.md` 里。
 *
 * 后果：**团队里没人记得它存在**，每次改完 `src/` 都去手工点「重新加载」——
 * 而这本该是 30 秒的事。
 *
 * 根因不是「文档太长导致没看到」，是 **清单本身不完整**：
 * `AGENTS.md` 提到了 `check-messages` / `check-patch-scope` 等 8 个脚本，
 * 却漏了这一个。没有机制会告诉你"你漏登记了一个工具"。
 *
 * 所以：**把「记得登记」变成机器检查。**
 *
 * ## 判据（不是"所有文件都必须在文档里"）
 *
 * | 范围 | 要求 |
 * | --- | --- |
 * | `scripts/*.mjs` / `*.ts` | 必须在 `AGENTS-TOOLS.md` 出现（它们是验收入口，人人要跑） |
 * | `poc/probe/*`、`poc/verify/*` | 同上 |
 * | 显式豁免（见 `WAIVED`） | 历史 PoC / 一次性探针，写清理由 |
 *
 * ⚠️ **不许把豁免列表当垃圾桶**：每加一条都要写理由 + 日期。
 * 豁免列表膨胀说明这个检查失去了意义，那时应当反过来收敛检查范围。
 *
 * ## 反例验证
 *
 * 往 `poc/probe/` 放一个新 `.mjs` 而不更新 `AGENTS-TOOLS.md` → 本脚本必须
 * 以 exit 1 报出那个文件名。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-tools.mjs
 * ```
 *
 * @see AGENTS-TOOLS.md
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TOOLS_DOC = join(ROOT, 'AGENTS-TOOLS.md');

/**
 * 显式豁免：**历史 PoC / 一次性探针**，不进清单。
 *
 * 判据是「它还会不会被再跑一次」。不会 → 豁免；会 → 必须登记。
 * 每条都要写理由，不许只写文件名。
 */
const WAIVED = new Map([
  // 2026-10-30 加：DNR 回归凭据的读写模块，被两个 DNR 脚本 import，
  // 不是给人直接跑的。它的作用见 scripts/check-dnr-regression.mjs。
  [
    'poc/verify/dnr-stamp.mjs',
    '被 run-q2-auto / dnr-disable-clears-tab-rules import 的凭据模块，不单独跑',
  ],
  // 2026-10-30 建档：这些是早期 Q3 / e2e 阶段的一次性脚本，结论已写进 docs/ 与 ADR。
  // 保留文件是为了可追溯，但不需要日常使用指引。
  ['poc/probe/probe-cdp.mjs', '早期 CDP 探针；已确认 CDP 拿不到登录态，改走 bsk'],
  ['poc/probe/probe-edge.mjs', '早期 Edge 探针；结论已并入 browser-skill-setup.md'],
  ['poc/probe/probe-badge.mjs', '角标调试；一次性定位'],
  ['poc/probe/probe-pgc-full-cfg.cjs', 'P2 取流形态调查；结论已进 ADR 0019'],
  ['poc/probe/probe-pgc-is-preview.cjs', '试看标记调查；结论已进 ADR 0021'],
  ['poc/probe/probe-pgc-prefetch-inplace.cjs', 'in-place 替换调查；结论已进 ADR 0020'],
  ['poc/probe/probe-pgc-takeover.cjs', '接管时机调查；结论已进 ADR 0020'],
  ['poc/probe/probe-pgc-timing.cjs', '时序测量；结论已进 ADR 0020'],
  ['poc/verify/audit-identity.cjs', '1.0.0 身份审计；一次性'],
  ['poc/verify/diag-qr-quality.cjs', '扫码画质诊断；一次性'],
  ['poc/verify/e2e-8k.cjs', '8K 端到端；一次性验收'],
  ['poc/verify/e2e-dnr-playurl.cjs', 'DNR playurl 端到端；已被 run-q2-auto 覆盖'],
  ['poc/verify/e2e-dual.cjs', '双账号端到端；一次性验收'],
  ['poc/verify/e2e-hdr.cjs', 'HDR 端到端；一次性验收'],
  ['poc/verify/e2e-login.cjs', '登录端到端；一次性验收'],
  ['poc/verify/e2e-page.cjs', '页面端到端；一次性验收'],
  ['poc/verify/e2e-scan.cjs', '扫码端到端；一次性验收'],
  ['poc/verify/e2e-vault.cjs', 'vault 端到端；一次性验收'],
  ['poc/verify/poc-hook-createplayer.cjs', 'createPlayer hook 验证；结论已进 ADR 0020'],
  ['poc/verify/poc-hook-playinfo.cjs', 'playinfo hook 验证；结论已进 ADR 0020'],
  ['poc/verify/poc-pgc-inject.cjs', 'PGC 注入验证；结论已进 ADR 0020'],
  ['poc/verify/poc-pgc-reqplayurl.cjs', 'PGC 取流验证；结论已进 ADR 0019'],
  ['poc/verify/q3-interaction.cjs', 'Q3 交互验证；一次性'],
  ['poc/verify/q3b-quality-switch.cjs', 'Q3b 画质切换验证；一次性'],
]);

/** 收集某目录下所有可执行脚本（不递归子目录以外的深层） */
function listScripts(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => /\.(mjs|cjs|ts)$/.test(f))
    .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => `${dir}/${f}`);
}

const candidates = [
  ...listScripts('scripts'),
  ...listScripts('poc/probe'),
  ...listScripts('poc/verify'),
];

if (!existsSync(TOOLS_DOC)) {
  console.error('[check-tools] ❌ 找不到 AGENTS-TOOLS.md —— 它是脚本清单的唯一权威位置');
  process.exit(1);
}

const doc = readFileSync(TOOLS_DOC, 'utf8');

const missing = [];
const waivedButListed = [];

for (const rel of candidates) {
  const base = rel.split('/').pop();
  // 文档里出现文件名即算登记（不强制写全路径 —— 清单里用短名更好读）
  const listed = doc.includes(base);
  const waived = WAIVED.has(rel);

  if (!listed && !waived) missing.push(rel);
  if (listed && waived) waivedButListed.push(rel);
}

// ── 报告 ──

if (waivedButListed.length > 0) {
  console.log('[check-tools] ⚠️  以下文件既在豁免表里、又出现在文档里：');
  for (const f of waivedButListed) console.log(`  - ${f}（从 WAIVED 移除即可）`);
}

if (missing.length > 0) {
  console.error(`[check-tools] ❌ ${String(missing.length)} 个脚本没有在 AGENTS-TOOLS.md 登记：`);
  for (const f of missing) console.error(`  - ${f}`);
  console.error('');
  console.error('  要么在 AGENTS-TOOLS.md 里加一行「我要做 X → 命令」；');
  console.error('  要么在 scripts/check-tools.mjs 的 WAIVED 里写明「为什么它不会被再跑」，');
  console.error('  并附日期。**不许把 WAIVED 当垃圾桶。**');
  process.exit(1);
}

// 豁免表里指向不存在的文件 —— 说明脚本被删了却没清豁免
const deadWaivers = [...WAIVED.keys()].filter((f) => !existsSync(join(ROOT, f)));
if (deadWaivers.length > 0) {
  console.error(`[check-tools] ❌ WAIVED 里有 ${String(deadWaivers.length)} 条指向不存在的文件：`);
  for (const f of deadWaivers) console.error(`  - ${f}`);
  console.error('  脚本删了就把豁免也删掉。');
  process.exit(1);
}

console.log(
  `[check-tools] ✅ ${String(candidates.length)} 个脚本全部有归属` +
    `（登记 ${String(candidates.length - WAIVED.size)} / 豁免 ${String(WAIVED.size)}）`,
);
