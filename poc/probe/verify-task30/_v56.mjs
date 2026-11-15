import { backup, restore, runTests, ROOT } from './rv-lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PANEL = 'src/content/panel/panel.ts';
const GUARD = 'tests/unit/content/panel-diag-wiring.test.ts';
const ALL = [PANEL, GUARD];

// 精确整段（用 indexOf 定位 exportJson 块的 logsMeta 段，不靠手抄缩进）
function patch(src, transform) {
  const anchor = 'logsMeta: diagData?.logsMeta ?? {';
  const i = src.indexOf(anchor);
  if (i < 0 || src.indexOf(anchor, i + 1) >= 0) throw new Error('anchor 不是唯一');
  return src.slice(0, i) + transform + src.slice(i + anchor.length);
}

const cases = [
  {
    name: 'V5 观测类将被谎报，但块内有另一处合法 ok: 字面量',
    fn: (s) => patch(s, 'logsMeta: {\n                    ...(diagData?.logsMeta ?? describeLogsMetaFallback()),\n                    profile: { ok: false },'),
    expected: '假绿：第一条（复用）红，第二条（不许字面量）被 profile.ok 骗过',
  },
  {
    name: 'V6 结构不变，仅在块内加一处无关的合法 ok: 字面量',
    fn: (s) => s.replace('...describeLogsMetaFallback(),', '...describeLogsMetaFallback(),\n                    profile: { ok: false },'),
    expected: '真红（假红）：语义没变，但字面量断言照样命中',
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
