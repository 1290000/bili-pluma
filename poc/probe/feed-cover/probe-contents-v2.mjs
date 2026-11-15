// ③ 重做：每组 reload 隔离，验证 display:contents 到底有没有"把后面的卡提前"
//
// ## v1 的问题
//   每组 before.total 递增（39→57→75→92→110），说明滚动加载的卡累积下来没清
//   → 每组的基线不同，跨组对比无效
//
// ## v2 做法
//   每组：reload → 等稳定 → 记录基线 → 施加变换 → 记录 after → 滚动 → 记录 → 恢复
//   关键判据（回答"能不能让 B 的卡上移到首屏"）：
//     - 首屏可见卡的 BV 集合，变换后是否与变换前**不同**
//     - 若不同 → contents 确实改变了"谁在首屏"
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
    return { raw: out.slice(0, 500) };
  }
};
const sleep = (ms) => evaluate(`(async()=>{await new Promise(r=>setTimeout(r,${ms}));return JSON.stringify({ok:1})})()`);

const RELOAD_AND_WAIT = `(async () => {
  await new Promise(r => setTimeout(r, 4500));
  return JSON.stringify({ ok: true, total: document.querySelectorAll('.bili-video-card').length });
})()`;

const makeCase = (key, label, applyJs) => `(async () => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const bvOf = (el) => { const a = el.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null; };
  const vh = window.innerHeight;

  const measure = () => {
    const cards = [...document.querySelectorAll('.bili-video-card')];
    const boxes = cards.map(c => { const r = c.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, bv: bvOf(c) }; });
    const vis = boxes.filter(b => b.w > 0 && b.h > 0);
    const inVp = vis.filter(b => b.top < vh && b.bottom > 0);
    return {
      total: cards.length,
      visible: vis.length,
      inViewport: inVp.length,
      inViewportBvs: inVp.map(b => b.bv).filter(Boolean),
      firstTop: vis.length ? Math.round(Math.min(...vis.map(b => b.top))) : null,
      bodyHeight: document.body.scrollHeight,
    };
  };

  const before = measure();

  const touched = [];
  const setStyle = (el, prop, val) => { touched.push({ el, prop, prev: el.style.getPropertyValue(prop), prio: el.style.getPropertyPriority(prop) }); el.style.setProperty(prop, val, 'important'); };
  ${applyJs}
  void document.body.offsetHeight;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 500));

  const after = measure();

  // 恢复（不滚动，避免污染）
  touched.reverse().forEach(t => { if (t.prev) t.el.style.setProperty(t.prop, t.prev, t.prio); else t.el.style.removeProperty(t.prop); });
  void document.body.offsetHeight;

  return JSON.stringify({ key: ${JSON.stringify(key)}, label: ${JSON.stringify(label)}, before, after });
})()`;

const CASES = [
  ['control', '对照组', ''],
  ['contents', 'A. .feed-card → display:contents', `document.querySelectorAll('.feed-card').forEach(el => setStyle(el, 'display', 'contents'));`],
  ['contents-dense', 'A2. contents + grid-auto-flow:dense', `document.querySelectorAll('.feed-card').forEach(el => setStyle(el, 'display', 'contents')); const g = document.querySelector('.container.is-version8'); if (g) setStyle(g, 'grid-auto-flow', 'dense');`],
  ['order-grid', 'D. 给 .feed-card 设 order:9999（移到末尾）', `document.querySelectorAll('.feed-card').forEach(el => setStyle(el, 'order', '9999'));`],
];

console.log('='.repeat(70));
console.log('③ v2：每组 reload 隔离');
console.log('='.repeat(70));

const results = [];
for (const [key, label, js] of CASES) {
  console.log(`\n### ${label}`);
  // reload
  try {
    runBs(['reload', '--session', SI, '--tab-id', TAB]);
  } catch (e) {
    console.log('  reload err:', String(e.message || '').slice(0, 100));
  }
  const w = evaluate(RELOAD_AND_WAIT);
  console.log(`  reload 后 total=${w.total}`);

  const r = evaluate(makeCase(key, label, js));
  if (r.raw) {
    console.log('  失败:', JSON.stringify(r).slice(0, 300));
    continue;
  }
  results.push(r);
  const f = (m) => `total=${m.total} vis=${m.visible} inVP=${m.inViewport} firstTop=${m.firstTop} bodyH=${m.bodyHeight}`;
  console.log(`  before: ${f(r.before)}`);
  console.log(`  after : ${f(r.after)}`);
  const same = JSON.stringify(r.before.inViewportBvs) === JSON.stringify(r.after.inViewportBvs);
  console.log(`  首屏 BV 集合变化: ${same ? '❌ 没变（方案无效）' : '✅ 变了（方案有效）'}`);
  if (!same) {
    console.log(`    before: ${r.before.inViewportBvs.join(', ')}`);
    console.log(`    after : ${r.after.inViewportBvs.join(', ')}`);
  }
  console.log(`  firstTop: ${r.before.firstTop} → ${r.after.firstTop}`);
}

fs.writeFileSync('D:/Temp/contents2.json', JSON.stringify(results, null, 2), 'utf8');
console.log('\n→ D:/Temp/contents2.json');
