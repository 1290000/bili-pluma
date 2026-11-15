/**
 * task-47 反向验证（RV）—— verifier 亲自改代码、跑、再逐字节还原
 *
 * ## 铁律
 * - **禁** `git stash` / `git checkout` / `git reset`（工作区 60+ 行未提交改动）
 * - 备份 = 文件复制到 `poc/probe/verify-task46/.rvbak/`
 * - 每次还原后**比 SHA256**，不一致就抛
 * - 变异前先断言 `from` 在源码里出现**恰好 1 次**，否则抛（防止改错地方）
 *
 * 用法：`node poc/probe/verify-task46/rv.mjs RV1|RV2|RV3|clean`
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const BAK = join(HERE, '.rvbak');

const sha = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();
const flat = (rel) => rel.replace(/[\\/]/g, '__');

function backup(rels) {
  mkdirSync(BAK, { recursive: true });
  for (const rel of rels) {
    const src = join(ROOT, rel);
    const dst = join(BAK, flat(rel));
    copyFileSync(src, dst);
    const a = readFileSync(src);
    const b = readFileSync(dst);
    if (!a.equals(b)) throw new Error(`备份不一致: ${rel}`);
    console.log(`[bak] ${rel} ${sha(a)} ${a.length}B`);
  }
}

function restore(rels) {
  for (const rel of rels) {
    const src = join(BAK, flat(rel));
    const dst = join(ROOT, rel);
    if (!existsSync(src)) throw new Error(`备份不存在: ${rel} —— 拒绝还原`);
    const bakBuf = readFileSync(src);
    copyFileSync(src, dst);
    const now = readFileSync(dst);
    if (!now.equals(bakBuf)) throw new Error(`还原失败（逐字节不一致）: ${rel}`);
    console.log(`[restore] ${rel} ${sha(now)} ${now.length}B 逐字节一致=true`);
  }
}

function mutate(rel, from, to) {
  const p = join(ROOT, rel);
  const src = readFileSync(p, 'utf8');
  const count = src.split(from).length - 1;
  if (count !== 1) throw new Error(`[mutate] "${from}" 在 ${rel} 出现 ${count} 次，要求恰好 1 次`);
  writeFileSync(p, src.replace(from, to), 'utf8');
  const after = readFileSync(p);
  console.log(`[mutate] ${rel} ${sha(after)} ${after.length}B`);
}

function runTests(spec) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', spec],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
    code = e.status ?? 1;
  }
  const m = out.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \((\d+)\))?/);
  const failed = m?.[1] ? Number(m[1]) : 0;
  const passed = m?.[2] ? Number(m[2]) : 0;
  const lines = out
    .split('\n')
    .filter((l) => /AssertionError|→ /.test(l))
    .map((l) => l.trim())
    .slice(0, 6);
  return { failed, passed, exitCode: code, redLines: lines };
}

function bakCount() {
  if (!existsSync(BAK)) return 0;
  return readdirSync(BAK).length;
}

function clean() {
  if (existsSync(BAK)) rmSync(BAK, { recursive: true, force: true });
  console.log(`[clean] rvbak=${bakCount()}`);
}

const TARGETS = ['src/background/login-window.ts', 'entrypoints/background.ts'];
const PROBE = 'poc/probe/verify-task46/vitest.probe.config.ts';

const RV = {
  /** RV1：删掉权限 false 的提前 return ⇒ 判据 1 必须红 */
  RV1() {
    backup(TARGETS);
    mutate(
      'src/background/login-window.ts',
      `  if (!allowed) {
    await diag('权限读到 false → 不建无痕窗，直接报 incognito-disabled');
    return { ok: false, reason: 'incognito-disabled' };
  }`,
      `  // [RV1] 提前 return 已删除`,
    );
    const r = runTests(PROBE);
    console.log(JSON.stringify(r, null, 2));
    restore(TARGETS);
    clean();
  },

  /** RV2：assumed 改回 opened:true ⇒ 判据 2 必须红（并且会撞上"已打开"） */
  RV2() {
    backup(TARGETS);
    mutate(
      'entrypoints/background.ts',
      `      opened: false,
      confirmed: false,
      reason: 'assumed',`,
      `      opened: true,
      reason: 'assumed',`,
    );
    const r = runTests(PROBE);
    console.log(JSON.stringify(r, null, 2));
    restore(TARGETS);
    clean();
  },

  /** RV3：把"权限闸门"换成"先 create 再判" ⇒ 判据 1 的 create===0 必须红 */
  RV3() {
    backup(TARGETS);
    mutate(
      'src/background/login-window.ts',
      `  if (!allowed) {
    await diag('权限读到 false → 不建无痕窗，直接报 incognito-disabled');
    return { ok: false, reason: 'incognito-disabled' };
  }`,
      `  if (false && !allowed) {
    await diag('权限读到 false → 不建无痕窗，直接报 incognito-disabled');
    return { ok: false, reason: 'incognito-disabled' };
  }`,
    );
    const r = runTests(PROBE);
    console.log(JSON.stringify(r, null, 2));
    restore(TARGETS);
    clean();
  },
};

const arg = process.argv[2];
if (arg === 'clean') {
  clean();
} else if (arg && RV[arg]) {
  RV[arg]();
} else {
  console.log('用法: node rv.mjs RV1|RV2|RV3|clean');
}
