// 产物结构分析：onMessage listener 的真实范围 + streaming/status 落在哪
import fs from 'node:fs';

const c = fs.readFileSync('.output/chrome-mv3/background.js', 'utf8');

const show = (idx, before = 200, after = 300) => {
  const s = Math.max(0, idx - before);
  return c.slice(s, idx + after);
};

console.log('='.repeat(70));
console.log('【1】listener 起点');
console.log('='.repeat(70));
const listenIdx = c.indexOf('chrome.runtime.onMessage.addListener');
console.log(`位置 ${listenIdx}`);
console.log(show(listenIdx, 50, 500));

console.log('\n' + '='.repeat(70));
console.log('【2】streaming/status 三处上下文');
console.log('='.repeat(70));
let i = -1;
let n = 0;
while ((i = c.indexOf('streaming/status', i + 1)) >= 0) {
  n++;
  console.log(`\n--- #${n} @${i} ---`);
  console.log(show(i, 300, 200));
}

console.log('\n' + '='.repeat(70));
console.log('【3】account/summary 在 listener 附近的那两处');
console.log('='.repeat(70));
for (const idx of [40977, 41057]) {
  console.log(`\n--- @${idx} ---`);
  console.log(show(idx, 250, 200));
}

console.log('\n' + '='.repeat(70));
console.log('【4】listener 在哪里结束？找配对的闭包');
console.log('='.repeat(70));
// 从 listener 起点开始做括号配对
let depth = 0;
let started = false;
let end = -1;
for (let k = listenIdx; k < c.length; k++) {
  const ch = c[k];
  if (ch === '(') { depth++; started = true; }
  else if (ch === ')') {
    depth--;
    if (started && depth === 0) { end = k; break; }
  }
}
console.log(`listener 区间大约 ${listenIdx} .. ${end}`);
console.log(`该区间长度 ${end - listenIdx} 字符`);
console.log(`streaming/status 是否在区间内: 42393 -> ${42393 >= listenIdx && 42393 <= end}`);

console.log('\n--- listener 最后 400 字符 ---');
console.log(c.slice(Math.max(0, end - 400), end + 50));
