import { readFileSync } from 'node:fs';

const code = readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8');
const at = code.search(new RegExp('function\\s+buildProbe\\s*\\('));
// 手工配平，跳过字符串
let depth = 0, quote = null, end = -1;
const brace = code.indexOf('{', at);
for (let i = brace; i < code.length; i++) {
  const c = code[i];
  if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
  if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
}
console.log('brace', brace, 'end', end, 'len', end - at + 1);
const block = code.slice(at, end + 1);
console.log('含 new Function?', block.includes('new Function('));
console.log('尾部:', JSON.stringify(block.slice(-100)));
