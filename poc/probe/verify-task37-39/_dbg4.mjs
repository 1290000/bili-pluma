import { readFileSync } from 'node:fs';
import { runProbe, extractProbeCalls } from './check-fake-green-construction.mjs';

const src = readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8');
for (const name of ['buildProbe', 'buildFallbackProbe']) {
  const ex = extractProbeCalls(src, name);
  if (!ex) {
    console.log(name, '→ 没找到');
    continue;
  }
  for (const [i, call] of ex.calls.entries()) {
    const r = await runProbe(call);
    console.log(name + '#' + i, '→', r.error ?? r.verdict, JSON.stringify(r.counts));
  }
}
