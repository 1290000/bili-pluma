/** 调试：把测试里的 stripComments/toJs 搬到 JS 后，看 toJs 对真实源码做了什么 */
import { readFileSync } from 'node:fs';

const c = readFileSync('tests/unit/content/panel/orphan-guard.test.ts', 'utf8');
function grab(name) {
  const i = c.indexOf('function ' + name + '(');
  let d = 0;
  let s = false;
  let o = '';
  for (let k = i; k < c.length; k++) {
    const ch = c[k];
    o += ch;
    if (ch === '{') {
      d++;
      s = true;
    } else if (ch === '}') {
      d--;
      if (s && d === 0) break;
    }
  }
  return o;
}
function sf(s) {
  return s
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)\s*=>/g, '($1) =>')
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)(?!\s*=>)/g, '($1)')
    .replace(/(\bfunction\s+[A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*:\s*[A-Za-z_$][\w$]*/g, '$1($2)')
    .replace(/(\b(?:let|const|var)\s+[A-Za-z_$][\w$]*)\s*:\s*[^=;]*?(?==|;)/g, '$1')
    .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '');
}
const mod = new Function(sf(grab('stripComments')) + '\n' + sf(grab('toJs')) + '\nreturn {stripComments,toJs};')();
globalThis.__mod = mod;
const SRC = readFileSync('entrypoints/content-panel.content.ts', 'utf8');
const stripped = mod.stripComments(SRC);
const at = stripped.indexOf('const openLogin = async');
console.log('at', at);
function bb(s, i) {
  let d = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') {
      d--;
      if (d === 0) return s.slice(i, k + 1);
    }
  }
  return '';
}
const braceAt = stripped.indexOf('{', stripped.indexOf('=>', at) + 2);
const raw = bb(stripped, braceAt);
const pre = mod.toJs(raw.slice(1, -1));
console.log('raw 里含 login/open?', raw.includes('login/open'));
console.log('pre 里含 login/open?', pre.includes('login/open'));
const i2 = pre.indexOf('sendMessage');
console.log('pre 附近:', JSON.stringify(pre.slice(i2 - 120, i2 + 120)));
