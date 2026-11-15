// B 半补充：区分「所有消息都不通」还是「只有 streaming/status 不通」
//
// 判据：账号卡显示了 `{{取流账号昵称}}` → 说明 `account/summary` **通**（A 半已证）
// 而胶囊不出现 → `streaming/status` 的 identity 没拿到
//
// 这一层只能从代码侧定位。本脚本只做静态取证：列出两条消息的
// sendMessage / handler / 应答类型，逐层比对。
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');

const panel = read('D:/Projects/Pluma/entrypoints/content-panel.content.ts');
const bg = read('D:/Projects/Pluma/entrypoints/background.ts');
const msgs = read('D:/Projects/Pluma/src/shared/types/messages.ts');

console.log('=== 1. 发送侧：content-panel 里所有 sendMessage ===');
const sends = [...panel.matchAll(/sendMessage\(\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]);
console.log('  ', JSON.stringify([...new Set(sends)]));

console.log('\n=== 2. 接收侧：background 里所有已注册的 type ===');
const handled = [...bg.matchAll(/type === '([^']+)'/g)].map((m) => m[1]);
console.log('  ', JSON.stringify([...new Set(handled)]));

console.log('\n=== 3. 差集：发了但没人接 ===');
const missing = [...new Set(sends)].filter((s) => !handled.includes(s));
console.log('  ', JSON.stringify(missing));

console.log('\n=== 4. 消息类型定义里有 streaming/status 吗 ===');
const idx = msgs.indexOf('streaming/status');
if (idx >= 0) {
  console.log(msgs.slice(Math.max(0, idx - 400), idx + 500));
} else {
  console.log('  ❌ messages.ts 里找不到 streaming/status');
}

console.log('\n=== 5. streaming/status 的 readStreamingIdentity 实现 ===');
const smIdx = bg.indexOf('streaming/status');
console.log(bg.slice(Math.max(0, smIdx - 300), smIdx + 400));

console.log('\n=== 6. 读 streaming-identity 的 store 实现 ===');
const storePaths = [
  'D:/Projects/Pluma/src/platform/storage/streaming-identity-store.ts',
  'D:/Projects/Pluma/src/platform/storage/streaming-identity.ts',
  'D:/Projects/Pluma/src/shared/constants/streaming-identity.ts',
];
for (const p of storePaths) {
  if (fs.existsSync(p)) {
    console.log(`\n--- ${p} ---`);
    console.log(read(p).slice(0, 1800));
  }
}
