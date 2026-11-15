// 在视频页（content.ts 已注入、桥可用）读面板，看胶囊在不在
//
// 关键对照：首页面板无胶囊；视频页面板有胶囊吗？
// 若视频页有、首页没有 → 说明 content-panel 在首页的 streaming/status 首读失败，
// 而在视频页（content.ts 也在跑）成功 —— 指向首次时序或注入顺序。
import { execFileSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session');
const TAB = arg('tab');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const runBs = (args) =>
  execFileSync('bsk', args, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });

const snapshot = () => JSON.parse(runBs(['snapshot', '--session', SI, '--tab-id', TAB, '--json']).replace(/^[^{]*/, ''));
const evaluate = (expr) => {
  const out = runBs(['evaluate', '--session', SI, '--tab-id', TAB, expr]);
  const i = out.search(/[{[]/);
  try {
    return JSON.parse(out.slice(i));
  } catch {
    return { raw: out.slice(0, 300) };
  }
};
const sleep = (ms) => evaluate(`(async()=>{await new Promise(r=>setTimeout(r,${ms}));return JSON.stringify({ok:1})})()`);

console.log(`=== 当前页面: ${JSON.stringify(evaluate('JSON.stringify({h:location.href})'))} ===`);

// 点开面板
const st = evaluate(`(() => {
  const h = document.getElementById('pluma-panel-host');
  if (!h) return JSON.stringify({ panelHost: false });
  const r = h.getBoundingClientRect();
  return JSON.stringify({ panelHost: true, w: Math.round(r.width), h: Math.round(r.height) });
})()`);
console.log('面板状态:', JSON.stringify(st));

if (st.panelHost && (st.w ?? 0) < 20) {
  console.log('→ 点开面板');
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '--selector', '#pluma-panel-host']);
  } catch (e) {
    console.log('  click fail:', String(e.message || '').slice(0, 120));
  }
  sleep(2000);
}

// 切到账号 Tab
let snap = snapshot();
const accLine = (snap.text || '').split('\n').find((l) => /@e\d+ tab "账号"/.test(l));
if (accLine) {
  const ref = (accLine.match(/@(e\d+)/) || [])[1];
  console.log(`→ 点账号 Tab @${ref}`);
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
  } catch (e) {
    console.log('  fail:', String(e.message || '').slice(0, 120));
  }
  sleep(1800);
}

console.log('\n=== 账号 Tab 完整树 ===');
snap = snapshot();
const lines = (snap.text || '').split('\n');
const i = lines.findIndex((l) => /Pluma/.test(l));
const panel = i < 0 ? '' : lines.slice(i).join('\n');
console.log(panel);

console.log('\n=== ★ 胶囊检测 ===');
console.log(`  取流：扩展账号 : ${/取流：扩展账号/.test(panel)}`);
console.log(`  取流：浏览器账号: ${/取流：浏览器账号/.test(panel)}`);
console.log(`  整棵树有"取流：" : ${/取流：/.test(snap.text || '')}`);
