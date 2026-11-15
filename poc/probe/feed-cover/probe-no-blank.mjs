// 「A 消失 + 零留白」专项排查
//
// ## 目标
//   开启后首页推荐流**全部**是取流账号的，A 的卡一张不出现，且**不能有空洞**。
//
// ## 判据（Lead 给定）
//   - 第一张可见卡 top == 255（与基线一致）→ 零留白
//   - 首屏 A 数 == 0
//   - 只有「top=255 且 A=0」才合格
//
// ## 本脚本要跑的路径
//   基线   ：不动，测出 firstTop 基准
//   1      ：只藏 10 个 .feed-card（display:none），带前置断言
//   2a     ：visibility:hidden / height:0 对比
//   2c     ：藏了之后查父元素、空占位
//   3      ：el.remove()，测 Vue 是否回填
//
// 纪律：每组 reload 隔离；断言命中数；恢复 inline style。
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

const RELOAD_WAIT = `(async () => { await new Promise(r => setTimeout(r, 5000)); return JSON.stringify({ ok: 1, total: document.querySelectorAll('.bili-video-card').length }); })()`;

// ── 通用测量 ──
const MEASURE = `
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const bvOf = (el) => { const a = el.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null; };
  const batchOf = (el) => el.closest('.feed-card') ? 'A' : (el.closest('.bili-feed-card') ? 'B' : 'other');
  const vh = window.innerHeight;
  const measure = () => {
    const cards = [...document.querySelectorAll('.bili-video-card')];
    const rows = cards.map(c => {
      const r = c.getBoundingClientRect();
      return { bv: bvOf(c), batch: batchOf(c), top: Math.round(r.top + window.scrollY), h: Math.round(r.height), w: Math.round(r.width) };
    });
    const vis = rows.filter(x => x.w > 0 && x.h > 0);
    const inVp = vis.filter(x => x.top < vh && x.top + x.h > 0);
    const cnt = (arr, b) => arr.filter(x => x.batch === b).length;
    // 轮播几何
    const swipe = document.querySelector('.recommended-swipe');
    const swR = swipe ? swipe.getBoundingClientRect() : null;
    return {
      total: cards.length,
      visible: vis.length,
      firstTop: vis.length ? Math.min(...vis.map(x => x.top)) : null,
      inVp: inVp.length,
      inVpA: cnt(inVp, 'A'),
      inVpB: cnt(inVp, 'B'),
      inVpOther: cnt(inVp, 'other'),
      inVpSeq: inVp.map(x => x.batch),
      bodyHeight: document.body.scrollHeight,
      swipeH: swR ? Math.round(swR.height) : null,
      swipeTop: swR ? Math.round(swR.top + window.scrollY) : null,
    };
  };
`;

const safe = (js) => `(async () => {
  ${MEASURE}
  const before = measure();
  const touched = [];
  const setStyle = (el, prop, val) => { touched.push({ el, prop, prev: el.style.getPropertyValue(prop), prio: el.style.getPropertyPriority(prop) }); el.style.setProperty(prop, val, 'important'); };
  let assertMsg = null;
  let extra = null;
  try {
    ${js}
  } catch (e) { assertMsg = String(e && e.message ? e.message : e); }
  void document.body.offsetHeight;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 700));
  const after = measure();
  // 恢复
  touched.reverse().forEach(t => { if (t.prev) t.el.style.setProperty(t.prop, t.prev, t.prio); else t.el.style.removeProperty(t.prop); });
  void document.body.offsetHeight;
  return JSON.stringify({ before, after, assertMsg, extra });
})()`;

// ── 探针：藏了之后，父容器/空占位 ──
const PARENT_PROBE = `(async () => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const bvOf = (el) => { const a = el.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null; };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), h: Math.round(r.height), w: Math.round(r.width) }; };

  const fcs = [...document.querySelectorAll('.feed-card')];
  const grid = document.querySelector('.container.is-version8');

  // 藏之前：父元素是什么
  const parents = [...new Set(fcs.map(f => f.parentElement))].map(p => ({
    tag: p.tagName,
    cls: String(p.className).slice(0, 50),
    childCount: p.children.length,
    rect: rect(p),
    isGrid: getComputedStyle(p).display,
  }));

  // grid 直接子元素里，哪几个"包含"这 10 个 feed-card
  const gridKidsBefore = grid ? [...grid.children].map((c, i) => ({
    i, cls: String(c.className).slice(0, 40), rect: rect(c), containsFeedCard: !!c.querySelector('.feed-card'), selfIsFeedCard: c.classList.contains('feed-card'),
  })) : [];

  // 藏掉
  fcs.forEach(el => el.style.setProperty('display', 'none', 'important'));
  void document.body.offsetHeight;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 500));

  const gridKidsAfter = grid ? [...grid.children].map((c, i) => ({
    i, cls: String(c.className).slice(0, 40), rect: rect(c), containsFeedCard: !!c.querySelector('.feed-card'), selfIsFeedCard: c.classList.contains('feed-card'),
  })) : [];

  // 找"空占位"：grid 子元素里高度>0 但没有可见卡片的
  const gridKidsRect = gridKidsAfter.filter(k => k.rect.h > 0);
  const visibleCardsAfter = [...document.querySelectorAll('.bili-video-card')].filter(c => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; });

  // 恢复
  fcs.forEach(el => el.style.removeProperty('display'));

  return JSON.stringify({
    feedCardCount: fcs.length,
    parents,
    gridKidCount: gridKidsBefore.length,
    gridKidsBefore: gridKidsBefore.slice(0, 16),
    gridKidsAfter: gridKidsAfter.slice(0, 16),
    visibleCardsAfterHide: visibleCardsAfter.length,
    gridKidsWithHeightAfter: gridKidsRect.length,
  });
})()`;

console.log('='.repeat(74));
console.log('「A 消失 + 零留白」专项排查');
console.log('='.repeat(74));

const results = {};

/** reload + 等稳定 */
function fresh(label) {
  try {
    runBs(['reload', '--session', SI, '--tab-id', TAB]);
  } catch (e) {
    console.log(`  [${label}] reload err:`, String(e.message || '').slice(0, 80));
  }
  const w = evaluate(RELOAD_WAIT);
  console.log(`\n### ${label}  (reload 后 total=${w.total})`);
}

function runCase(label, js) {
  fresh(label);
  const r = evaluate(safe(js));
  if (r.raw) {
    console.log('  失败:', JSON.stringify(r).slice(0, 300));
    return null;
  }
  const b = r.before, a = r.after;
  const f = (m) => `firstTop=${String(m.firstTop).padStart(4)} inVP=${m.inVp}(A${m.inVpA}/B${m.inVpB}/o${m.inVpOther}) bodyH=${m.bodyHeight} swipeH=${m.swipeH}`;
  console.log(`  before: ${f(b)}`);
  console.log(`  after : ${f(a)}`);
  console.log(`  序列  : ${a.inVpSeq.join(' ')}`);
  if (r.assertMsg) console.log(`  ⚠️ 断言: ${r.assertMsg}`);
  const ok = a.firstTop === b.firstTop && a.inVpA === 0;
  console.log(`  判定  : ${ok ? '✅ 合格（top 不变 + A=0）' : `❌ firstTop ${b.firstTop}→${a.firstTop}, A=${a.inVpA}`}`);
  return r;
}

// ── 基线 ──
results.baseline = runCase('基线（不动）', '');

// ── 路径 1：只藏 10 个 .feed-card ──
results.p1_display_none = runCase(
  '路径1：只藏 10 个 .feed-card (display:none)',
  `
  const targets = [...document.querySelectorAll('.feed-card')];
  const inSwipe = targets.filter(el => el.closest('.recommended-swipe'));
  if (targets.length !== 10) throw new Error('命中数 ' + targets.length + ' != 10');
  if (inSwipe.length !== 0) throw new Error('有 ' + inSwipe.length + ' 个在轮播内');
  targets.forEach(el => setStyle(el, 'display', 'none'));
  extra = { hit: targets.length, inSwipe: inSwipe.length };
  `
);

// ── 路径 2a：visibility:hidden ──
results.p2a_visibility = runCase(
  '路径2a：只藏 10 个 (visibility:hidden)',
  `
  const targets = [...document.querySelectorAll('.feed-card')];
  if (targets.length !== 10) throw new Error('命中数 ' + targets.length);
  if (targets.some(el => el.closest('.recommended-swipe'))) throw new Error('误伤轮播');
  targets.forEach(el => setStyle(el, 'visibility', 'hidden'));
  `
);

// ── 路径 2a：height:0 ──
results.p2a_height0 = runCase(
  '路径2a：只藏 10 个 (height:0;overflow:hidden)',
  `
  const targets = [...document.querySelectorAll('.feed-card')];
  if (targets.length !== 10) throw new Error('命中数 ' + targets.length);
  if (targets.some(el => el.closest('.recommended-swipe'))) throw new Error('误伤轮播');
  targets.forEach(el => { setStyle(el, 'height', '0'); setStyle(el, 'overflow', 'hidden'); setStyle(el, 'margin', '0'); setStyle(el, 'padding', '0'); });
  `
);

// ── 路径 3：el.remove() ──
results.p3_remove = (() => {
  fresh('路径3：el.remove() 彻底移除');
  const r = evaluate(`(async () => {
    ${MEASURE}
    const before = measure();
    const targets = [...document.querySelectorAll('.feed-card')];
    if (targets.length !== 10) return JSON.stringify({ error: '命中数 ' + targets.length });
    if (targets.some(el => el.closest('.recommended-swipe'))) return JSON.stringify({ error: '误伤轮播' });
    const parents = targets.map(t => t.parentElement);
    targets.forEach(t => t.remove());
    void document.body.offsetHeight;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 800));
    const after1s = measure();
    const stillGone = document.querySelectorAll('.feed-card').length;
    await new Promise(r => setTimeout(r, 2500));
    const after3s = measure();
    const after3sCount = document.querySelectorAll('.feed-card').length;
    return JSON.stringify({ before, after1s, after3s, stillGoneAt1s: stillGone, feedCardCountAt3s: after3sCount });
  })()`);
  if (r.error) {
    console.log('  失败:', r.error);
    return null;
  }
  const f = (m) => `firstTop=${String(m.firstTop).padStart(4)} inVP=${m.inVp}(A${m.inVpA}/B${m.inVpB}/o${m.inVpOther}) bodyH=${m.bodyHeight}`;
  console.log(`  before   : ${f(r.before)}`);
  console.log(`  after 1s : ${f(r.after1s)}  feed-card 剩 ${r.stillGoneAt1s}`);
  console.log(`  after 3s : ${f(r.after3s)}  feed-card 剩 ${r.feedCardCountAt3s}`);
  const ok = r.after1s.firstTop === r.before.firstTop && r.after1s.inVpA === 0;
  console.log(`  判定     : ${ok ? '✅ 合格' : '❌'}`);
  console.log(`  Vue 回填 : ${r.feedCardCountAt3s > 0 ? '⚠️ 回填了 ' + r.feedCardCountAt3s + ' 个' : '✅ 没回填'}`);
  return r;
})();

// ── 2c：父元素与空占位探查 ──
fresh('路径2c：父元素 / 空占位探查');
const pp = evaluate(PARENT_PROBE);
if (!pp.raw) {
  console.log(`  feed-card 数: ${pp.feedCardCount}`);
  console.log(`  父元素:`);
  pp.parents.forEach((p) => console.log(`    <${p.tag}> cls="${p.cls}" children=${p.childCount} display=${p.isGrid} rect=${JSON.stringify(p.rect)}`));
  console.log(`  grid 直接子元素数: ${pp.gridKidCount}`);
  console.log(`  藏之前 grid kids（前 16）:`);
  pp.gridKidsBefore.forEach((k) => console.log(`    [${String(k.i).padStart(2)}] ${k.cls.padEnd(40)} top=${String(k.rect.top).padStart(5)} h=${String(k.rect.h).padStart(4)} selfFeed=${k.selfIsFeedCard} 含feed=${k.containsFeedCard}`));
  console.log(`  藏之后 grid kids（前 16）:`);
  pp.gridKidsAfter.forEach((k) => console.log(`    [${String(k.i).padStart(2)}] ${k.cls.padEnd(40)} top=${String(k.rect.top).padStart(5)} h=${String(k.rect.h).padStart(4)} selfFeed=${k.selfIsFeedCard} 含feed=${k.containsFeedCard}`));
  console.log(`  藏之后：grid 里有高度的子元素 ${pp.gridKidsWithHeightAfter} 个，可见卡 ${pp.visibleCardsAfterHide} 张`);
}
results.parentProbe = pp;

fs.writeFileSync('D:/Temp/no-blank.json', JSON.stringify(results, null, 2), 'utf8');
console.log('\n→ D:/Temp/no-blank.json');
