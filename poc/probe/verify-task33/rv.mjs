/**
 * task-34 反向验证（RV1–RV3）。纪律同前：
 *  1. 变异前断言变异点出现次数 === 1；
 *  2. "真红"要有用例失败且失败措辞符合预期；
 *  3. 还原 = 文件复制 + SHA256 逐字节核对；禁用 git stash/checkout/reset。
 *
 * 用法：node poc/probe/verify-task33/rv.mjs <RV1|RV2|RV3|restore>
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const CP = 'entrypoints/content-panel.content.ts';
const BAK = 'poc/probe/verify-task33/_cp.bak.ts';
const TEST = 'tests/unit/content/panel/orphan-hint.test.ts';

const cp = process.argv[2];

function sha(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
}

function runTests() {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', TEST],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  const lines = out.split('\n');
  const fails = lines.filter((l) => /^\s+×|FAIL /.test(l)).map((l) => l.trim());
  const msgs = lines.filter((l) => /^\s+→/.test(l)).map((l) => l.trim());
  const summary = lines.find((l) => /Tests\s+/.test(l))?.trim() ?? '(无摘要)';
  return { summary, fails, msgs };
}

function mutateOnce(from, to) {
  const s = readFileSync(CP, 'utf8');
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`变异点出现 ${String(n)} 次，拒绝变异`);
  writeFileSync(CP, s.replace(from, to), 'utf8');
}

function restore() {
  copyFileSync(BAK, CP);
}

if (cp === 'restore') {
  restore();
  console.log('[restore] SHA', sha(CP));
} else if (cp === 'RV1') {
  // 把孤儿 catch 分支整体短路（engineer 的 RV1 是改回 .catch(() => null)，我这里换个写法：
  // 保留 showOrphanHint() 字样、只让它永不执行 —— 这是"源码形状对但运行期静默"的典型假象）
  if (!existsSync(BAK)) copyFileSync(CP, BAK);
  const before = sha(CP);
  mutateOnce(
    'if (isOrphanError(e)) {\n          showOrphanHint();\n          return null;\n        }',
    'if (false && isOrphanError(e)) {\n          showOrphanHint();\n          return null;\n        }',
  );
  const r = runTests();
  console.log('[RV1] 变异：孤儿 catch 分支短路（showOrphanHint 字样仍在）');
  console.log('[RV1]', r.summary);
  for (const f of r.fails) console.log('  ×', f);
  for (const m of r.msgs) console.log('  ', m);
  restore();
  console.log('[RV1] restore 逐字节一致 =', sha(CP) === before);
} else if (cp === 'RV2') {
  if (!existsSync(BAK)) copyFileSync(CP, BAK);
  const before = sha(CP);
  mutateOnce(
    'if (!isOrphanHintShown() && controller === null) showOrphanHint();',
    'if (false && !isOrphanHintShown() && controller === null) showOrphanHint();',
  );
  const r = runTests();
  console.log('[RV2] 变异：controller===null 兜底短路');
  console.log('[RV2]', r.summary);
  for (const f of r.fails) console.log('  ×', f);
  for (const m of r.msgs) console.log('  ', m);
  restore();
  console.log('[RV2] restore 逐字节一致 =', sha(CP) === before);
} else if (cp === 'RV3') {
  // 探活目标改成一条写消息（证明守卫钉的是"只读"这件事）
  if (!existsSync(BAK)) copyFileSync(CP, BAK);
  const before = sha(CP);
  mutateOnce(
    "sendMessage({ type: 'proxy/status' })",
    "sendMessage({ type: 'account/summary' })",
  );
  const r = runTests();
  console.log('[RV3] 变异：探活消息 proxy/status → account/summary');
  console.log('[RV3]', r.summary);
  for (const f of r.fails) console.log('  ×', f);
  for (const m of r.msgs) console.log('  ', m);
  restore();
  console.log('[RV3] restore 逐字节一致 =', sha(CP) === before);
} else {
  console.log('用法：node rv.mjs <RV1|RV2|RV3|restore>');
}
