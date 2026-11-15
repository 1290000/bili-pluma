// 补充验证：长时间 + 滚动多轮后，A 是否仍保持消失
//
// ## 为什么要测
//   路径1（display:none）在 800ms 时合格，但：
//   - Vue 可能在后续渲染中重建这 10 个元素（inline style 丢失）
//   - 无限滚动加载新卡时，可能重排导致 A 回来
//
// ## 判据
//   施加 display:none → 滚动 3 次 → 每次检查：
//   - .feed-card 的 inline display 是否还在
//   - 首屏 A 数是否仍为 0
//   - 第一张可见卡 top 是否仍 255
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
    return { raw: out.slice(0, 600) };
  }
};

const EXPR = `(async () => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const bvOf = (el) => { const a = el.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null; };
  const batchOf = (el) => el.closest('.feed-card') ? 'A' : (el.closest('.bili-feed-card') ? 'B' : 'other');
  const vh = window.innerHeight;
  const measure = () => {
    const cards = [...document.querySelectorAll('.bili-video-card')];
    const rows = cards.map(c => { const r = c.getBoundingClientRect(); return { batch: batchOf(c), top: Math.round(r.top + window.scrollY), h: Math.round(r.height), w: Math.round(r.width) }; });
    const vis = rows.filter(x => x.w > 0 && x.h > 0);
    const inVp = vis.filter(x => x.top < vh && x.top + x.h > 0);
    const cnt = (arr, b) => arr.filter(x => x.batch === b).length;
    const fcs = [...document.querySelectorAll('.feed-card')];
    return {
      total: cards.length,
      firstTop: vis.length ? Math.min(...vis.map(x => x.top)) : null,
      inVpA: cnt(inVp, 'A'),
      inVpB: cnt(inVp, 'B'),
      feedCardCount: fcs.length,
      feedCardsHidden: fcs.filter(f => getComputedStyle(f).display === 'none').length,
      feedCardsWithInline: fcs.filter(f => f.style.display === 'none').length,
    };
  };

  const before = measure();

  // 施加
  const targets = [...document.querySelectorAll('.feed-card')];
  if (targets.length !== 10) return JSON.stringify({ error: '命中 ' + targets.length });
  if (targets.some(el => el.closest('.recommended-swipe'))) return JSON.stringify({ error: '误伤轮播' });
  targets.forEach(el => el.style.setProperty('display', 'none', 'important'));

  void document.body.offsetHeight;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 800));
  const t0 = measure();

  const rounds = [];
  for (let k = 1; k <= 3; k++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 3200));
    const m = measure();
    rounds.push({ round: k, ...m });
    // 滚回顶部看首屏
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 500));
  }

  const finalTop = measure();

  // 恢复
  targets.forEach(el => el.style.removeProperty('display'));

  return JSON.stringify({ before, t0, rounds, finalTop });
})()`;

console.log('=== 长时间 + 滚动耐受性验证（display:none）===');
try {
  runBs(['reload', '--session', SI, '--tab-id', TAB]);
} catch {}
const w = evaluate(`(async () => { await new Promise(r => setTimeout(r, 5000)); return JSON.stringify({ total: document.querySelectorAll('.bili-video-card').length }); })()`);
console.log('reload 后 total =', w.total);

const r = evaluate(EXPR);
if (r.error || r.raw) {
  console.log('失败:', JSON.stringify(r).slice(0, 400));
  process.exit(1);
}

const f = (m) => `firstTop=${String(m.firstTop).padStart(4)} total=${String(m.total).padStart(3)} A=${m.inVpA} B=${m.inVpB} feedCard=${m.feedCardCount}(隐藏${m.feedCardsHidden}/inline${m.feedCardsWithInline})`;

console.log('\nbefore :', f(r.before));
console.log('t0     :', f(r.t0));
r.rounds.forEach((x) => console.log(`round ${x.round}:`, f(x)));
console.log('final  :', f(r.finalTop));

console.log('\n=== 判读 ===');
const allOk = r.finalTop.inVpA === 0 && r.finalTop.firstTop === r.before.firstTop && r.finalTop.feedCardCount === 10;
console.log(`  A 是否始终为 0: ${r.rounds.every((x) => x.inVpA === 0) && r.finalTop.inVpA === 0 ? '✅ 是' : '❌ 否'}`);
console.log(`  feed-card 数量是否始终 10: ${r.finalTop.feedCardCount === 10 ? '✅ 是' : '❌ 否（' + r.finalTop.feedCardCount + '）'}`);
console.log(`  inline display 是否保持: ${r.finalTop.feedCardsWithInline === 10 ? '✅ 10 个都在' : '⚠️ 只剩 ' + r.finalTop.feedCardsWithInline + ' 个'}`);
console.log(`  firstTop 是否保持: ${r.before.firstTop} → ${r.finalTop.firstTop}`);
console.log(`  综合: ${allOk ? '✅ 耐受性通过' : '⚠️ 需要看具体哪项退化'}`);
