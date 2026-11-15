// 分析 "Receiving end does not exist" 的可能解释（纯静态 + 事实核对）
//
// 用户实测：在 background SW 的自己的 DevTools console 里
//   chrome.runtime.sendMessage({type:'streaming/status'})
//   → Uncaught (in promise) Error: Could not establish connection. Receiving end does not exist.
//
// ## 本脚本核对的事实
//   ① 产物里 listener 是**同步顶层**注册（已确认 @40553，区间 40553..43041）
//   ② streaming/status 分支在区间内（已确认 @42393）
//   ③ 那么 "Receiving end does not exist" 从何而来？
//
// ## 需要核查的：这个 listener 所在的外层作用域是否一定执行
//   listener 前面是 `,` 逗号表达式：`...catch(()=>{}),chrome.runtime.onMessage.addListener(...)`
//   说明它在一个**逗号表达式序列**里 —— 若前面某项抛错，后面不执行
import fs from 'node:fs';

const c = fs.readFileSync('.output/chrome-mv3/background.js', 'utf8');
const listenIdx = c.indexOf('chrome.runtime.onMessage.addListener');

console.log('='.repeat(70));
console.log('【1】listener 所在的语句/作用域');
console.log('='.repeat(70));

// 往前找最近的语句边界
let stmtStart = listenIdx;
for (let k = listenIdx; k > 0; k--) {
  const ch = c[k];
  if (ch === ';' || ch === '{' || ch === '}') {
    stmtStart = k + 1;
    break;
  }
}
console.log(`语句起点约 @${stmtStart}`);
console.log('--- 语句原文（前 900 字符）---');
console.log(c.slice(stmtStart, listenIdx + 120));

console.log('\n' + '='.repeat(70));
console.log('【2】这个 listener 是否在顶层（不在函数体内）？');
console.log('='.repeat(70));
// 统计 listener 之前的大括号深度
let depth = 0;
for (let k = 0; k < listenIdx; k++) {
  const ch = c[k];
  if (ch === '{') depth++;
  else if (ch === '}') depth--;
}
console.log(`listener 前的大括号深度: ${depth}`);
console.log(depth === 0 ? '  → ✅ 在模块顶层（或 IIFE 顶层）' : '  → ⚠️ 在某层花括号内');

console.log('\n' + '='.repeat(70));
console.log('【3】文件开头 —— 是不是 IIFE / 有没有前置 await');
console.log('='.repeat(70));
console.log(c.slice(0, 600));

console.log('\n' + '='.repeat(70));
console.log('【4】defineBackground 包装形态');
console.log('='.repeat(70));
for (const kw of ['defineBackground', 'main(', 'export default', 'export{']) {
  const i = c.indexOf(kw);
  if (i >= 0) console.log(`"${kw}" @${i}: …${c.slice(Math.max(0, i - 80), i + 200)}…\n`);
  else console.log(`"${kw}": 未找到\n`);
}

console.log('='.repeat(70));
console.log('【5】listener 之后到文件末尾还有什么');
console.log('='.repeat(70));
console.log(c.slice(43041, Math.min(c.length, 43041 + 900)));
