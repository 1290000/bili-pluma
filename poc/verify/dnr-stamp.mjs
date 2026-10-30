/**
 * DNR 回归凭据 —— 让「跑过了」这件事**可被 verify 验证**（2026-10-30）
 *
 * ## 为什么需要
 *
 * `AGENTS.md` §4.3 规定：改了 `src/platform/http/dnr.ts` 必须重跑两个 DNR 脚本。
 * 但 `verify` **只能打印提醒**，因为这两个脚本要启动真实浏览器 ——
 * 代跑会变成"看起来验过了"（这是设计上的正确取舍）。
 *
 * 后果：提醒很容易被忽略。`verify` 全绿**不代表** DNR 回归跑过了。
 *
 * ## 办法：显式凭据
 *
 * DNR 脚本跑完后写一份凭据，记录：
 *   - 跑的是哪个脚本
 *   - 什么时候跑的
 *   - 当时 `dnr.ts` 的内容指纹
 *
 * `verify` 检测到 `dnr.ts` 有改动时：
 *   - 凭据不存在 → **失败**（不是警告）
 *   - 凭据存在但指纹对不上（改动后又没重跑）→ **失败**
 *   - 指纹一致 → 通过
 *
 * ## 它解决什么、不解决什么
 *
 * ✅ 解决：改了 `dnr.ts` 却忘了跑回归（凭据缺失/过期会红）
 * ❌ 不解决：伪造凭据。这是**诚实性约定**，不是防作弊机制 ——
 *    和 git 的 pre-commit 钩子同一个信任级别。
 *
 * ## 为什么不放 .gitignore
 *
 * 放 `.tmp/` 且被 gitignore：凭据是**本地验证状态**，不该进版本库
 * （否则 A 机器跑过，B 机器拿去用，就又变成"假绿"了）。
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();

/** 凭据文件位置（`.tmp/` 已在 gitignore / eslint ignores 里） */
export const STAMP_PATH = join(ROOT, '.tmp', 'dnr-regression-stamp.json');

/** 凭据必须覆盖的目标文件 */
const TARGET = 'src/platform/http/dnr.ts';

/**
 * 算 `dnr.ts` 的当前指纹。
 *
 * 用**文件内容**而不是 mtime：mtime 在 git checkout / 复制时会变，
 * 内容不变却判"过期"会制造无谓的重复跑。
 *
 * @returns {string} 8 位十六进制；文件不存在时返回 'missing'
 */
export function dnrFingerprint() {
  const abs = join(ROOT, TARGET);
  if (!existsSync(abs)) return 'missing';
  return createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
}

/**
 * 写一条凭据（脚本成功跑完时调用）。
 *
 * @param {string} script 脚本名（如 'dnr-disable-clears-tab-rules'）
 * @param {{passed:number, skipped?:number}} stats
 */
export function writeStamp(script, stats) {
  const dir = dirname(STAMP_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let prev = {};
  if (existsSync(STAMP_PATH)) {
    try {
      prev = JSON.parse(readFileSync(STAMP_PATH, 'utf8'));
    } catch {
      prev = {};
    }
  }

  const record = {
    script,
    at: new Date().toISOString(),
    fingerprint: dnrFingerprint(),
    passed: stats.passed,
    skipped: stats.skipped ?? 0,
  };

  // 同一指纹下按脚本名合并，不同指纹则重置（旧凭据对新代码无意义）
  const scripts =
    prev.fingerprint === record.fingerprint && prev.scripts ? { ...prev.scripts } : {};
  scripts[script] = record;

  writeFileSync(
    STAMP_PATH,
    JSON.stringify({ fingerprint: record.fingerprint, scripts }, null, 2),
    'utf8',
  );
}

/** 读凭据（不存在或损坏返回 null） */
export function readStamp() {
  if (!existsSync(STAMP_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STAMP_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 当前工作区里 `dnr.ts` 是否有未提交改动。
 *
 * 只看**工作区 vs HEAD**：如果 dnr.ts 已经提交且没再改，那这次的 verify
 * 不需要重跑 DNR 回归（回归是**改动时**的义务）。
 */
export function dnrHasUncommittedChanges() {
  try {
    const r = execSync(`git status --porcelain -- ${TARGET}`, {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return r.trim().length > 0;
  } catch {
    return false;
  }
}

/** 两个 DNR 回归脚本的名字（凭据要求两个都在） */
export const REQUIRED_SCRIPTS = ['run-q2-auto', 'dnr-disable-clears-tab-rules'];
