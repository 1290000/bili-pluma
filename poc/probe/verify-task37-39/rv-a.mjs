/**
 * task-40 · A 部分反向验证。
 * 目标：判 task-37 的两条断言反转（`not.toContain('再点一次')` → `toContain`）
 * 是「有独立证据支撑的需求变化」还是「为了让测试变绿改测试」。
 *
 * 做法：不看 engineer 怎么说，**直接看代码改了什么、测试是新写还是被翻了**。
 *
 * 纪律：先备份 → 单点变异 → 跑测 → 复制还原 → SHA256 逐字节核对。
 * 禁用 git stash / checkout / reset。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const LANDED = 'src/content/panel/login-outcome.ts';
const TESTS = [
  'tests/unit/content/panel-login-outcome.test.ts',
  'tests/unit/content/panel/incognito-panel-notice.test.ts',
];

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();

function runTests() {
  let out = '';
  try {
    out = execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...TESTS], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  const lines = out.split('\n');
  return {
    summary: lines.filter((l) => /Tests\s+|Test Files/.test(l)).map((l) => l.trim()).join(' | '),
    fails: lines.filter((l) => /^\s+×/.test(l)).map((l) => l.trim()),
    msgs: lines.filter((l) => /^\s+→/.test(l)).map((l) => l.trim()),
  };
}

const cp = process.argv[2];
const only = process.argv[3]; // 只跑某个断言文件时用

if (cp === 'baseline') {
  const r = runTests();
  console.log('[baseline]', r.summary);
} else if (cp === 'A1') {
  // A1：删掉任务卡声明的那个动作短语（应真红）
  const before = sha(LANDED);
  const s = readFileSync(LANDED, 'utf8');
  const from = "'然后再点一次「扫码登录」'";
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`变异点出现 ${n} 次`);
  writeFileSync(LANDED, s.replace(from, "''"), 'utf8');
  const r = runTests();
  console.log('[A1] 删掉「然后再点一次「扫码登录」」→', r.summary);
  for (const f of r.fails) console.log('  ×', f);
  for (const m of r.msgs) console.log('  ', m);
  copyFileSync(`poc/probe/verify-task37-39/backup/${LANDED.replace(/\//g, '__')}`, LANDED);
  console.log('[A1] restore 逐字节一致 =', sha(LANDED) === before);
} else if (cp === 'A2') {
  // A2：把「再点一次」整段删掉（回到 task-22 的口径）—— 看 task-22 的 not.toContain 还有没有活着
  const before = sha(LANDED);
  const s = readFileSync(LANDED, 'utf8');
  const from =
    "'需要先在扩展详情页打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」），' +\n            '然后再点一次「扫码登录」'";
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`变异点出现 ${n} 次`);
  writeFileSync(
    LANDED,
    s.replace(from, "'需要先在扩展详情页打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」）'"),
    'utf8',
  );
  const r = runTests();
  console.log('[A2] 回到 task-22 口径（删「再点一次」）→', r.summary);
  for (const f of r.fails) console.log('  ×', f);
  for (const m of r.msgs) console.log('  ', m);
  copyFileSync(`poc/probe/verify-task37-39/backup/${LANDED.replace(/\//g, '__')}`, LANDED);
  console.log('[A2] restore 逐字节一致 =', sha(LANDED) === before);
} else if (cp === 'restore') {
  copyFileSync('poc/probe/verify-task37-39/backup/src__content__panel__login-outcome.ts', LANDED);
  console.log('[restore] SHA', sha(LANDED));
}
