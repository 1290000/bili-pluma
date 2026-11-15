import { readFileSync } from 'node:fs';
import { extractProbeCalls } from './check-fake-green-construction.mjs';
import { openLoginBody } from './repair-and-guard-probe.mjs';

const src = readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8');
const ex = extractProbeCalls(src, 'buildFallbackProbe');
const { params, body } = ex.calls[0];
const LITERAL = (s) => {
  const t = s.trim();
  const m = /^(['"`])([\s\S]*)\1$/.exec(t);
  return m ? m[2] : undefined;
};
const tmpl = LITERAL(body);
const BQ = String.fromCharCode(96);
const placeholder = new RegExp('\\$\\{\\s*' + BQ + '?\\{\\s*\\$\\{openLoginBody\\(\\)\\}\\s*' + BQ + '?\\s*\\}');
const inner = tmpl.replace(placeholder, (m) => '{' + openLoginBody() + '}');
console.log('=== inner 尾部 ===');
console.log(JSON.stringify(inner.slice(-400)));
