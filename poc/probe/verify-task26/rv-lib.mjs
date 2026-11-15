// verifier RV 工具（task-27）：备份 → 单点变异 → 跑测 → 备份还原 → SHA256 核对
// 铁律：不用 git checkout / stash / reset。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BAK = resolve(ROOT, 'poc/probe/verify-task26/.rvbak');

export const sha = (p) =>
  createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();

export function backup(rel) {
  const src = resolve(ROOT, rel);
  const dst = resolve(BAK, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return sha(src);
}

export function restore(rel) {
  const src = resolve(ROOT, rel);
  const bak = resolve(BAK, rel);
  const want = sha(bak);
  copyFileSync(bak, src);
  const got = sha(src);
  return { restored: want === got, sha: got };
}

export function mutate(rel, from, to) {
  const p = resolve(ROOT, rel);
  const s = readFileSync(p, 'utf8');
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`变异点应恰好出现 1 次，实际 ${n} 次：${rel} :: ${from.slice(0, 60)}`);
  writeFileSync(p, s.replace(from, to), 'utf8');
  return true;
}



/** 跑指定测试文件（用仓库自身的 vitest.config.ts） */
export function runTests(files) {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--reporter=verbose', ...files],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    const err = e;
    out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
  }
  const redNames = [...out.matchAll(/^\s*(?:×|✗|FAIL)\s+(.+?)(?:\s+\d+ms)?$/gm)]
    .map((m) => (m[1] ?? '').trim())
    .filter(Boolean);
  const passMatch = /Tests\s+(\d+) passed/.exec(out);
  const failMatch = /Tests\s+(\d+) failed/.exec(out);
  return {
    file: files.join(','),
    passed: passMatch ? Number(passMatch[1]) : 0,
    failed: failMatch ? Number(failMatch[1]) : 0,
    redNames: [...new Set(redNames)],
    noTests: /No test files found|Tests\s+no tests/.test(out),
    syntaxError: /SyntaxError|Transform failed|Failed to resolve import/.test(out),
    output: out,
  };
}

export function cleanBak() {
  if (existsSync(BAK)) rmSync(BAK, { recursive: true, force: true });
}

/** 检查备份目录是否还有残留（收工必须为空） */
export function bakLeft() {
  if (!existsSync(BAK)) return false;
  const rest = readdirSync(BAK, { recursive: true }).filter((f) => !String(f).endsWith('/'));
  return rest.length > 0;
}

/** 直接调用一次探针（不经过 rv.mjs 的变异框架）—— 给"我改一下看它变不变"用 */
export function probeOnly() {
  return runTests(['--config=poc/probe/verify-task26/vitest.probe.config.ts']);
}
