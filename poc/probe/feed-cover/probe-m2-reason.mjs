// ② page 模式 pill 判据追查：page/activate 的 reason 到底有没有传到 UI
//
// ## 已知代码链
//   page.handler.ts:135  if (!needsProxy(await readStreamingIdentity()))  → reason: 'page-identity'
//   popup-state.ts:429   if (snap.lastActivateReason === 'page-identity') return pageIdentity()  → pill '无需代理'
//   panel-data.ts:226    pill: view?.pill
//
// ## M2 实测矛盾
//   page 模式下画质区显示「已接管」，而不是「无需代理」
//   → 要么 lastActivateReason 不是 'page-identity'
//   → 要么 popup 的判据没走到那一行
//
// ## 本探针要拿的（只读，不切身份）
//   `page/snapshot` 里有没有 `lastActivateReason`，值是什么
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
  execFileSync('bsk', args, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
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

const BRIDGE = `(async () => {
  const r = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
        clearTimeout(t); window.removeEventListener('message', h);
        resolve({ ok: true, snapshot: e.data.snapshot, pgcReload: e.data.pgcReload });
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
  });
  return JSON.stringify(r);
})()`;

const setProxy = (en) => `(async () => {
  const r = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok:false, error:'timeout' }), 5000);
    const h = (e) => { if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'set-proxy-reply') { clearTimeout(t); window.removeEventListener('message', h); resolve(e.data); } };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'set-proxy', enabled: ${en} }, '*');
  });
  return JSON.stringify(r);
})()`;

const out = { steps: [] };
const rec = (k, v) => {
  console.log(`\n### ${k}`);
  console.log(JSON.stringify(v, null, 1).slice(0, 2500));
  out.push({ step: k, ...v });
};

console.log('=== ② page 模式 pill 追查 ===');
console.log('页面:', JSON.stringify(evaluate('JSON.stringify({h:location.href})')));

// 0. 当前（应为 extension 身份，代理开）
const b0 = evaluate(BRIDGE);
if (!b0.ok) {
  console.log('❌ 桥不通:', JSON.stringify(b0));
  process.exit(1);
}
rec('0-当前', {
  proxy: b0.snapshot?.proxy,
  view: b0.snapshot?.view,
  lastActivateReason: b0.snapshot?.lastActivateReason,
  hasTheField: Object.prototype.hasOwnProperty.call(b0.snapshot || {}, 'lastActivateReason'),
  allKeys: Object.keys(b0.snapshot || {}),
});

// 1. 切到 page（用 popup 的 streaming/set —— 这里是 ISOLATED，通过 pill 点）
//    先打开面板点胶囊
console.log('\n=== 切到 page（点胶囊）===');
const openAndClick = `(() => {
  const h = document.getElementById('pluma-panel-host');
  if (!h) return JSON.stringify({ err: 'no panel' });
  const r = h.getBoundingClientRect();
  return JSON.stringify({ w: Math.round(r.width) });
})()`;
let st = evaluate(openAndClick);
console.log('面板宽:', JSON.stringify(st));
if ((st.w ?? 0) < 20) {
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '--selector', '#pluma-panel-host']);
  } catch {}
  sleep(1500);
}
// 切账号 Tab
const snap0 = JSON.parse(runBs(['snapshot', '--session', SI, '--tab-id', TAB, '--json']).replace(/^[^{]*/, ''));
const accLine = (snap0.text || '').split('\n').find((l) => /@e\d+ tab "账号"/.test(l));
if (accLine) {
  const ref = (accLine.match(/@(e\d+)/) || [])[1];
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
  } catch {}
  sleep(1500);
}

const snap1 = JSON.parse(runBs(['snapshot', '--session', SI, '--tab-id', TAB, '--json']).replace(/^[^{]*/, ''));
const lines1 = (snap1.text || '').split('\n');
const i1 = lines1.findIndex((l) => /Pluma/.test(l));
console.log('账号 Tab:');
lines1.slice(i1).forEach((l) => console.log('  ', l.trim()));

const pillLine = lines1.slice(i1).find((l) => /button "取流/.test(l));
if (pillLine) {
  const ref = (pillLine.match(/@(e\d+)/) || [])[1];
  const label = (pillLine.match(/button "([^"]+)"/) || [])[1];
  console.log(`\n点胶囊 @${ref} (当前 "${label}")`);
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
  } catch (e) {
    console.log('  fail:', String(e.message || '').slice(0, 120));
  }
  sleep(2500);
}

// 2. 刷新（page 身份需要刷新才走 page/activate）
console.log('\n=== reload ===');
try {
  runBs(['reload', '--session', SI, '--tab-id', TAB]);
} catch {}
sleep(11000);

// 3. 读 page 模式下的 snapshot + 面板
const b1 = evaluate(BRIDGE);
rec('1-page模式-刷新后', {
  proxy: b1.snapshot?.proxy,
  view: b1.snapshot?.view,
  lastActivateReason: b1.snapshot?.lastActivateReason,
  hasTheField: Object.prototype.hasOwnProperty.call(b1.snapshot || {}, 'lastActivateReason'),
  allKeys: Object.keys(b1.snapshot || {}),
});

// 面板画质区
const snap2 = JSON.parse(runBs(['snapshot', '--session', SI, '--tab-id', TAB, '--json']).replace(/^[^{]*/, ''));
const lines2 = (snap2.text || '').split('\n');
const i2 = lines2.findIndex((l) => /Pluma/.test(l));
const panelText = i2 < 0 ? '' : lines2.slice(i2).join('\n');
console.log('\npage 模式下面板全文:');
console.log(panelText.slice(0, 2000));

// 4. 恢复
console.log('\n=== 恢复 extension ===');
if ((evaluate(openAndClick).w ?? 0) < 20) {
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '--selector', '#pluma-panel-host']);
  } catch {}
  sleep(1200);
}
const snap3 = JSON.parse(runBs(['snapshot', '--session', SI, '--tab-id', TAB, '--json']).replace(/^[^{]*/, ''));
const accLine3 = (snap3.text || '').split('\n').find((l) => /@e\d+ tab "账号"/.test(l));
if (accLine3) {
  const ref = (accLine3.match(/@(e\d+)/) || [])[1];
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
  } catch {}
  sleep(1500);
}
const snap4 = JSON.parse(runBs(['snapshot', '--session', SI, '--tab-id', TAB, '--json']).replace(/^[^{]*/, ''));
const lines4 = (snap4.text || '').split('\n');
const i4 = lines4.findIndex((l) => /Pluma/.test(l));
const pillLine4 = lines4.slice(i4).find((l) => /button "取流/.test(l));
if (pillLine4 && !/取流：扩展账号/.test(pillLine4)) {
  const ref = (pillLine4.match(/@(e\d+)/) || [])[1];
  console.log('切回:', pillLine4.trim());
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
  } catch {}
  sleep(2500);
}
const b2 = evaluate(BRIDGE);
rec('2-恢复后', { proxy: b2.snapshot?.proxy, view: b2.snapshot?.view, lastActivateReason: b2.snapshot?.lastActivateReason });

fs.writeFileSync('D:/Temp/m2-reason.json', JSON.stringify(out, null, 2), 'utf8');
console.log('\n→ D:/Temp/m2-reason.json');
