// 核对"Receiving end does not exist"的成因（不猜，只核对已知事实）
//
// ## 已确认的事实（产物层）
//   1. listener 只有 1 处，@40553，在 `_n = t(()=>{ ... })` 工厂函数体内
//   2. `_n.main()` 在 @43393，由 `try{ yn=_n.main() }` 同步调用
//   3. `_n` 是 `t(()=>{...})` 的产物 —— WXT 的 `t()` = `e==null||typeof e==`function`?{main:e}:e`
//      → 即 `{main: ()=> {...}}`，**main 是同步函数**
//   4. streaming/status 分支 @42393 在 listener 区间 [40553,43041] 内
//   5. listener 注册是 main() 体内**第一条语句**（`Qt().then(...)` 与 `rn().then(...)` 都不 await）
//
// ## 因此产物层无法解释"Receiving end does not exist"。
//    本脚本只做最后一件事：核对 WXT 的 `t()` 包装是否会丢掉 main
import fs from 'node:fs';

const c = fs.readFileSync('.output/chrome-mv3/background.js', 'utf8');

console.log('='.repeat(70));
console.log('【1】WXT 的 t() 包装函数原文');
console.log('='.repeat(70));
const tDef = 'function t(e){return e==null||typeof e==`function`?{main:e}:e}';
const i = c.indexOf(tDef);
console.log(i >= 0 ? `✅ 找到 @${i}` : '❌ 未找到原文，实际形态：');
if (i < 0) {
  const m = c.match(/function t\(e\)\{[^}]*\}/);
  console.log(m ? m[0] : '(未匹配)');
} else {
  console.log(`  ${tDef}`);
  console.log('  → 传函数进去 ⇒ {main: e}；传对象进去 ⇒ 原样返回');
}

console.log('\n' + '='.repeat(70));
console.log('【2】_n 的完整定义开头（确认是 t(()=>{...})）');
console.log('='.repeat(70));
const nStart = c.indexOf('var _n=t(()=>{');
console.log(`var _n=t(()=>{  @${nStart}`);
console.log(c.slice(nStart, nStart + 200));

console.log('\n' + '='.repeat(70));
console.log('【3】main() 里 listener 之前有没有 await（本次具体核对）');
console.log('='.repeat(70));
const bodyStart = nStart + 'var _n=t(()=>{'.length;
const seg = c.slice(bodyStart, 40553);
console.log(`  main body 起点 ${bodyStart} → listener 40553，长度 ${40553 - bodyStart}`);
console.log(`  段内 "await" 出现次数: ${[...seg.matchAll(/await /g)].length}`);
console.log('\n--- 段内原文 ---');
console.log(seg);

console.log('\n' + '='.repeat(70));
console.log('【4】结论');
console.log('='.repeat(70));
const awaitsInSeg = [...seg.matchAll(/await /g)].length;
if (awaitsInSeg === 0) {
  console.log('  ✅ main() 在注册 listener 之前 **没有任何 await**');
  console.log('  ✅ 所以 listener 在 SW 启动的同步阶段就注册好了');
  console.log('  → 产物层无法解释 "Receiving end does not exist"');
} else {
  console.log(`  ⚠️ 注册 listener 之前有 ${awaitsInSeg} 处 await`);
  console.log('  → 这会让 listener 的注册延迟到微任务之后');
}
