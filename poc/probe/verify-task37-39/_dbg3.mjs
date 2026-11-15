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
const names = params.map((p) => LITERAL(p) ?? p);
const tmpl = LITERAL(body);
const BT = String.fromCharCode(96);
console.log('names:', names);
console.log('tmpl 是字符串?', typeof tmpl, 'len', tmpl?.length);
const re = new RegExp('\\$\\{\\s*' + BT + '?\\{\\s*\\$\\{openLoginBody\\(\\)\\}\\s*' + BT + '?\\s*\\}');
console.log('tmpl 命中?', re.test(tmpl));
const inner = tmpl.replace(re, '{' + openLoginBody() + '}');
console.log('inner 含 openLogin?', inner.includes('const openLogin'));
console.log(JSON.stringify(inner.slice(0, 200)));
