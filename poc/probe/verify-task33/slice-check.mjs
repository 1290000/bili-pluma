import { readFileSync } from 'node:fs';

const SRC = readFileSync('entrypoints/content-panel.content.ts', 'utf8');

// —— 按 orphan-hint.test.ts 一模一样的剥注释 + 切片 ——
function stripComments(s) {
  let out = ''; let i = 0; let mode = 'code';
  while (i < s.length) {
    const ch = s[i] ?? ''; const nx = s[i + 1] ?? '';
    if (mode === 'code') {
      if (ch === '/' && nx === '/') { mode = 'line'; i += 2; continue; }
      if (ch === '/' && nx === '*') { mode = 'block'; i += 2; continue; }
      if (ch === "'") mode = 'single'; else if (ch === '"') mode = 'double'; else if (ch === '`') mode = 'tmpl';
      out += ch; i += 1; continue;
    }
    if (mode === 'line') { if (ch === '\n') { mode = 'code'; out += ch; } i += 1; continue; }
    if (mode === 'block') { if (ch === '*' && nx === '/') { mode = 'code'; i += 2; continue; } if (ch === '\n') out += ch; i += 1; continue; }
    if (ch === '\\') { out += ch + nx; i += 2; continue; }
    if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"') || (mode === 'tmpl' && ch === '`')) mode = 'code';
    out += ch; i += 1;
  }
  return out;
}
function braceBlock(s, from) {
  const open = s.indexOf('{', from); if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1; else if (s[i] === '}') { depth -= 1; if (depth === 0) return s.slice(open, i + 1); }
  }
  return '';
}
const code = stripComments(SRC);
const at = code.indexOf('const openLogin = async');
const body = braceBlock(code, code.indexOf('=>', at)).replace(/\n/g, ' ');
console.log('openLogin 切片长度', body.length);
console.log('含 "if (!r.shouldPoll) return;":', body.includes('if (!r.shouldPoll) return;'));
console.log('body 尾部 120 字:', JSON.stringify(body.slice(-120)));
