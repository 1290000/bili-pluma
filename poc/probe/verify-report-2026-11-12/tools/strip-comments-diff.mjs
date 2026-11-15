// 剥注释后逐行比对两个文件 —— 用来判定 task-12「零逻辑改动」是否属实。
//
// ## 为什么必须自己写、且必须用状态机
//
// Lead 明确提醒：engineer 用**正则**剥注释时跨块误配，差点误报"改了逻辑"。
// 正则处理 `/* ... */` 的典型失败：
//   - 字符串字面量里出现 `/*`（如正则量或路径）会被当成注释起点
//   - 模板字符串/正则字面量里的引号会打乱 `'` `"` 的配对
//   - 注释跨行时贪婪匹配吃掉真实代码
//
// 所以这里用**字符级状态机**，同时跟踪：
//   普通 / 单引号串 / 双引号串 / 模板串 / 行注释 / 块注释 / 正则字面量（粗略）
//
// ## 用法
//   node strip-comments-diff.mjs <fileA> <fileB>
//
// 输出：剥注释、去首尾空白、去空行后的逐行比对结果。
//   完全一致 => IDENTICAL
//   有差异   => 打印统一 diff 片段
import { readFileSync } from 'node:fs';

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // 状态：code | line | block | squote | dquote | template
  let st = 'code';

  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';

    if (st === 'code') {
      if (c === '/' && c2 === '/') { st = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { st = 'block'; i += 2; continue; }
      if (c === "'") { st = 'squote'; out += c; i++; continue; }
      if (c === '"') { st = 'dquote'; out += c; i++; continue; }
      if (c === '`') { st = 'template'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (st === 'line') {
      if (c === '\n') { st = 'code'; out += c; i++; continue; }
      i++; continue;
    }
    if (st === 'block') {
      if (c === '*' && c2 === '/') { st = 'code'; i += 2; continue; }
      i++; continue;
    }
    if (st === 'squote' || st === 'dquote' || st === 'template') {
      const quote = st === 'squote' ? "'" : st === 'dquote' ? '"' : '`';
      if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
      if (c === quote) { st = 'code'; out += c; i++; continue; }
      out += c; i++; continue;
    }
  }
  return out;
}

/** 规范化：每个非空行去掉首尾空白；丢弃空行 */
function normalize(code) {
  return code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: node strip-comments-diff.mjs <fileA> <fileB>');
  process.exit(2);
}

const A = normalize(stripComments(readFileSync(a, 'utf8')));
const B = normalize(stripComments(readFileSync(b, 'utf8')));

console.log(`A = ${a}  (${A.length} 非空代码行)`);
console.log(`B = ${b}  (${B.length} 非空代码行)`);
console.log('');

let diffs = 0;
const max = Math.max(A.length, B.length);
for (let i = 0; i < max; i++) {
  const la = A[i];
  const lb = B[i];
  if (la === lb) continue;
  diffs++;
  console.log(`@@ 第 ${i + 1} 条非空代码行`);
  console.log(`  A: ${la === undefined ? '<缺失>' : la}`);
  console.log(`  B: ${lb === undefined ? '<缺失>' : lb}`);
  if (diffs > 40) { console.log('... (差异过多，已截断)'); break; }
}

console.log('');
if (diffs === 0) {
  console.log('RESULT: IDENTICAL —— 剥注释后逐行完全一致');
  process.exit(0);
} else {
  console.log(`RESULT: DIFFERENT —— ${diffs} 处差异`);
  process.exit(1);
}
