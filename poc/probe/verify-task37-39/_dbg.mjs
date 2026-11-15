import { readFileSync } from 'node:fs';
import { extractProbeCalls } from './check-fake-green-construction.mjs';

const src = readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8');
const ex = extractProbeCalls(src, 'buildFallbackProbe');
const b = ex.calls[0].body;
const BT = String.fromCharCode(96); // 反引号
// 模板实参是 `...` 包裹；里面是 ${`{${openLoginBody()}}`}
const re = new RegExp('\\$\\{\\s*' + BT + '?\\{\\s*\\$\\{openLoginBody\\(\\)\\}\\s*' + BT + '?\\s*\\}');
console.log('直接测:', re.test(b));
const idx = b.indexOf('openLoginBody()');
console.log('openLoginBody() 下标:', idx);
console.log('前后各 60 字符:', JSON.stringify(b.slice(idx - 30, idx + 30)));
