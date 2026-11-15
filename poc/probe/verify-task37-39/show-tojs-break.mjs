/**
 * 打印 toJs() 处理真实源码后的完整输出，并指出编译失败的确切位置与成因。
 *
 * 用法：node poc/probe/verify-task37-39/show-tojs-break.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TEST = 'tests/unit/content/panel/orphan-guard.test.ts';
const SRC = 'entrypoints/content-panel.content.ts';

const test = readFileSync(TEST, 'utf8');

function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  let depth = 0;
  let started = false;
  let out = '';
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    out += ch;
    if (ch === '{') {
      depth++;
      started = true;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) break;
    }
  }
  return out;
}
function stripFnTypes(s) {
  return s
    .replace(/(\bfunction\s+[A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*:\s*[A-Za-z_$][\w$]*/g, '$1($2)')
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)\s*=>/g, '($1) =>')
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)(?!\s*=>)/g, '($1)')
    .replace(/(\b(?:let|const|var)\s+[A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, '$1 =')
    .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '');
}

const mod = new Function(
  stripFnTypes(grab(test, 'stripComments')) +
    '\n' +
    stripFnTypes(grab(test, 'toJs')) +
    '\nfunction braceBlock(s,i){let d=0;for(let k=i;k<s.length;k++){const ch=s[k];if(ch==="{")d++;else if(ch==="}"){d--;if(d===0)return s.slice(i,k+1)}}return "";}' +
    '\nreturn { stripComments, toJs, braceBlock };',
)();

const code = mod.stripComments(readFileSync(SRC, 'utf8'));
const at = code.indexOf('const openLogin = async');
const block = mod.braceBlock(code, code.indexOf('{', code.indexOf('=>', at) + 2));
const js = mod.toJs(block.slice(1, -1));
{
  const L = js.split('\n');
  for (let n = 1; n <= Math.min(16, L.length); n++) console.log('RAW' + n + ': ' + JSON.stringify(L[n - 1]));
}
writeFileSync('poc/probe/verify-task37-39/_tojs-out.txt', js, 'utf8');

let err = null;
try {
  new Function(js);
} catch (e) {
  err = e;
}
console.log('toJs 输出长度 =', js.length, '；可编译 =', err === null, err ? `；错误 = ${err.message}` : '');

// 找 readAccountMid 出现过的地方，看它周围的原文
const idxs = [];
let p = js.indexOf('readAccountMid');
while (p >= 0) {
  idxs.push(p);
  p = js.indexOf('readAccountMid', p + 1);
}
console.log('readAccountMid 出现次数 =', idxs.length);
for (const i of idxs) {
  const before = js.slice(Math.max(0, i - 160), i);
  console.log('\n--- 位置', i, '---');
  console.log('前文:', JSON.stringify(before));
  console.log('该处:', JSON.stringify(js.slice(i - 40, i + 60)));
}

// 源文件里对应的原文
const raw = readFileSync(SRC, 'utf8');
const ri = raw.indexOf('readAccountMid = async');
console.log('\n=== 源码里的 readAccountMid 定义（前 400 字） ===');
console.log(JSON.stringify(raw.slice(ri, ri + 420)));
