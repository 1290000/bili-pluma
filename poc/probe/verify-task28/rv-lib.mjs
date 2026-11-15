/**
 * task-29 反向验证框架（task-28 验收）
 *
 * 纪律（Lead 硬要求 + task-25 的教训）：
 * - 每次变异前**先断言变异点出现次数 === 1**，否则直接抛
 * - 还原用**文件复制 + SHA256** 逐字节核对；**禁用 git stash / checkout / reset**
 * - 判定"真红"必须同时满足：①有用例失败 ②失败原因带预期断言措辞 ③不是 no tests / 语法错
 * - `.rvbak` 收工前清空
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(createRequire(import.meta.url).resolve(import.meta.filename ?? process.argv[1] ?? ''));
export const ROOT = resolve(HERE, '..', '..', '..');
const BAK = join(HERE, '.rvbak');
const PROBE_CONFIG = 'poc\\probe\\verify-task28\\vitest.probe.config.ts';

const sha = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();

function ensureBak() {
  if (!existsSync(BAK)) mkdirSync(BAK, { recursive: true });
}
const bakPath = (rel) => join(BAK, rel.split('/').join('__') + '.bak');

/** 变异前重新备份（并发窗口内 precheck 会打印 DIFF —— task-25 的教训） */
export function backup(rel) {
  ensureBak();
  const abs = join(ROOT, rel);
  const cur = readFileSync(abs);
  const bp = bakPath(rel);
  if (existsSync(bp)) {
    const old = readFileSync(bp);
    if (sha(old) !== sha(cur)) {
      console.log(`[backup] DIFF ${rel} —— 备份已被别人改过，以当前内容为准重建`);
    }
  }
  writeFileSync(bp, cur);
  return sha(cur);
}

export function restore(rel) {
  const bp = bakPath(rel);
  const abs = join(ROOT, rel);
  copyFileSync(bp, abs);
  const a = sha(readFileSync(bp));
  const b = sha(readFileSync(abs));
  return { restored: a === b, sha: b };
}

export function cleanBak() {
  if (existsSync(BAK)) rmSync(BAK, { recursive: true, force: true });
}

export function bakLeft() {
  if (!existsSync(BAK)) return 0;
  const { readdirSync } = createRequire(import.meta.url)('node:fs');
  return readdirSync(BAK).filter((f) => f.endsWith('.bak')).length;
}

/** 单点替换；出现次数 !== 1 直接抛（防护「变异错了地方却在别处巧合变红」） */
export function mutate(rel, from, to) {
  const abs = join(ROOT, rel);
  const src = readFileSync(abs, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`[mutate] ${rel} 变异点出现 ${String(n)} 次（要求恰好 1 次）：${from}`);
  writeFileSync(abs, src.replace(from, to), 'utf8');
}

/** 跑探针或产品测试；返回解析后的结果 */
export function runTests({ probe = true, files = [] } = {}) {
  const argv = probe
    ? ['node_modules/vitest/vitest.mjs', 'run', '--config', PROBE_CONFIG]
    : ['node_modules/vitest/vitest.mjs', 'run', ...files];
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
    code = e.status ?? 1;
  }
  const passM = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(out);
  const failed = passM?.[1] ? Number(passM[1]) : 0;
  const passed = passM?.[2] ? Number(passM[2]) : 0;
  const noTests = /No test files found|no test found/i.test(out);
  const syntaxErr = /SyntaxError|Transform failed|Cannot find module|Failed to load|The URL must be of scheme/i.test(out);
  const failures = [...out.matchAll(/×\s+(.+?)\n(?:.*\n)*?\s+→\s+([^\n]+)/g)].map((m) => ({
    name: m[1].trim(),
    msg: m[2].trim(),
  }));
  return { code, failed, passed, noTests, syntaxErr, failures, raw: out };
}

export function check(arg1, arg2, arg3) {
  // 支持 check(label, msgRe, result) 与 check(msgRe, result) 两种调用
  const [label, expectedMsgRe, result] = typeof arg1 === 'string' ? [arg1, arg2, arg3] : [String(arg2), arg1, arg2];
  const reallyRed =
    result.failed > 0 &&
    !result.noTests &&
    !result.syntaxErr &&
    result.failures.some((f) => expectedMsgRe.test(f.msg));
  return {
    label,
    reallyRed,
    failed: result.failed,
    passed: result.passed,
    noTests: result.noTests,
    syntaxErr: result.syntaxErr,
    matched: result.failures.filter((f) => expectedMsgRe.test(f.msg)).map((f) => `${f.name} → ${f.msg}`),
  };
}
