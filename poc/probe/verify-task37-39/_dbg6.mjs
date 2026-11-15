import { readFileSync } from 'node:fs';
import { extractProbeCalls } from './check-fake-green-construction.mjs';

const src = readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8');
const names = [...src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
console.log('探测到的函数名:', names.join(', '));
for (const n of names) {
  const ex = extractProbeCalls(src, n);
  if (ex && ex.calls.length) console.log(n, '→ new Function', ex.calls.length, '处');
}
