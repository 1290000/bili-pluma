/**
 * 用测试文件**自己的** toJs()/stripComments() 重建 openLogin，然后**执行**一次，
 * 看它到底跑到哪一步 —— 用来回答「toJs 输出编不过」到底影响哪些断言。
 *
 * 关键：`new Function(body)` 编不过 ≠ 这段代码没被执行。若某测试把 `new Function`
 * 包在 try/catch 里、或用 `as never` 塞替身，可能整条被测路径根本没跑。
 *
 * 用法：node poc/probe/verify-task37-39/repro-tojs-syntax-error.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TEST = process.argv[2] ?? 'tests/unit/content/panel/orphan-guard.test.ts';
const SRC = 'entrypoints/content-panel.content.ts';

const test = readFileSync(TEST, 'utf8');

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
function stripFnTypes(s) {
  return s
    .replace(/(\bfunction\s+[A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*:\s*[A-Za-z_$][\w$]*/g, '$1($2)')
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)\s*=>/g, '($1) =>')
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)(?!\s*=>)/g, '($1)')
    .replace(/(\b(?:let|const|var)\s+[A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, '$1 =')
    .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '');
}

const toJsSrc = grab(test, 'toJs');
const stripSrc = grab(test, 'stripComments');
if (!toJsSrc) {
  console.log('找不到 toJs()');
  process.exit(2);
}

const prelude =
  (stripSrc ? stripFnTypes(stripSrc) : 'function stripComments(x){return x;}') +
  '\n' +
  stripFnTypes(toJsSrc) +
  '\n' +
  'function braceBlock(s,i){let d=0;for(let k=i;k<s.length;k++){const ch=s[k];if(ch==="{")d++;else if(ch==="}"){d--;if(d===0)return s.slice(i,k+1)}}return "";}' +
  '\nreturn { stripComments, toJs, braceBlock };';

const mod = new Function(prelude)();
const code = mod.stripComments(readFileSync(SRC, 'utf8'));
const at = code.indexOf('const openLogin = async');
const bodyStart = code.indexOf('{', code.indexOf('=>', at) + 2);
const block = mod.braceBlock(code, bodyStart);
const js = mod.toJs(block.slice(1, -1));
writeFileSync('poc/probe/verify-task37-39/_tojs-out.txt', js, 'utf8');

console.log('=== 用', TEST, '的 toJs() 重建 openLogin 体 ===');
console.log('体长度 =', js.length);

let err = null;
try {
  new Function(js);
} catch (e) {
  err = e;
}
console.log('new Function 直接编译：', err === null ? '✅ 通过' : `🔴 ${err.message}`);

// --- 关键一步：把它当成 async 函数体执行，看断在哪 ---
console.log('\n=== 执行一次（用代身注入全部自由变量）===');
const calls = { hint: 0, notice: 0, clearNotice: 0, send: 0, readMid: 0, poll: 0 };
let execErr = null;
try {
  const fn = new Function(
    'chrome',
    'controller',
    'readAccountMid',
    'startLoginPolling',
    'stopPolling',
    'describeLoginOutcome',
    'isOrphanError',
    'showOrphanHint',
    'isOrphanHintShown',
    'async function run(){' + js + '}',
  );
  await fn(
    { runtime: { id: 'x', sendMessage: async () => ({ type: 'login/open:ok' }) } },
    { showNotice: () => (calls.notice += 1), clearNotice: () => (calls.clearNotice += 1) },
    async () => (calls.readMid++, { mid: null }),
    () => 1,
    () => (calls.poll += 1),
    () => ({ text: 't', ok: true, shouldPoll: false }),
    () => false,
    () => (calls.hint += 1),
    () => false,
  )();
} catch (e) {
  execErr = e;
}
console.log(execErr ? `🔴 执行抛错：${execErr.message}` : '✅ 执行无异常');
console.log('调用计数：', JSON.stringify(calls));

// --- 逐行确认：toJs 输出在这两处仍是"裸代码"，没有测试能编得过 ---
console.log('\n=== 结论 ===');
console.log(
  err === null
    ? 'toJs 现在能编过（engineer 修过之后）。仍需确认：这些用例真的会因为这个函数体而红/绿，' +
        '而不是用 as never 塞了替身。'
    : 'toJs 输出的函数体编不过 ⇒ 任何「把这个函数体 new Function 起来再断言行为」的用例都构造不出被测对象。' +
        '若它们仍绿，绿的一定是别的东西。',
);
