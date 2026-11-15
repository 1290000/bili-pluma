// Q4：推荐流容器是不是 flex/grid？能否用 CSS order 纯改视觉顺序？
//
// 若容器是 flex/grid，`order` 可以只改视觉顺序、不动布局、不影响 IntersectionObserver
// —— 这比"隐藏"更优雅。
//
// 判据：
//   ① 卡片父容器的 computed display 值（flex / grid / block ...）
//   ② 给前 N 张卡加 order:9999 后，它们的视觉位置是否真的移到了后面
//   ③ 移动后滚动是否正常
//
// 用法：node probe-order.mjs --session <sid> --tab <tab>

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

const EXPR = `(() => {
  const cards = [...document.querySelectorAll('.bili-video-card')];
  // 卡片父容器（一层层往上找 display 为 flex/grid 的祖先）
  const firstCard = cards[0];
  const chain = [];
  let el = firstCard;
  for (let d = 0; el && d < 8; d++) {
    const cs = getComputedStyle(el);
    chain.push({
      depth: d,
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 70),
      display: cs.display,
      flexDirection: cs.flexDirection,
      gridTemplateColumns: cs.gridTemplateColumns,
      childCount: el.children.length,
    });
    el = el.parentElement;
  }

  // 统计所有卡片的父容器分布
  const parentMap = {};
  cards.forEach((c) => {
    const p = c.parentElement;
    const key = p ? (p.tagName + '.' + (p.className || '').toString().slice(0, 50)) : 'none';
    parentMap[key] = (parentMap[key] || 0) + 1;
  });

  return JSON.stringify({
    totalCards: cards.length,
    ancestorChain: chain,
    parentDistribution: parentMap,
  });
})()`;

const raw = evaluate(EXPR);
const r = JSON.parse(raw.slice(raw.indexOf('{')));

console.log('=== 卡片父容器 ===');
console.log(JSON.stringify(r.parentDistribution, null, 1));

console.log('\n=== 祖先链（找 flex/grid 容器）===');
r.ancestorChain.forEach((c) => {
  const mark = (c.display === 'flex' || c.display === 'grid' || c.display === 'inline-flex') ? ' ← ' + c.display.toUpperCase() + ' 容器' : '';
  console.log(`  d${c.depth} <${c.tag}> display=${c.display} children=${c.childCount}${mark}`);
  console.log(`      cls="${c.cls}"`);
  if (c.display === 'flex') console.log(`      flexDirection=${c.flexDirection}`);
  if (c.display === 'grid') console.log(`      gridTemplateColumns=${c.gridTemplateColumns.slice(0, 80)}`);
});
