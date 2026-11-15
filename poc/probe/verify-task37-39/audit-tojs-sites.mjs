/**
 * task-42 · 查 `toJs()` 这类「从 TS 源码切函数体 + new Function 重建」的探针，
 * 是否**正在把一段语法错误的代码当被测对象**（即：探针根本跑不起来，测试却在绿的）。
 *
 * ## 为什么这条比 RV 更值得查
 *
 * 一个探针如果 `new Function` 抛 `SyntaxError`，两种命运完全不同：
 * - **红**：至少你知道它坏了（`orphan-guard.test.ts` 那 8 条就是这样暴露的）
 * - **绿**：说明有一层 catch 吞掉了它，或者断言本身写成了"不抛就过"——
 *   这时测试**看起来在验行为，其实连被测函数都没构造出来**
 *
 * 本脚本对每个已知探针站点做三件事：
 * 1. 找到它的 `toJs()`（或等价剥离函数）实现，原样搬过来跑
 * 2. 用它处理真实源码，`new Function` 编译
 * 3. 报告：能否编译 / 编不过时的位置
 *
 * 用法：node poc/probe/verify-task37-39/audit-tojs-sites.mjs
 */
import { readFileSync } from 'node:fs';

const SITES = [
  { file: 'tests/unit/content/panel/orphan-guard.test.ts', src: 'entrypoints/content-panel.content.ts', fn: 'openLogin' },
  { file: 'tests/unit/content/panel/orphan-hint.test.ts', src: 'entrypoints/content-panel.content.ts', fn: 'openLogin' },
  {
    file: 'tests/unit/content/panel/incognito-panel-notice.test.ts',
    src: 'entrypoints/content-panel.content.ts',
    fn: 'openLogin',
  },
];

/** 按花括号配平截出 `function name(...) {…}` 原文 */
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
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

/** 把 helper 自己身上的 TS 标注剥掉，好让 new Function 能编译 helper */
function stripFnTypes(s) {
  return s
    .replace(/(\bfunction\s+[A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*:\s*[A-Za-z_$][\w$]*/g, '$1($2)')
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)\s*=>/g, '($1) =>')
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)(?!\s*=>)/g, '($1)')
    .replace(/(\b(?:let|const|var)\s+[A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, '$1 =')
    .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '');
}

const braceBlockJs = `function braceBlock(s, i){let d=0;for(let k=i;k<s.length;k++){const ch=s[k];if(ch==='{')d++;else if(ch==='}'){d--;if(d===0)return s.slice(i,k+1)}}return '';}`;

console.log('探针站点审计：toJs() 能否处理真实源码\n');
let allOk = true;
for (const site of SITES) {
  const test = readFileSync(site.file, 'utf8');
  const toJs = grab(test, 'toJs');
  const stripComments = grab(test, 'stripComments');
  const label = site.file.replace('tests/unit/content/panel/', '');
  if (!toJs) {
    console.log(`⚠️  ${label}：找不到 toJs()`);
    continue;
  }
  let mod;
  try {
    // eslint-disable-next-line no-new-func
    mod = new Function(
      stripFnTypes(stripComments ?? 'function stripComments(x){return x;}') +
        '\n' +
        'const toJs = ' +
        stripFnTypes(toJs).replace(/^function toJs/, 'function') +
        '\n' +
        braceBlockJs +
        '\nreturn { stripComments, toJs, braceBlock };',
    )();
  } catch (e) {
    console.log(`🔴 ${label}：连 toJs 本身都搬不过来 —— ${e.message}`);
    allOk = false;
    continue;
  }
  const SRC = readFileSync(site.src, 'utf8');
  const code = mod.stripComments(SRC);
  const at = code.indexOf('const openLogin = async');
  const block = mod.braceBlock(code, code.indexOf('{', code.indexOf('=>', at) + 2));
  const js = mod.toJs(block.slice(1, -1));
  let ok = true;
  let msg = '';
  try {
    // eslint-disable-next-line no-new-func
    new Function(js);
  } catch (e) {
    ok = false;
    msg = e.message;
    allOk = false;
  }
  console.log(`${ok ? '✅' : '🔴'} ${label.padEnd(32)} ${ok ? 'toJs 输出可编译' : `编译失败：${msg}`}`);
  // 顺带查：这段代码里是否还有 TS 标注残留（变量声明 / 参数 / as）
  const residue = js
    .split('\n')
    .map((l, k) => [k + 1, l])
    .filter(([, l]) => /\b(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*:\s*\S/.test(l));
  if (residue.length) {
    console.log('    残留变量类型标注：');
    for (const [n, l] of residue) console.log(`      :${n} ${l.trim()}`);
  }
}

console.log(
  allOk
    ? '\n✅ 三个站点当前都能编译（历史假绿不受影响，但要知道它们曾经编不过）'
    : '\n🔴 仍有站点编不过 —— 那个文件的测试要么全红，要么有东西在吞异常',
);
process.exit(allOk ? 0 : 1);
