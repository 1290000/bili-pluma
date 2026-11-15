import { matchPair, stripComments } from './check-fake-green-construction.mjs';
import { readFileSync } from 'node:fs';

const src = readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8');
const code = stripComments(src);
console.log('原文 new Function 次数 =', (src.match(/new Function\(/g) || []).length);
console.log('剥注释后 new Function 次数 =', (code.match(/new Function\(/g) || []).length);
const at = code.search(new RegExp('function\\s+buildProbe\\s*\\('));
const brace = code.indexOf('{', at);
const end = matchPair(code, brace, '{', '}');
const block = code.slice(at, end + 1);
console.log('block len', block.length, '含 new Function?', block.includes('new Function('));
const idx = block.indexOf('new Function(');
console.log('idx', idx);
if (idx >= 0) {
  console.log('prev char:', JSON.stringify(block[idx - 1]));
  console.log('line before:', JSON.stringify(block.slice(Math.max(0, idx - 120), idx)));
}
