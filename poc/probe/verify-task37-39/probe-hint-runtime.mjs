/**
 * 用**测试文件自己的** stripComments / braceBlock / toJs，按**测试自己的调用方式**
 * 构造 `openLogin`，然后真的跑一次。
 *
 * 目的：回答「toJs 输出 `new Function` 编不过」到底影响不影响断言。
 * 关键差别在这里：`orphan-hint.test.ts` 的 `braceBlock(code, s.indexOf('{', s.indexOf('=>', at)+2))`
 * 与我先前那版 `code.indexOf('=>', at)` 起算点不同 —— 起算点错，切出来的块就错。
 *
 * 用法：node poc/probe/verify-task37-39/probe-hint-runtime.mjs
 */
import { readFileSync } from 'node:fs';

const TEST = 'tests/unit/content/panel/orphan-hint.test.ts';
const SRC = 'entrypoints/content-panel.content.ts';

const test = readFileSync(TEST, 'utf8');

/** 按名字截出 `function name(…) {…}`（跳过参数与返回类型里的花括号） */
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let k = src.indexOf('(', i);
  let pd = 0;
  for (; k < src.length; k++) {
    if (src[k] === '(') pd++;
    if (src[k] === ')') {
      pd--;
      if (pd === 0) break;
    }
  }
  // 先看 `)` 之后是不是返回类型标注（`: T`）。是的话类型里**不会有花括号**，
  // 直接跳到函数体的 `{`；不是的话下一个 `{` 本来就是函数体开头。
  let j = k + 1;
  while (j < src.length && (src[j] === ' ' || src[j] === '\n' || src[j] === '\r')) j++;
  if (src[j] === ':') {
    while (j < src.length && src[j] !== '{') j++;
  }
  let depth = 0;
  let started = false;
  let out = '';
  for (; j < src.length; j++) {
    out += src[j];
    if (src[j] === '{') {
      depth++;
      started = true;
    } else if (src[j] === '}') {
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
    stripFnTypes(grab(test, 'braceBlock')) +
    '\n' +
    stripFnTypes(grab(test, 'toJs')) +
    '\nreturn { stripComments, braceBlock, toJs };',
)();

const code = mod.stripComments(readFileSync(SRC, 'utf8'));
const at = code.indexOf('const openLogin = async');
console.log('stripComments 后能找到 openLogin?', at > -1, '@', at);
const block = mod.braceBlock(code, code.indexOf('{', code.indexOf('=>', at) + 2));
console.log('切出的块长度 =', block.length, '首字符 =', JSON.stringify(block[0]), '末字符 =', JSON.stringify(block.at(-1)));
const js = mod.toJs(block.slice(1, -1));
console.log('toJs 后长度 =', js.length);

let err = null;
try {
  new Function(js);
} catch (e) {
  err = e;
}
console.log('new Function 直接编译：', err === null ? '✅ 通过' : `🔴 ${err.message}`);

// 按测试的写法重建：const openLogin = async () => {…}
const wrapper = `"use strict";
       const openLogin = async () => {${js}};
       return openLogin;`;
let fn = null;
let werr = null;
try {
  fn = new Function(
    'chrome',
    'controller',
    'readAccountMid',
    'startLoginPolling',
    'stopPolling',
    'describeLoginOutcome',
    'isOrphanError',
    'showOrphanHint',
    'isOrphanHintShown',
    wrapper,
  );
} catch (e) {
  werr = e;
}
console.log('按测试写法包成 async 箭头：', werr === null ? '✅ 通过' : `🔴 ${werr.message}`);

if (!werr) {
  const calls = { hint: 0, notice: 0 };
  const run = fn(
    { runtime: { id: 'x', sendMessage: async () => { throw new Error('Extension context invalidated.'); } } },
    null,
    async () => ({ mid: 1 }),
    () => ({ stop: () => undefined }),
    () => undefined,
    () => ({ text: 'stub', ok: true, shouldPoll: false }),
    (e) => /Extension context invalidated/i.test(String(e)),
    () => (calls.hint += 1),
    () => true,
  );
  let runErr = null;
  try {
    await run();
  } catch (e) {
    runErr = e;
  }
  console.log(
    `执行（controller=null + send 抛孤儿错）：${runErr ? '抛出 ' + runErr.message : '无异常'}，hint=${calls.hint}`,
  );
  console.log(
    calls.hint >= 1
      ? '✅ 这条探针**确实在执行真实函数体**（孤儿提示被调到）'
      : '🔴 hint=0 —— 这条探针跑的不是它声称的东西',
  );
}
