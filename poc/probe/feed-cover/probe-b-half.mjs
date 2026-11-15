// B 半证据（替代路径）：从 DOM 侧反复触发面板重挂载，观察胶囊是否出现
//
// ## 为什么需要这条路径
//   bsk evaluate 只能进 main world，没有 chrome.runtime
//   bsk 无 --world isolated
//   bsk debug pages 只给主框架（coverage 明确写 worker_targets_not_captured）
//   → 从外部进不了 ISOLATED world
//
// ## 但有一条不需要 ISOLATED 的观测路径
//   面板的 `streamingIdentity` 是挂载那一刻读的（content-panel.content.ts:449）
//   而 `paint()` 在 `sidebar !== null` 时直接 return（:383），不重建
//   → 若把面板摘掉（关开关）再挂上（开开关），会重新走一次 `ensureStreamingIdentityRead()`
//
//   ⚠️ `ensureStreamingIdentityRead` 有缓存（:361）：只有 `undefined` 才去读
//   但缓存是 content script 模块级变量 —— 摘/挂面板不会重置它
//   → 所以"重挂载"**不会**重新发消息，只会用缓存值重画
//
//   这就意味着：**如果首次读失败，胶囊永远不出现，除非刷新页面（content script 重跑）**
//
// ## 本探针要验证的
//   1. 面板当前有没有胶囊（已知：没有）
//   2. 刷新页面后（content script 重跑、缓存清空），胶囊是否出现
//      → 若刷新后出现 = 首次时序问题
//      → 若刷新后仍不出现 = `streaming/status` 稳定失败
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session', 'qocq');
const TAB = arg('tab', '1673235718');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const runBs = (args) =>
  execFileSync('bsk', args, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });

function snapshot() {
  const out = runBs(['snapshot', '--session', SI, '--tab-id', TAB, '--json']);
  const s = out.indexOf('{');
  return JSON.parse(out.slice(s));
}

function evaluate(expr) {
  const out = runBs(['evaluate', '--session', SI, '--tab-id', TAB, expr]);
  const s = out.indexOf('{');
  try {
    return JSON.parse(out.slice(s));
  } catch {
    return { raw: out.slice(0, 500) };
  }
}

function panelText(snap) {
  const lines = (snap.text || '').split('\n');
  const i = lines.findIndex((l) => /Pluma/.test(l));
  return i < 0 ? null : lines.slice(i).join('\n');
}

function checkCapsule(label) {
  const t = panelText(snapshot());
  const hasExt = t ? /取流：扩展账号/.test(t) : false;
  const hasPage = t ? /取流：浏览器账号/.test(t) : false;
  console.log(`\n### ${label}  →  扩展账号:${hasExt}  浏览器账号:${hasPage}`);
  return { hasExt, hasPage, text: t };
}

const results = {};

// ── 0. 当前状态 ──
results.beforeReload = checkCapsule('刷新前');

// ── 1. 刷新页面（content script 重跑 → streamingIdentityCache 重置为 undefined）──
console.log('\n=== reload 页面（让 content script 重跑）===');
try {
  runBs(['reload', '--session', SI, '--tab-id', TAB]);
} catch (e) {
  console.log('reload 失败:', String(e.message || '').slice(0, 150));
}
runBs(['wait-for-navigation', '--session', SI, '--tab-id', TAB, '--state', 'load']);

// 等面板挂载
try {
  runBs(['wait-for-element', '--session', SI, '--tab-id', TAB, '--selector', '#pluma-panel-host', '--state', 'attached']);
} catch {
  evaluate(`(async()=>{await new Promise(r=>setTimeout(r,3000));return JSON.stringify({ok:1})})()`);
}

const st = evaluate(`(() => {
  const h = document.getElementById('pluma-panel-host');
  if (!h) return JSON.stringify({ panelHost: false });
  const r = h.getBoundingClientRect();
  return JSON.stringify({ panelHost: true, w: Math.round(r.width), h: Math.round(r.height) });
})()`);
console.log('  面板状态:', JSON.stringify(st));

if (st.panelHost && (st.w ?? 0) < 20) {
  console.log('  → 点开面板');
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '--selector', '#pluma-panel-host']);
  } catch (e) {
    console.log('  点击失败:', String(e.message || '').slice(0, 150));
  }
  evaluate(`(async()=>{await new Promise(r=>setTimeout(r,1500));return JSON.stringify({ok:1})})()`);
}

// 切到账号 Tab
const snapNow = snapshot();
const accLine = (snapNow.text || '').split('\n').find((l) => /@e\d+ tab "账号"/.test(l));
if (accLine) {
  const ref = (accLine.match(/@(e\d+)/) || [])[1];
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
  } catch {}
  evaluate(`(async()=>{await new Promise(r=>setTimeout(r,1500));return JSON.stringify({ok:1})})()`);
}

results.afterReload = checkCapsule('刷新后（账号 Tab）');

console.log('\n\n=== 汇总 ===');
console.log(JSON.stringify({ before: { ...results.beforeReload, text: undefined }, after: { ...results.afterReload, text: undefined } }, null, 2));

fs.writeFileSync('D:/Temp/b-half.json', JSON.stringify(results, null, 2), 'utf8');

console.log('\n=== 判定 ===');
if (results.afterReload.hasExt || results.afterReload.hasPage) {
  console.log('✅ 刷新后胶囊出现 → 首次读取时序问题（缓存了 null）');
} else {
  console.log('❌ 刷新后胶囊仍不出现 → streaming/status 稳定失败（不是时序）');
}
