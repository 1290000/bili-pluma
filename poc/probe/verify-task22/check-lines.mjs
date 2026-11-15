// task-23 独立核实：stripComments 对「行注释」的处理是否有效。
// 单独拎出来，因为上一个 check.mjs 的输出里 RAW 与 STRIPPED 计数相同，
// 需要确认那是"行注释里的命中被正确剥离"还是"剥离器对行注释失效"。

import { readFileSync } from 'node:fs';

function stripComments(s) {
  const out = [];
  let i = 0;
  let inBlock = false;
  while (i < s.length) {
    if (!inBlock && s[i] === '/' && s[i + 1] === '*') { inBlock = true; i += 2; continue; }
    if (inBlock && s[i] === '*' && s[i + 1] === '/') { inBlock = false; i += 2; continue; }
    if (inBlock) { i++; continue; }
    if (s[i] === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    out.push(s[i] ?? '');
    i++;
  }
  return out.join('');
}

const raw = readFileSync('entrypoints/background.ts', 'utf8');
const src = stripComments(raw);

const hits = (s) => {
  const re = /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;
  const res = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const line = s.slice(0, m.index).split('\n').length;
    res.push(`  行 ${line}: ${s.split('\n')[line - 1].trim().slice(0, 70)}`);
  }
  return res;
};

console.log('RAW 命中:');
for (const h of hits(raw)) console.log(h);
console.log('STRIPPED 命中:');
for (const h of hits(src)) console.log(h);

// 行注释剥离的针对性自检
const probe = 'const ok = 1; // .catch(() => {})\nconst keep = 2;\n';
const sp = stripComments(probe);
console.log('');
console.log('行注释探针剥离后命中:', /\.catch\(/.test(sp), '(期望 false)');
console.log('行注释探针同行代码保留:', sp.includes('const ok = 1'), '(期望 true)');
console.log('下一行代码保留:', sp.includes('const keep = 2'), '(期望 true)');
