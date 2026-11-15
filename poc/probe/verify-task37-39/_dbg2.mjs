import { readFileSync } from 'node:fs';
import { runProbe, extractProbeCalls } from './check-fake-green-construction.mjs';

const src = readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8');
const ex = extractProbeCalls(src, 'buildFallbackProbe');
const r = await runProbe(ex.calls[0]);
console.log('runProbe 结果:', JSON.stringify(r, null, 2));
