// M5：关代理后 primaryReason 是 ssr 还是 client-written（"关掉代理即可"已证不成立）
//
// ## 判据
//   关总开关 → 刷新视频页 → 读 primaryReason
//   - `ssr`          → 正常（没粘住）
//   - `client-written` → **粘住**（问题仍在）
//
// ## 怎么读 primaryReason
//   `page/snapshot:ok` 的 snapshot 里没有这个字段，
//   但 `poc/probe/verify-pgc-by-snapshot.mjs` 走的是 bsk snapshot（看文案）。
//   这里用页面里的 `__INITIAL_STATE__` 或 SSR 存在性做判据：
//   - `window.__playinfo__` 存在 → SSR 数据（primaryReason = ssr）
//   - 不存在 → 已被客户端改写（client-written）
//
// ⚠️ 但 Pluma 会主动隐藏 __playinfo__（ADR 0010）。所以更可靠的是读
//   `page/snapshot` 的 `primary.source` 字段（已实测存在：`"source":"live"`）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session');
const TAB = arg('tab');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const runBs = (args) =>
  execFileSync('bsk', args, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
const evaluate = (expr) => {
  const out = runBs(['evaluate', '--session', SI, '--tab-id', TAB, expr]);
  const i = out.search(/[{[]/);
  try {
    return JSON.parse(out.slice(i));
  } catch {
    return { raw: out.slice(0, 400) };
  }
};
const sleep = (ms) => evaluate(`(async()=>{await new Promise(r=>setTimeout(r,${ms}));return JSON.stringify({ok:1})})()`);

// 用 postMessage 桥读 page/snapshot（content.ts 已注入的页面才有）
const BRIDGE = `(async () => {
  const r = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
        clearTimeout(t); window.removeEventListener('message', h);
        resolve({ ok: true, snapshot: e.data.snapshot });
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
  });
  return JSON.stringify(r);
})()`;

// 用 set-proxy 桥拨总开关
const setProxy = (enabled) => `(async () => {
  const r = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'set-proxy-reply') {
        clearTimeout(t); window.removeEventListener('message', h);
        resolve(e.data);
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'set-proxy', enabled: ${enabled} }, '*');
  });
  return JSON.stringify(r);
})()`;

const out = { steps: [] };
const log = (k, v) => {
  console.log(`\n### ${k}`);
  console.log(JSON.stringify(v, null, 1).slice(0, 2000));
  out.steps.push({ step: k, ...v });
};

console.log('=== M5：关代理后 primaryReason ===');
console.log('当前页面:', JSON.stringify(evaluate('JSON.stringify({h:location.href})')));

// ── 0. 基线：开代理时 ──
const before = evaluate(BRIDGE);
if (!before.ok) {
  console.log('❌ 桥不通（这页可能不是 video/bangumi 页）:', JSON.stringify(before));
  process.exit(1);
}
log('0-before（代理开着）', { primary: before.snapshot?.primary, proxy: before.snapshot?.proxy, view: before.snapshot?.view });

// ── 1. 关总开关 ──
console.log('\n=== 关总开关 ===');
const off = evaluate(setProxy(false));
console.log(JSON.stringify(off));

// ── 2. 刷新 ──
console.log('\n=== 刷新页面 ===');
try {
  runBs(['reload', '--session', SI, '--tab-id', TAB]);
} catch (e) {
  console.log('reload:', String(e.message || '').slice(0, 120));
}
sleep(10000);

// ── 3. 读 primaryReason ──
const after = evaluate(BRIDGE);
log('1-after（代理关闭）', { primary: after.snapshot?.primary, proxy: after.snapshot?.proxy, view: after.snapshot?.view });

const src = after.snapshot?.primary?.source;
console.log(`\n  ★ primary.source = ${JSON.stringify(src)}`);
console.log(`  ★ proxy = ${JSON.stringify(after.snapshot?.proxy)}`);

// ── 4. 恢复总开关 ──
console.log('\n=== 恢复总开关 ===');
const on = evaluate(setProxy(true));
console.log(JSON.stringify(on));
sleep(1500);
const restored = evaluate(BRIDGE);
log('2-restored', { proxy: restored.snapshot?.proxy });

fs.writeFileSync('D:/Temp/m5.json', JSON.stringify(out, null, 2), 'utf8');
console.log('\n→ D:/Temp/m5.json');
