// 用现成的 postMessage 桥拿 content script 侧的真实返回
//
// ## 为什么这条路能通（而之前四条不通）
//   `docs/guides/bsk-page-bridges.md`：content script 开了两条 页面→content 的 postMessage 桥。
//   bsk evaluate 跑在 MAIN world，但**能让页面发 postMessage**，
//   由 ISOLATED 的 content script 应答 —— 这就绕过了"主世界没有 chrome.runtime"。
//
// ## ⚠️ 必须 async IIFE + 内部 await 再 stringify
//   直接 stringify 一个 Promise 会得到 {}，看起来"成功"。
//
// ## 本探针拿什么
//   1. `snapshot` 桥 → page/snapshot:ok（含 proxy / account / lastActivateReason）
//   2. 用它判断 content script ↔ background 通道是否健康
import { execFileSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session');
const TAB = arg('tab');
if (!SI || !TAB) {
  console.error('用法：node probe-bridge.mjs --session <sid> --tab <tab>');
  process.exit(2);
}
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const evaluate = (expr) => {
  const out = execFileSync('bsk', ['evaluate', '--session', SI, '--tab-id', TAB, expr], {
    env: ENV, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024,
  });
  return out.trim();
};

// ── snapshot 桥（照抄 docs/guides/bsk-page-bridges.md §2）──
const SNAPSHOT = `(async () => {
  try {
    const snap = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('snapshot-reply 超时')), 5000);
      const h = (e) => {
        if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
          clearTimeout(t);
          window.removeEventListener('message', h);
          resolve({ snapshot: e.data.snapshot, pgcReload: e.data.pgcReload });
        }
      };
      window.addEventListener('message', h);
      window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
    });
    return JSON.stringify({ ok: true, ...snap });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
})()`;

console.log('=== [1] snapshot 桥 ===');
const raw = evaluate(SNAPSHOT);
console.log(raw.slice(0, 3000));

let parsed;
try {
  parsed = JSON.parse(raw.slice(raw.indexOf('{')));
} catch {
  parsed = null;
}

if (!parsed || !parsed.ok) {
  console.log('\n❌ 桥没应答 —— content script 可能没注入，或桥实现变了');
  process.exit(1);
}

console.log('\n=== [2] 关键字段 ===');
const s = parsed.snapshot || {};
for (const k of Object.keys(s)) {
  const v = s[k];
  const brief = JSON.stringify(v);
  console.log(`  ${k.padEnd(20)} = ${brief && brief.length > 200 ? brief.slice(0, 200) + '…' : brief}`);
}

console.log('\n=== [3] 判读 ===');
console.log(`  proxy           : ${JSON.stringify(s.proxy)}`);
console.log(`  lastActivateReason : ${JSON.stringify(s.lastActivateReason)}`);
console.log(`  account         : ${JSON.stringify(s.account)}`);
console.log(`  streamingIdentity 字段是否存在: ${'streamingIdentity' in s}`);

console.log('\n=== [4] pgcReload（ISOLATED 诊断，桥带出来的）===');
console.log(JSON.stringify(parsed.pgcReload ?? null).slice(0, 1000));
