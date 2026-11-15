import { backup, restore, runTests, ROOT } from './rv-lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PANEL = 'src/content/panel/panel.ts';
const GUARD = 'tests/unit/content/panel-diag-wiring.test.ts';
const ALL = [PANEL, GUARD];

const cases = [
  {
    name: 'V8 保留复用 + 用别名把观测类覆盖（const F = describeLogsMetaFallback; ...F(), ...{ ok: true }）',
    fn: (s) => {
      const a = 'logsMeta: diagData?.logsMeta ?? {\n                    ...describeLogsMetaFallback(),';
      if (s.split(a).length - 1 !== 1) throw new Error('anchor 不唯一');
      return s.replace(
        a,
        'logsMeta: diagData?.logsMeta ?? {\n                    ...describeLogsMetaFallback(),\n                    ...{ [' + "'ok'" + ']: true },',
      );
    },
    expected: '字符串字面量键 ["ok"] —— 若绿，说明只能挡 `ok:` 这一种写法',
  },
];

for (const c of cases) {
  console.log(`\n=== ${c.name} ===`);
  const snap = backup(ALL);
  let run = { failed: 0, passed: 0, failures: [], noTests: true };
  let info = null;
  try {
    const p = join(ROOT, PANEL);
    const src = readFileSync(p, 'utf8');
    const next = c.fn(src);
    if (next === src) throw new Error('patch 没改到东西');
    writeFileSync(p, next, 'utf8');
    info = 'mutated';
    run = runTests([GUARD]);
  } catch (e) {
    info = `ERR ${String(e.message ?? e)}`;
  } finally {
    const after = restore(ALL);
    const same = ALL.every((r) => after[r] === snap[r]);
    console.log(`[mutated] ${String(info)} restore_ok=${String(same)}`);
    console.log(`[result] failed=${String(run.failed)} passed=${String(run.passed)}`);
    for (const f of run.failures) console.log(`   x ${f.msg}`);
    console.log(`[预期] ${c.expected}`);
  }
}
