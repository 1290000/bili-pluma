// ③ display:contents 可行性 + 其他路径验证
//
// ## 前提（已实测）
//   .feed-card 是**完全透明的 wrapper**：padding=0 margin=0 background=transparent
//   position=static，只有一个子节点 .bili-feed-card，两者 BV 相同
//   → 它只是个 Vue scoped 容器，**不是"A 批次"的语义标记**
//
// ## 要测的四条
//   A. display:contents —— 去掉盒子保留孩子布局，滚动是否正常
//   B. 只藏内层的 .bili-video-card（保留 .feed-card 盒子）—— 会不会留下空盒子
//   C. 等 SSR 被替换后再显示（"先藏后显"）—— 观察 SSR 批是否真的会被 rcmd 替换
//   D. 有没有别的可区分标记（data-v 是 scoped 属性，所有卡都一样）
//
// 纪律：样式实验是临时的，每轮结束恢复 + reload。
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

// 通用：施加一个变换 → 观测 → 恢复
const makeCase = (key, applyJs, label) => `(async () => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const bvOf = (el) => { const a = el.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null; };
  const measure = () => {
    const cards = [...document.querySelectorAll('.bili-video-card')];
    const vh = window.innerHeight;
    const boxes = cards.map(c => { const r = c.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top, bv: bvOf(c) }; });
    const visible = boxes.filter(b => b.w > 0 && b.h > 0);
    const firstVisibleTop = visible.length ? Math.min(...visible.map(b => Math.round(b.top + window.scrollY))) : null;
    return {
      total: cards.length,
      visible: visible.length,
      firstVisibleTop,
      bodyHeight: document.body.scrollHeight,
      feedCardCount: document.querySelectorAll('.feed-card').length,
      biliFeedCardCount: document.querySelectorAll('.bili-feed-card').length,
      firstVisibleBv: boxes.find(b => b.w > 0 && b.h > 0) ? bvOf(cards.find((c,i)=>boxes[i].w>0&&boxes[i].h>0)) : null,
    };
  };

  const before = measure();

  // 记录被改元素原 style 以便恢复
  const touched = [];
  const setStyle = (el, prop, val) => { touched.push({ el, prop, prev: el.style.getPropertyValue(prop), prio: el.style.getPropertyPriority(prop) }); el.style.setProperty(prop, val, 'important'); };

  ${applyJs}

  void document.body.offsetHeight;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const after = measure();

  // 滚动一次，验证无限滚动没坏
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise(r => setTimeout(r, 3000));
  const afterScroll = measure();

  // 恢复
  touched.reverse().forEach(t => {
    if (t.prev) t.el.style.setProperty(t.prop, t.prev, t.prio); else t.el.style.removeProperty(t.prop);
  });
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 400));
  const restored = measure();

  return JSON.stringify({ key: ${JSON.stringify(key)}, label: ${JSON.stringify(label)}, before, after, afterScroll, restored });
})()`;

const CASES = [
  ['control', '', '对照组：不动'],
  ['contents', `document.querySelectorAll('.feed-card').forEach(el => setStyle(el, 'display', 'contents'));`, 'A. .feed-card → display:contents'],
  ['contents-grid', `document.querySelectorAll('.feed-card').forEach(el => { setStyle(el, 'display', 'contents'); }); const g=document.querySelector('.container.is-version8'); if(g) setStyle(g,'grid-auto-flow','dense');`, 'A2. contents + grid-auto-flow:dense'],
  ['hide-inner-video', `document.querySelectorAll('.feed-card .bili-video-card').forEach(el => setStyle(el, 'visibility', 'hidden'));`, 'B. 只藏内层 video-card（留盒子）'],
  ['hide-feedcard-h0', `document.querySelectorAll('.feed-card').forEach(el => { const r = el.getBoundingClientRect(); if (r.height === 0) setStyle(el, 'display', 'none'); });`, 'C. 只藏 height=0 的 .feed-card'],
];

console.log('='.repeat(70));
console.log('③ 路径验证');
console.log('='.repeat(70));

const results = [];
for (const [key, js, label] of CASES) {
  console.log(`\n### ${label}`);
  const r = evaluate(makeCase(key, js, label));
  if (r.raw) {
    console.log('  失败:', JSON.stringify(r).slice(0, 300));
    continue;
  }
  results.push(r);
  const f = (m) => `total=${m.total} visible=${m.visible} firstTop=${m.firstVisibleTop} bodyH=${m.bodyHeight}`;
  console.log(`  before     : ${f(r.before)}`);
  console.log(`  after      : ${f(r.after)}`);
  console.log(`  afterScroll: ${f(r.afterScroll)}  （total 增大 = 滚动加载正常）`);
  console.log(`  restored   : ${f(r.restored)}`);
  console.log(`  判定: ${r.afterScroll.total > r.after.total ? '✅ 滚动正常' : '⚠️ 滚动未触发新增'}`);
  sleep(1200);
}

fs.writeFileSync('D:/Temp/contents.json', JSON.stringify(results, null, 2), 'utf8');
console.log('\n→ D:/Temp/contents.json');
