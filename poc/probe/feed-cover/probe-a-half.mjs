// A 半证据：面板完整可访问树（逐 Tab），确认胶囊在不在
//
// 技能要求：声称"控件不存在"之前，必须扫遍**每一个** Tab，并记录每个 Tab 里有什么。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session', 'qocq');
const TAB = arg('tab', '1673235718');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const runBs = (args, maxBuf = 32 * 1024 * 1024) =>
  execFileSync('bsk', args, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: maxBuf });

/** bsk snapshot 输出可能是 UTF-16LE（PowerShell 重定向），这里直接用 execFileSync 拿，再按原样 JSON 解析 */
function snapshot() {
  const out = runBs(['snapshot', '--session', SI, '--tab-id', TAB, '--json']);
  const s = out.indexOf('{');
  return JSON.parse(out.slice(s));
}

function evaluate(expr) {
  const out = runBs(['evaluate', '--session', SI, '--tab-id', TAB, expr]);
  const s = out.indexOf('{');
  const e = out.indexOf('[');
  const i = s < 0 ? e : e < 0 ? s : Math.min(s, e);
  try {
    return JSON.parse(out.slice(i));
  } catch {
    return { raw: out.slice(0, 800) };
  }
}

const sleepMs = (ms) => {
  // daemon 侧睡眠，避免 PowerShell Start-Sleep 让脚本超时统计失真
  try {
    runBs(['wait-ms', '--session', SI, String(ms)]);
  } catch {
    /* 老版本可能没这个子命令，退回 evaluate 内延迟 */
    evaluate(`(async()=>{await new Promise(r=>setTimeout(r,${ms}));return JSON.stringify({ok:1})})()`);
  }
};

/** 从 snapshot 里截出 Pluma 面板那一段 */
function panelSection(snap) {
  const lines = (snap.text || '').split('\n');
  const i = lines.findIndex((l) => /Pluma/.test(l));
  if (i < 0) return { found: false, lines: [] };
  return { found: true, startLine: i, lines: lines.slice(i) };
}

function reportPanel(label, snap) {
  const p = panelSection(snap);
  console.log(`\n${'='.repeat(60)}\n### ${label}`);
  if (!p.found) {
    console.log('  ❌ 树里找不到 "Pluma" 节点（面板可能没挂载/没展开）');
    return { found: false };
  }
  const txt = p.lines.join('\n');
  console.log(txt);
  // ★ 关键字符串检测
  const hasExt = /取流：扩展账号/.test(txt);
  const hasPage = /取流：浏览器账号/.test(txt);
  console.log(`\n  ★ "取流：扩展账号" 在树里: ${hasExt}`);
  console.log(`  ★ "取流：浏览器账号" 在树里: ${hasPage}`);
  return { found: true, hasExt, hasPage, text: txt };
}

// ── 主流程 ──
console.log('=== [1] 确认面板存在 ===');
const st0 = evaluate(`(() => {
  const h = document.getElementById('pluma-panel-host');
  if (!h) return JSON.stringify({ panelHost: false });
  const r = h.getBoundingClientRect();
  return JSON.stringify({ panelHost: true, w: Math.round(r.width), h: Math.round(r.height) });
})()`);
console.log('  ', JSON.stringify(st0));

// 面板收起时先点开
if (st0.panelHost && (st0.w ?? 0) < 20) {
  console.log('  → 面板是收起的（宽 < 20），点开');
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '--selector', '#pluma-panel-host']);
  } catch (e) {
    console.log('  点击失败:', String(e.message || '').slice(0, 150));
  }
  sleepMs(1500);
}

const results = {};
let snap = snapshot();
const first = reportPanel('初始状态', snap);
results.initial = { hasExt: first.hasExt, hasPage: first.hasPage };

// 逐 Tab 点。ref 会随快照变化，所以每次都重新从当前快照里找 tab 的 ref
const TAB_NAMES = ['画质', '净化', '显示', '账号'];
for (const name of TAB_NAMES) {
  const cur = snapshot();
  const lines = (cur.text || '').split('\n');
  const line = lines.find((l) => new RegExp(`@e\\d+ tab "${name}"`).test(l));
  if (!line) {
    console.log(`\n### Tab「${name}」—— 在树里找不到该 tab 节点`);
    continue;
  }
  const ref = (line.match(/@(e\d+)/) || [])[1];
  console.log(`\n--- 点击 Tab「${name}」 ref=@${ref} ---`);
  try {
    runBs(['click', '--session', SI, '--tab-id', TAB, '@' + ref]);
  } catch (e) {
    console.log('  点击失败:', String(e.message || '').slice(0, 200));
    continue;
  }
  sleepMs(1500);
  const after = reportPanel(`Tab「${name}」`, snapshot());
  results[name] = { hasExt: after.hasExt, hasPage: after.hasPage };
}

fs.writeFileSync('D:/Temp/a-half.json', JSON.stringify(results, null, 2), 'utf8');
console.log('\n\n=== A 半汇总 ===');
console.log(JSON.stringify(results, null, 2));
