// M2：page 模式下的画质区说不说假话
//
// 步骤：
//   1. 记录当前身份（应为 extension）
//   2. 点胶囊切到 page
//   3. 刷新页面（page 模式需要刷新才真正回到浏览器身份）
//   4. 读画质区文案，判据：**不该出现**「主账号基线不可用（数据来源是取流账号）」
//   5. 切回 extension
//   6. 恢复后复查
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
const snapshot = () => JSON.parse(runBs(['snapshot', '--session', SI, '--tab-id', TAB, '--json']).replace(/^[^{]*/, ''));
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

function panelText() {
  const s = snapshot();
  const lines = (s.text || '').split('\n');
  const i = lines.findIndex((l) => /Pluma/.test(l));
  return i < 0 ? '' : lines.slice(i).join('\n');
}

/** 找胶囊按钮的 ref */
function findPillRef() {
  const t = panelText();
  const m = t.match(/@(e\d+) button "(取流[^"]*)"/);
  return m ? { ref: m[1], label: m[2] } : null;
}

function openPanelAndAccountTab() {
  const st = evaluate(`(() => {
    const h = document.getElementById('pluma-panel-host');
    if (!h) return JSON.stringify({ panelHost: false });
    const r = h.getBoundingClientRect();
    return JSON.stringify({ panelHost: true, w: Math.round(r.width) });
  })()`);
  if (!st.panelHost) return false;
  if ((st.w ?? 0) < 20) {
    try {
      runBs(['click', '--session', SI, '--tab-id', TAB, '--selector', '#pluma-panel-host']);
    } catch {}
    sleep(1500);
  }
  // 账号 Tab
  const line = (panelText().split('\n') || []).find((l) => /@e\d+ tab "账号"/.test(l));
  if (line) {
    const ref = (line.match(/@(e\d+)/) || [])[1];
    try {
      runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
    } catch {}
    sleep(1500);
  }
  return true;
}

const out = { steps: [] };

// ── 0. 当前身份 ──
console.log('=== [0] 打开面板，读当前身份 ===');
openPanelAndAccountTab();
let pill = findPillRef();
console.log('  胶囊:', JSON.stringify(pill));
out.steps.push({ step: '0-initial', pill });

if (!pill) {
  console.log('❌ 找不到胶囊，中止');
  process.exit(1);
}

// ── 1. 切到 page ──
console.log('\n=== [1] 点胶囊切到 page ===');
try {
  runBs(['click', '--session', SI, '--tab-id', TAB, '@' + pill.ref]);
} catch (e) {
  console.log('  click fail:', String(e.message || '').slice(0, 150));
}
sleep(2500);
pill = findPillRef();
console.log('  切换后胶囊:', JSON.stringify(pill));
out.steps.push({ step: '1-afterToggle', pill });

// ── 2. 刷新（page 模式需刷新才生效）──
console.log('\n=== [2] 刷新页面 ===');
try {
  runBs(['reload', '--session', SI, '--tab-id', TAB]);
} catch (e) {
  console.log('  reload:', String(e.message || '').slice(0, 120));
}
sleep(9000);

// ── 3. 读画质区 ──
console.log('\n=== [3] page 模式下的画质区 ===');
openPanelAndAccountTab();
// 切到画质 Tab
const qLine = (panelText().split('\n') || []).find((l) => /@e\d+ tab "画质"/.test(l));
if (qLine) {
  const ref = (qLine.match(/@(e\d+)/) || [])[1];
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
  } catch {}
  sleep(2000);
}
const pageModeText = panelText();
console.log(pageModeText);

const BAD = '主账号基线不可用（数据来源是取流账号）';
const badHit = pageModeText.includes(BAD) || (snapshot().text || '').includes(BAD);
console.log(`\n  ★ 出现「${BAD}」: ${badHit ? '❌ 出现了（假话）' : '✅ 没有出现'}`);
out.steps.push({ step: '3-pageMode', text: pageModeText, badHit });

// 也读一次 pill 状态与 unlock 区
const uiLines = pageModeText.split('\n').filter((l) => /接管|停用|未生效|无需代理|解锁|基线|画质/.test(l));
console.log('\n  过滤后的关键行:');
uiLines.forEach((l) => console.log('   ', l.trim()));

// ── 4. 切回 extension ──
console.log('\n=== [4] 切回 extension ===');
openPanelAndAccountTab();
pill = findPillRef();
console.log('  当前胶囊:', JSON.stringify(pill));
if (pill && pill.label !== '取流：扩展账号') {
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + pill.ref]);
  } catch (e) {
    console.log('  click fail:', String(e.message || '').slice(0, 150));
  }
  sleep(2500);
}
openPanelAndAccountTab();
const restored = findPillRef();
console.log('  恢复后胶囊:', JSON.stringify(restored));
out.steps.push({ step: '4-restored', pill: restored });

fs.writeFileSync('D:/Temp/m2.json', JSON.stringify(out, null, 2), 'utf8');
console.log('\n→ D:/Temp/m2.json');
