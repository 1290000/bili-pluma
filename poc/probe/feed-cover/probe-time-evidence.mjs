// 时间证据：产物 / 源码 / 抓取时刻 三者对齐
//
// 目的（Lead 要求）：判断"取流身份：未知"是
//   (A) 新修的成果（产物 > 代码改动）
//   (B) 老代码里本来就有的（代码 > 产物）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const t = (p) => {
  try {
    return fs.statSync(p).mtime;
  } catch {
    return null;
  }
};
const fmt = (d) => (d ? d.toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '(缺失)');

const targets = {
  '产物 content-panel.js': '.output/chrome-mv3/content-scripts/content-panel.js',
  '产物 background.js': '.output/chrome-mv3/background.js',
  '源码 tabs.ts': 'src/content/panel/tabs.ts',
  '源码 content-panel.content.ts': 'entrypoints/content-panel.content.ts',
  '源码 content.ts': 'entrypoints/content.ts',
  '源码 streaming-pill.ts': 'src/core/ui/streaming-pill.ts',
};

const times = {};
console.log('='.repeat(66));
console.log('文件修改时间');
console.log('='.repeat(66));
for (const [k, p] of Object.entries(targets)) {
  const d = t(p);
  times[k] = d;
  console.log(`  ${k.padEnd(32)} ${fmt(d)}`);
}

const prod = times['产物 content-panel.js'];
const tabs = times['源码 tabs.ts'];
const cpc = times['源码 content-panel.content.ts'];
const cts = times['源码 content.ts'];

console.log('\n' + '='.repeat(66));
console.log('关键比对');
console.log('='.repeat(66));
console.log(`  产物           ${fmt(prod)}`);
console.log(`  tabs.ts        ${fmt(tabs)}   ${tabs < prod ? '→ 早于产物 ✅ 已进产物' : '→ ⚠️ 晚于产物，未构建'}`);
console.log(`  content-panel  ${fmt(cpc)}   ${cpc < prod ? '→ 早于产物 ✅ 已进产物' : '→ ⚠️ 晚于产物，未构建'}`);
console.log(`  content.ts     ${fmt(cts)}   ${cts < prod ? '→ 早于产物 ✅ 已进产物' : '→ ⚠️ **晚于产物，未构建**'}`);

console.log('\n' + '='.repeat(66));
console.log('产物里有没有那三段文案');
console.log('='.repeat(66));
const prodFile = '.output/chrome-mv3/content-scripts/content-panel.js';
const pc = fs.readFileSync(prodFile, 'utf8');
for (const s of ['取流：扩展账号', '取流：浏览器账号', '取流身份：未知']) {
  console.log(`  ${s.padEnd(16)} 在产物里: ${pc.includes(s)}`);
}

console.log('\n' + '='.repeat(66));
console.log('产物里"未知态"那段代码');
console.log('='.repeat(66));
const i = pc.indexOf('取流身份：未知');
if (i >= 0) {
  console.log(pc.slice(Math.max(0, i - 400), i + 200));
} else {
  console.log('  未找到');
}

console.log('\n' + '='.repeat(66));
console.log('现在抓取（时刻实时打印）');
console.log('='.repeat(66));
const now = new Date();
console.log(`  snapshot 抓取时刻: ${fmt(now)}`);

const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };
const runBs = (args) => execFileSync('bsk', args, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });

// 读当前 tab 列表，找 bilibili 页面
const sessions = JSON.parse(runBs(['session', 'list', '--json']));
const sid = sessions[sessions.length - 1]?.session_id;
console.log(`  使用 session: ${sid}`);

const tabsOut = JSON.parse(runBs(['tab', 'list', '--session', sid, '--json']));
const biliTabs = (tabsOut.tabs || []).filter((x) => /bilibili\.com/.test(x.url || ''));
console.log(`  bilibili 标签页: ${biliTabs.map((x) => x.tab_id + ' ' + (x.url || '').slice(0, 50)).join(' | ')}`);

if (biliTabs.length) {
  const tab = biliTabs[0].tab_id;
  // 直接从产物里确认"未知"文案是活的
  const expr = `(() => {
    const h = document.getElementById('pluma-panel-host');
    return JSON.stringify({ panelHost: !!h, url: location.href, at: Date.now() });
  })()`;
  const r = runBs(['evaluate', '--session', sid, '--tab-id', String(tab), expr]);
  console.log(`  页面探测: ${r.trim().slice(0, 300)}`);
}
