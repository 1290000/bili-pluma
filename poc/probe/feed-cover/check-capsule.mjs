// 只读检查：当前 tab 上胶囊在不在
import { execFileSync } from 'node:child_process';

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
  return JSON.parse(out.slice(out.indexOf('{')));
}

function evaluate(expr) {
  const out = runBs(['evaluate', '--session', SI, '--tab-id', TAB, expr]);
  try {
    return JSON.parse(out.slice(out.indexOf('{')));
  } catch {
    return { raw: out.slice(0, 400) };
  }
}

const sleep = (ms) =>
  evaluate(`(async()=>{await new Promise(r=>setTimeout(r,${ms}));return JSON.stringify({ok:1})})()`);

console.log('=== 1. 面板 host 状态 ===');
const st = evaluate(`(() => {
  const h = document.getElementById('pluma-panel-host');
  if (!h) return JSON.stringify({ panelHost: false });
  const r = h.getBoundingClientRect();
  return JSON.stringify({ panelHost: true, w: Math.round(r.width), h: Math.round(r.height), url: location.href });
})()`);
console.log('  ', JSON.stringify(st));

if (st.panelHost && (st.w ?? 0) < 20) {
  console.log('  → 点开');
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '--selector', '#pluma-panel-host']);
  } catch (e) {
    console.log('  click fail:', String(e.message || '').slice(0, 120));
  }
  sleep(1800);
}

console.log('\n=== 2. 切到账号 Tab ===');
let snap = snapshot();
const accLine = (snap.text || '').split('\n').find((l) => /@e\d+ tab "账号"/.test(l));
if (accLine) {
  const ref = (accLine.match(/@(e\d+)/) || [])[1];
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
  } catch (e) {
    console.log('  tab click fail:', String(e.message || '').slice(0, 120));
  }
  sleep(1500);
} else {
  console.log('  找不到账号 tab 节点');
}

console.log('\n=== 3. 账号 Tab 完整树 ===');
snap = snapshot();
const lines = (snap.text || '').split('\n');
const i = lines.findIndex((l) => /Pluma/.test(l));
const panel = i < 0 ? '' : lines.slice(i).join('\n');
console.log(panel || '  ❌ 找不到 Pluma 节点');

const hasExt = /取流：扩展账号/.test(panel);
const hasPage = /取流：浏览器账号/.test(panel);
console.log(`\n  ★ 扩展账号胶囊: ${hasExt}    浏览器账号胶囊: ${hasPage}`);

// 也搜整棵树（防止在别的 Tab 或别的位置）
const wholeHasExt = /取流：扩展账号/.test(snap.text || '');
const wholeHasPage = /取流：浏览器账号/.test(snap.text || '');
console.log(`  ★ 整棵树里有 "取流：" 字样: ${wholeHasExt || wholeHasPage}`);

console.log('\n=== 4. 页面加载时间戳（判断是否刚 reload 过）===');
const timing = evaluate(`(() => {
  const n = performance.getEntriesByType('navigation')[0];
  return JSON.stringify({
    startTime: Math.round(performance.now()),
    navStart: n ? Math.round(n.startTime) : null,
    loadEnd: n ? Math.round(n.loadEventEnd) : null,
  });
})()`);
console.log('  ', JSON.stringify(timing));
