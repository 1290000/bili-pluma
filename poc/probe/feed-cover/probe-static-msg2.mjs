// 关键验证：扩展重载后，页面上的面板是「新实例画的」还是「旧实例的僵尸 DOM」
//
// ## 为什么这条重要
//   `ctx.onInvalidated` → `removePanelHost()` 会在扩展失效时摘掉面板。
//   但如果摘除失败（或时序错过），用户看到的是**旧 content script 画的 DOM**，
//   它的 JS 已失效 —— 那胶囊当然永远不出现，而且刷新页面才恢复。
//
// ## 本探针只能读 DOM 侧证据（进不了 ISOLATED），所以判据设计为：
//   ① 面板 host 是否带某个"创建时刻"标记
//   ② 面板内是否有 Vue / 自定义属性的时间戳
//   ③ 最有力：**把面板摘掉（关开关）再挂上（开开关），看新实例画的有没有胶囊**
//      —— 前提是开关能触发 removePanelHost + paint()
//
// ## 但更简单的一个判据（不需要任何假设）：
//   在**同一个页面**上，等一段时间后重新打开面板，看胶囊是否出现。
//   若只是"首次读失败被缓存"，那永远不会出现（已实测：刷新后也不出现）。
//   若面板是僵尸，刷新后应该是新的 —— 也已实测不出现。
//
// → 所以僵尸假设**已经被刷新实验排除**：刷新后 content script 全新跑，面板必然是新画的。
//
// 本脚本改做另一件有意义的静态核查：确认 `streaming/status` 的应答类型
// 在 messages.ts 里是否有 **两处定义**导致联合类型收窄失败。
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const msgs = read('D:/Projects/Pluma/src/shared/types/messages.ts');

console.log('='.repeat(70));
console.log('【A】messages.ts 里所有含 streaming 的联合成员');
console.log('='.repeat(70));
const ls = msgs.split('\n');
ls.forEach((l, i) => {
  if (/streaming/i.test(l) && /type:/.test(l)) {
    console.log(`${String(i + 1).padStart(4)} | ${l.trim()}`);
  }
});

console.log('\n' + '='.repeat(70));
console.log('【B】依赖名字：readStreamingIdentity 从哪 import');
console.log('='.repeat(70));
const bg = read('D:/Projects/Pluma/entrypoints/background.ts');
bg.split('\n').forEach((l, i) => {
  if (/readStreamingIdentity|switchStreamingIdentity/.test(l) && /import|from/.test(l)) {
    console.log(`${String(i + 1).padStart(4)} | ${l.trim()}`);
  }
});
// 打印 background.ts 的 import 段
const importEnd = bg.indexOf('\n\n', bg.lastIndexOf('from '));
console.log('\n--- background.ts 前 60 行 import ---');
console.log(bg.split('\n').slice(0, 60).join('\n'));

console.log('\n' + '='.repeat(70));
console.log('【C】readStreamingIdentity 的实现（谁导出的）');
console.log('='.repeat(70));
const candidates = [
  'D:/Projects/Pluma/src/platform/storage/streaming-identity-store.ts',
  'D:/Projects/Pluma/src/shared/constants/streaming-identity.ts',
];
for (const p of candidates) {
  if (!fs.existsSync(p)) continue;
  const s = read(p);
  if (/export .*readStreamingIdentity/.test(s)) {
    console.log(`\n--- ${p} ---`);
    console.log(s);
  } else {
    console.log(`\n--- ${p}（无 readStreamingIdentity 导出）---`);
    console.log(s.slice(0, 1200));
  }
}
