import { backup, restore, runTests } from './rv-lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const CHAIN = 'tests/unit/content/panel-logsmeta-chain.test.ts';
const snap = backup([CHAIN]);
let ok = false;
let run = { failed: 0, passed: 0, failures: [], noTests: true };
try {
  let s = readFileSync(CHAIN, 'utf8');
  const marker = "      `禁止 logsMeta 的链式二次访问 —— 必须先收敛成 meta 变量：\\n${violations.join('\\n')}`,\n    ).toEqual([]);";
  if (s.split(marker).length - 1 !== 1) throw new Error('marker 不唯一');
  s = s.replace(marker, "      `禁止 logsMeta 的链式二次访问 —— 必须先收敛成 meta 变量：\\n${violations.join('\\n')}`,\n    ).toEqual(['__forced_self_explode__']);");
  writeFileSync(CHAIN, s, 'utf8');
  console.log('[mutated] 静态穷举改为恒失败');
  run = runTests([CHAIN]);
} finally {
  const after = restore([CHAIN]);
  ok = after[CHAIN] === snap[CHAIN];
  console.log('restore_ok', ok, 'failed', run.failed, 'passed', run.passed);
}
