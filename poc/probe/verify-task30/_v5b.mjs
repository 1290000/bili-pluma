import { backup, restore, runTests, ROOT } from './rv-lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PANEL = 'src/content/panel/panel.ts';
const GUARD = 'tests/unit/content/panel-diag-wiring.test.ts';
const ALL = [PANEL, GUARD];

function patch(src, transform) {
  const anchor = 'logsMeta: diagData?.logsMeta ?? {';
  const i = src.indexOf(anchor);
  if (i < 0 || src.indexOf(anchor, i + 1) >= 0) throw new Error('anchor 不是唯一');
  return src.slice(0, i) + transform + src.slice(i + anchor.length);
}

const cases = [
  {
    name: 'V5b 真·谎报：保留结构，只把 fallback 换成 ok:true 字面量（字面量断言靠 profile.ok 绕过）',
    fn: (s) =>
      patch(
        s,
        'logsMeta: diagData?.logsMeta ?? { ...describeLogsMetaFallback(), profile: { ok: false }, limit: DIAG_LIMIT, instanceId: instanceId(), readAt: now.getTime() },',
      ).replace('...describeLogsMetaFallback(), profile:', 'profile:'),
    // 上面这步还不够；直接构造最干净的形态
    alt: (s) =>
      s.replace(
        'logsMeta: diagData?.logsMeta ?? {\n                    ...describeLogsMetaFallback(),',
        'logsMeta: diagData?.logsMeta ?? {\n                    __unused: describeLogsMetaFallback, // 只为骗过 import 未用检查\n                    profile: { ok: false },',
      ),
    expected: '若绿 ⇒ 字面量断言被 profile.ok 骗过，谎报漏检',
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
    const next = c.alt(src);
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
