/**
 * task-42 · RV-extra：**假绿**探针。
 *
 * `tests/unit/content/panel/orphan-hint.test.ts` 的 `toJs()` **不剥** `as {…}` 跨行对象类型，
 * 它切出来的 `openLogin` 函数体 `new Function` 编不过（见 `audit-tojs-sites.mjs`）。
 *
 * 但它**却仍然全绿（16 passed）**——说明那些测试对被测对象的构造是"坏的"，
 * 断言却照样通过。这不是"跑过了"，是**测量仪器坏了之后还继续读刻度**。
 *
 * 本探针把真正的守卫整体短路（`const orphan = false;`）：
 * - 若测试真的在跑 `openLogin`，孤儿形态必红
 * - 若它跑的是别的东西（或根本没跑起来），红不了
 *
 * 用法：node poc/probe/verify-task37-39/rv-extra-tojs-fakegreen.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = join(HERE, '..', '..', '..');
const BAK = join(HERE, '.rvbak-extra');
const SRC = 'entrypoints/content-panel.content.ts';
const FROZEN = 'F152B7B02C53562AC6925257982E6FF6616866C98EA45D96466ADF28A2267AB9';
const TEST_FILES = [
  'tests/unit/content/panel/orphan-hint.test.ts',
  'tests/unit/content/panel/incognito-panel-notice.test.ts',
];

const abs = (rel) => join(ROOT, rel);
const sha = (rel) => createHash('sha256').update(readFileSync(abs(rel))).digest('hex').toUpperCase();

if (sha(SRC) !== FROZEN) {
  console.log(`🔴 开工 SHA ${sha(SRC)} ≠ 冻结基线，停手。`);
  process.exit(3);
}

const runTests = () => {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', ...TEST_FILES, '--reporter=verbose'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  return out;
};

const count = (out) => {
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \((\d+)\))?/.exec(out);
  return { failed: m ? Number(m[1] ?? 0) : null, passed: m ? Number(m[2]) : null };
};

console.log('=== 基线（未变异） ===');
const base = runTests();
console.log('   ', JSON.stringify(count(base)));

mkdirSync(BAK, { recursive: true });
copyFileSync(abs(SRC), join(BAK, 'cp.bak'));
try {
  const src = readFileSync(abs(SRC), 'utf8');
  const from = "const orphan = typeof chrome === 'undefined' || chrome.runtime?.id == null;";
  if (src.split(from).length - 1 !== 1) throw new Error('变异锚点不唯一');
  writeFileSync(abs(SRC), src.replace(from, 'const orphan = false;'), 'utf8');
  console.log('\n=== 变异：守卫整体短路（const orphan = false） ===');
  const out = runTests();
  const c = count(out);
  console.log('   ', JSON.stringify(c));
  const red = out
    .split('\n')
    .filter((l) => /×|FAIL /.test(l))
    .map((l) => l.trim())
    .slice(0, 8);
  for (const l of red) console.log('     ' + l);
  console.log(
    c.failed === 0
      ? '\n🔴 整个守卫被短路后这两组测试**仍然全绿** ⇒ 它们证明不了守卫有效（假绿）'
      : `\n✅ 守卫短路后变红 ${c.failed} 条 ⇒ 至少有一部分测试真的在跑 openLogin`,
  );
} finally {
  copyFileSync(join(BAK, 'cp.bak'), abs(SRC));
  for (const f of readdirSync(BAK)) unlinkSync(join(BAK, f));
  const back = sha(SRC);
  console.log(`\n还原 SHA = ${back} → ${back === FROZEN ? '✅ 回到冻结基线' : '🔴 回不到基线，停手报 Lead'}`);
  if (back !== FROZEN) process.exit(4);
}
