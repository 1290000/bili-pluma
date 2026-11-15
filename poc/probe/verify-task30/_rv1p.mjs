import { backup, restore, runTests } from './rv-lib.mjs';
const PANEL = 'src/content/panel/panel.ts';
const GUARD = 'tests/unit/content/panel-diag-wiring.test.ts';
const ALL = [PANEL, GUARD];
const snap = backup(ALL);
let run = { failed: 0, passed: 0, failures: [], noTests: true };
const ORIG = `logsMeta: diagData?.logsMeta ?? {
                    ...describeLogsMetaFallback(),
                    limit: DIAG_LIMIT,
                    instanceId: instanceId(),
                    readAt: now.getTime(),
                  },`;
try {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const p = 'src/content/panel/panel.ts';
  const s = readFileSync(p, 'utf8');
  const n = s.split(ORIG).length - 1;
  if (n !== 1) throw new Error('ORIG 出现 ' + String(n) + ' 次');
  writeFileSync(p, s.replace(ORIG, "logsMeta: diagData?.logsMeta ?? { ok: true, err: null, count: 0, limit: 30, instanceId: 'x', readAt: now.getTime() },"), 'utf8');
  run = runTests([GUARD]);
} catch (e) {
  console.log('ERR', String(e.message ?? e));
} finally {
  const after = restore(ALL);
  console.log('restore_ok', ALL.every((r) => after[r] === snap[r]), 'failed', run.failed, 'passed', run.passed);
  for (const f of run.failures) console.log('  x', f.msg);
}
