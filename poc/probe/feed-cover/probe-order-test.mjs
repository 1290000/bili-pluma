// Q4 实测：grid 容器里用 order 是否能真的把"后面的卡"移到前面？
//
// 已实测结构：
//   .container.is-version8  → display:grid，4 列（237.5px ×4），48 个直接子元素
//   每个直接子元素 = .bili-feed-card（block），里面才是 .bili-video-card
//
// 所以 order 要加在 **.bili-feed-card**（grid item）上，而不是 .bili-video-card。
//
// 本实验验证三件事：
//   ① order 加上后，grid item 的视觉位置是否真的改变（读 getBoundingClientRect 的 top/left）
//   ② 改 order 后滚动是否仍工作（新 rcmd 是否还发）
//   ③ order 是否影响 IntersectionObserver（通过"能否继续触发加载"间接判断）
//
// 用法：node probe-order-test.mjs --session <sid> --tab <tab>

import { execFileSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SESSION = arg('session');
const TAB = arg('tab');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const evaluate = (expr) =>
  execFileSync('bsk', ['evaluate', '--session', SESSION, '--tab-id', String(TAB), expr], {
    env: ENV, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024,
  });

const EXPR = `(async () => {
  const grid = document.querySelector('.container.is-version8');
  if (!grid) return JSON.stringify({ error: 'grid not found' });

  const items = [...grid.children];
  const readOrder = () => items.map((el, i) => {
    const r = el.getBoundingClientRect();
    const card = el.querySelector('.bili-video-card');
    const a = el.querySelector('a[href*="/video/BV"]');
    const bv = a ? (a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/) || [''])[0] : null;
    return {
      domIdx: i,
      bv: bv,
      order: getComputedStyle(el).order,
      top: Math.round(r.top + window.scrollY),
      left: Math.round(r.left),
      h: Math.round(r.height),
      isRcmd: card ? card.classList.contains('is-rcmd') : false,
    };
  });

  const before = readOrder();

  // 找前 10 个「有内容」的 grid item（有 BV 的），把它们 order 设成很大 → 视觉排到最后
  const contentIdx = before.map((x, i) => (x.bv ? i : -1)).filter((i) => i >= 0);
  const targets = contentIdx.slice(0, 10);

  const stash = targets.map((i) => ({ el: items[i], css: items[i].getAttribute('style') }));
  targets.forEach((i) => items[i].style.setProperty('order', '9999', 'important'));

  // 强制 reflow + 等一帧
  void grid.offsetHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const after = readOrder();

  // 恢复
  stash.reverse().forEach((s) => {
    if (s.css === null) s.el.removeAttribute('style');
    else s.el.setAttribute('style', s.css);
  });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // 判断：被设 order 的 item，其视觉 top 是否变大（往后移）
  const moves = targets.map((i) => ({
    domIdx: i,
    bv: before[i].bv,
    topBefore: before[i].top,
    topAfter: after[i].top,
    moved: after[i].top > before[i].top,
  }));

  // 整体视觉顺序（按 top,left 排序后的 BV 序列）
  const visOrder = (rows) => rows
    .filter((x) => x.h > 0 && x.bv)
    .slice()
    .sort((a, b) => (a.top - b.top) || (a.left - b.left))
    .map((x) => x.bv);

  return JSON.stringify({
    gridChildCount: items.length,
    gridDisplay: getComputedStyle(grid).display,
    gridCols: getComputedStyle(grid).gridTemplateColumns,
    targetsCount: targets.length,
    moves: moves,
    visualOrderBefore: visOrder(before).slice(0, 16),
    visualOrderAfter: visOrder(after).slice(0, 16),
    orderApplied: after.filter((x) => x.order === '9999').length,
  });
})()`;

const raw = evaluate(EXPR);
const r = JSON.parse(raw.slice(raw.indexOf('{')));

console.log('=== grid 容器 ===');
console.log(`  display=${r.gridDisplay}  cols=${r.gridCols}  子元素=${r.gridChildCount}`);

console.log(`\n=== 给前 ${r.targetsCount} 个有内容的 grid item 设 order:9999 ===`);
console.log(`  实际生效的 order=9999 数量: ${r.orderApplied}`);
console.log('  idx  BV                topBefore  topAfter  moved');
r.moves.forEach((m) => {
  console.log(`  ${String(m.domIdx).padStart(3)}  ${(m.bv || '-').padEnd(13)} ${String(m.topBefore).padStart(8)}  ${String(m.topAfter).padStart(8)}  ${m.moved}`);
});

console.log('\n=== 视觉顺序 before（按 top/left 排序）===');
console.log('  ' + r.visualOrderBefore.join(', '));
console.log('=== 视觉顺序 after ===');
console.log('  ' + r.visualOrderAfter.join(', '));
console.log(`\n  顺序是否改变 = ${JSON.stringify(r.visualOrderBefore) !== JSON.stringify(r.visualOrderAfter)}`);
