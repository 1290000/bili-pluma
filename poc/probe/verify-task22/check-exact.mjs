// task-23 独立核实（精确版）：逐一列出剥离前/后每个空 catch 的**真实原文**，
// 消除行号偏移带来的误读。

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
const re = /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;

function list(s, label) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    // 用"匹配处之前完整的行"来判断它落在行注释还是代码里
    const before = s.slice(0, m.index);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineText = s.slice(lineStart, s.indexOf('\n', m.index) > -1 ? s.indexOf('\n', m.index) : s.length);
    out.push({ idx: m.index, line: lineText.trim() });
  }
  console.log(`${label}: ${out.length} 处`);
  for (const o of out) console.log(`   [${o.idx}] ${o.line.slice(0, 80)}`);
  return out;
}

const rawHits = list(raw, 'RAW');
const srcHits = list(src, 'STRIPPED');

console.log('');
console.log('=== 判定：分支内是否还有空 catch ===');
const start = src.indexOf("if (result.reason === 'incognito-disabled')");
const end = src.indexOf("reason: 'unknown'", start);
const branch = src.slice(start, end);
console.log('分支区间源码长度:', branch.length);
console.log('分支内空 catch:', new RegExp(re.source).test(branch), '(期望 false)');

console.log('');
console.log('=== 剩下的空 catch 落点（都是 background 启动自愈/校正的 .catch） ===');
for (const h of srcHits) {
  const before = src.slice(0, h.idx);
  const prevLine = before.slice(before.lastIndexOf('\n', before.length - 2) + 1).trim();
  console.log(`   [${h.idx}] 上一行: ${prevLine.slice(0, 70)}`);
}
