// 关键：main() 是同步还是 async？listener 在 main() 里还是外层？
//
// 产物末尾：
//   try{ yn = _n.main(); yn instanceof Promise && console.warn('...main() function return a promise, but it must be synchronous') }
//   catch(e){ throw vn.error('The background crashed on startup!'), e }
//
// → 若 main() 是 async，WXT 会警告；更严重的是 **若 main() 在注册 listener 之前 await 了什么，
//   那 listener 的注册就晚于 SW 启动**，而 chrome 的 "Receiving end does not exist"
//   恰好会在"消息发出时该消息类型的监听器尚未注册"时出现。
import fs from 'node:fs';

const c = fs.readFileSync('.output/chrome-mv3/background.js', 'utf8');

const listenIdx = c.indexOf('chrome.runtime.onMessage.addListener');
const mainIdx = c.indexOf('_n.main()');

console.log('='.repeat(70));
console.log('【1】定位');
console.log('='.repeat(70));
console.log(`onMessage listener @${listenIdx}`);
console.log(`_n.main() 调用 @${mainIdx}`);
console.log(`listener 是否在 main() 内部（即 listener < mainIdx）: ${listenIdx < mainIdx}`);

console.log('\n' + '='.repeat(70));
console.log('【2】main() 的定义在哪 —— 找 `main:` 或 `main=`');
console.log('='.repeat(70));
for (const pat of ['main:', '.main=', 'main=', 'asynс']) {
  const i = c.indexOf(pat);
  if (i >= 0) console.log(`"${pat}" @${i}: …${c.slice(Math.max(0, i - 150), i + 250)}…\n`);
}

console.log('='.repeat(70));
console.log('【3】_n 是什么 —— 找 _n 的赋值');
console.log('='.repeat(70));
const nIdx = c.lastIndexOf('_n=', mainIdx);
console.log(`_n= @${nIdx}`);
if (nIdx >= 0) console.log(c.slice(nIdx - 100, nIdx + 400));

console.log('\n' + '='.repeat(70));
console.log('【4】数一数：main() body 里有多少 await');
console.log('='.repeat(70));
// 找 main 函数体：从 `async(` 或 `(e` 附近，粗略看 listener 附近有没有 await 关键字
const around = c.slice(Math.max(0, listenIdx - 3000), listenIdx);
const awaits = [...around.matchAll(/await /g)].length;
console.log(`listener 之前 3000 字符内的 "await" 出现 ${awaits} 次`);

console.log('\n--- listener 前 800 字符 ---');
console.log(c.slice(Math.max(0, listenIdx - 800), listenIdx));

console.log('\n' + '='.repeat(70));
console.log('【5】listener 是否包含在某个 async 函数里');
console.log('='.repeat(70));
// 找 listener 之前最近的 `async` 关键字
const before = c.slice(Math.max(0, listenIdx - 5000), listenIdx);
const lastAsync = before.lastIndexOf('async');
console.log(`listener 前最近的 "async" 距 listener ${listenIdx - (Math.max(0, listenIdx - 5000) + lastAsync)} 字符`);
if (lastAsync >= 0) {
  console.log('--- 该 async 附近的代码 ---');
  const abs = Math.max(0, listenIdx - 5000) + lastAsync;
  console.log(c.slice(abs - 100, abs + 400));
}
