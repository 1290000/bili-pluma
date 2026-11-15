// 静态对比：account/summary vs streaming/status
//
// 目标（Lead 指定）：
//   1. 两者在 background.ts 的注册方式
//   2. 两者的 messages.ts 定义形状
//   3. 发送方位置与时机
//   4. content-panel.content.ts:437-450 控制流有没有提前 return
//
// 全部静态，不开浏览器。
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const bg = read('D:/Projects/Pluma/entrypoints/background.ts');
const panel = read('D:/Projects/Pluma/entrypoints/content-panel.content.ts');
const msgs = read('D:/Projects/Pluma/src/shared/types/messages.ts');

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const lines = (s) => s.split('\n');

console.log('='.repeat(70));
console.log('【1】background.ts 里两个 handler 的注册形式');
console.log('='.repeat(70));

for (const t of ['account/summary', 'streaming/status']) {
  const i = bg.indexOf(`type === '${t}'`);
  if (i < 0) {
    console.log(`\n### ${t}: ❌ 找不到`);
    continue;
  }
  const ln = lineOf(bg, i);
  const start = bg.lastIndexOf('\n', i);
  // 取到下一个 `return true;` 结束
  const endIdx = bg.indexOf('return true;', i);
  const block = bg.slice(start, endIdx + 'return true;'.length);
  console.log(`\n### ${t}  (background.ts:${ln})`);
  console.log(block);
}

console.log('\n' + '='.repeat(70));
console.log('【2】messages.ts 里的类型定义');
console.log('='.repeat(70));

for (const t of ['account/summary', 'streaming/status']) {
  const i = msgs.indexOf(`'${t}'`);
  if (i < 0) {
    console.log(`\n### ${t}: ❌ 找不到`);
    continue;
  }
  const ln = lineOf(msgs, i);
  // 往回找这句的起点
  const start = msgs.lastIndexOf('\n', i - 1);
  const end = msgs.indexOf('\n', i);
  console.log(`\n### ${t}  (messages.ts:${ln})`);
  console.log('  ' + msgs.slice(start + 1, end).trim());
  // 也打印回来
  const okIdx = msgs.indexOf(`${t}:ok`);
  if (okIdx >= 0) {
    const okLn = lineOf(msgs, okIdx);
    const okStart = msgs.lastIndexOf('\n', okIdx - 1);
    const okEnd = msgs.indexOf('\n', okIdx);
    console.log(`  → 应答: ${msgs.slice(okStart + 1, okEnd).trim()}   (messages.ts:${okLn})`);
  }
}

console.log('\n' + '='.repeat(70));
console.log('【3】content-panel.content.ts 里发送方的位置与上下文');
console.log('='.repeat(70));

for (const t of ['account/summary', 'streaming/status']) {
  const re = new RegExp(`sendMessage\\(\\{\\s*type:\\s*'${t.replace('/', '\\/')}'`, 'g');
  let m;
  let n = 0;
  while ((m = re.exec(panel)) !== null) {
    n++;
    const ln = lineOf(panel, m.index);
    console.log(`\n### ${t}  #{n}  (content-panel.content.ts:${ln})`);
    const start = panel.lastIndexOf('\n', m.index);
    const end = panel.indexOf('\n', m.index);
    // 打印函数体上下文
    const ctxStart = Math.max(0, m.index - 600);
    console.log(panel.slice(ctxStart, end + 300).split('\n').slice(-22).join('\n'));
  }
  if (!n) console.log(`\n### ${t}: ❌ 找不到发送方`);
}

console.log('\n' + '='.repeat(70));
console.log('【4】:437-450 的控制流：有没有提前 return');
console.log('='.repeat(70));

const ls = lines(panel);
// 找 async main(ctx)
const mainStart = ls.findIndex((l) => /async main\(ctx/.test(l));
console.log(`  async main(ctx) 在第 ${mainStart + 1} 行`);

// 打印 437-452（1-based → 0-based 436..451）
console.log('\n--- content-panel.content.ts:437-452 ---');
for (let i = 436; i <= 451; i++) {
  console.log(`${String(i + 1).padStart(4)} | ${ls[i]}`);
}

console.log('\n--- main() 里 :437 之前的所有 return（会跳过 :449 的）---');
let found = 0;
for (let i = mainStart; i < 449; i++) {
  const t = ls[i];
  // 只看顶层缩进 4 个空格的 return（main 体内直接 return）
  if (/^ {4}return\b/.test(t)) {
    console.log(`  ⚠️  L${i + 1}: ${t.trim()}`);
    found++;
  }
}
if (!found) console.log('  ✅ 没有顶层 return 会跳过 :449');

console.log('\n--- paint() 定义范围与内部 return ---');
const paintStart = ls.findIndex((l) => /const paint = \(\)/.test(l));
console.log(`  paint() 在 L${paintStart + 1}`);
// 找 paint 的结束（下一个同缩进的 `};`）
let paintEnd = -1;
for (let i = paintStart + 1; i < ls.length; i++) {
  if (/^ {4}\};?\s*$/.test(ls[i])) {
    paintEnd = i;
    break;
  }
}
console.log(`  paint() 结束于 L${paintEnd + 1}`);
console.log('\n  paint() 内部的 return：');
for (let i = paintStart; i <= paintEnd && i < ls.length; i++) {
  if (/\breturn\b/.test(ls[i])) console.log(`    L${i + 1}: ${ls[i].trim()}`);
}

console.log('\n' + '='.repeat(70));
console.log('【5】readPanelEntryEnabled —— :437 会不会抛');
console.log('='.repeat(70));
const rp = panel.indexOf('readPanelEntryEnabled');
const rpDef = panel.indexOf('readPanelEntryEnabled =');
console.log(panel.slice(Math.max(0, panel.indexOf('const readPanelEntryEnabled') - 200), panel.indexOf('const readPanelEntryEnabled') + 800));
