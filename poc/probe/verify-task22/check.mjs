// task-23 独立核实 B/C：验证 task-22 三处改动在「剥注释后的源码」上真的成立，
// 并验证测试里那个 stripComments() 在**两个方向上**都有效（假红 + 假绿）。
//
// 只读，不写任何源码。

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

const EMPTY_CATCH = /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/;
const raw = readFileSync('entrypoints/background.ts', 'utf8');
const src = stripComments(raw);

console.log('=== 1. 空 catch 是否真的没了（剥离注释后） ===');
console.log('RAW     出现次数:', (raw.match(EMPTY_CATCH) ?? []).length);
console.log('STRIPPED 出现次数:', (src.match(EMPTY_CATCH) ?? []).length);

const start = src.indexOf("if (result.reason === 'incognito-disabled')");
const end = src.indexOf("reason: 'unknown'", start);
console.log('分支定位:', start > -1 && end > start ? 'OK' : 'FAILED');
const branch = src.slice(start, end);
console.log('分支内空 catch:', EMPTY_CATCH.test(branch));
console.log('分支内 catch (e):', /catch\s*\(\s*e\s*\)/.test(branch));
console.log('分支内 error=:', branch.includes('error='));
console.log('分支内 id=:', branch.includes('id='));
console.log('分支内 url=:', branch.includes('url='));

console.log('');
console.log('=== 2. stripComments 两个方向的自检（关键） ===');
// 假红方向：注释里写了 .catch(() => {})，代码里没有 -> 剥离后不应命中
const fakeRedProbe = 'const a = 1; // 旧代码是 .catch(() => {})\nconst b = 2;\n';
console.log('假红方向(注释含目标/代码无) 剥离后命中:', EMPTY_CATCH.test(stripComments(fakeRedProbe)), '(期望 false)');

// 假绿方向：判据若是"必须包含 id="，注释里写 id= 不应让代码通过
const fakeGreenProbe = '/* diag 会记 id= used */\nconst real = 1;\n';
const strippedFG = stripComments(fakeGreenProbe);
console.log('假绿方向(注释含 id=/代码无) 剥离后仍含 id=:', strippedFG.includes('id='), '(期望 false)');

// 块注释跨行 + 字符串里的 /* 不应误吞（本项目 task-12 踩过）
const tricky = 'const s = "/* not a comment */";\nconst keep = 42;\n/*\n多行注释含 id=\n*/\nconst after = 7;\n';
const st = stripComments(tricky);
console.log('字符串内 /* 未被误吞:', st.includes('keep = 42'), '(期望 true)');
console.log('块注释后代码保留:', st.includes('after = 7'), '(期望 true)');
console.log('块注释内 id= 已剥离:', !st.includes('id='), '(期望 true)');

console.log('');
console.log('=== 3. login-outcome.ts 文案核实 ===');
const lo = readFileSync('src/content/panel/login-outcome.ts', 'utf8');
console.log('含「再点一次」:', lo.includes('再点一次'));
const strippedLo = stripComments(lo);
console.log('剥离注释后含「再点一次」:', strippedLo.includes('再点一次'), '(注释里可以出现，代码里不行)');
console.log('含「关着的」:', strippedLo.includes('关着的'));
console.log('含「扩展详情页」:', strippedLo.includes('扩展详情页'));
console.log('含「InPrivate」:', strippedLo.includes('InPrivate'));
console.log('含「已经开着」:', strippedLo.includes('已经开着'));
// 归因扫描
for (const blame of ['你关闭', '你关掉', '你手动', '被系统', '浏览器自动']) {
  console.log(`  归因「${blame}」:`, strippedLo.includes(blame));
}
