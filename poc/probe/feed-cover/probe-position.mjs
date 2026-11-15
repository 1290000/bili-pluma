// Q2/Q3 v3：确认「前 10 张 is-rcmd 卡」到底在页面什么位置 + 隐藏的真实视觉效果
//
// ## v2 留下的疑问
//
// v2 四组全部 OK_BOTH（滚动正常、有补位），结论是"隐藏不破坏无限滚动"。
// 但 v2 的 display:none 让 bodyHeight 只减少 73px（2608 → 2535），
// 而 10 张卡按正常尺寸应占约 10 × 230 ≈ 2300px 以上。
//
// **两种可能**：
//   (a) 那 10 张卡本来就在首屏之外 / 被折叠区包着，隐藏它们对布局影响小
//   (b) 我的 targets 选错了（选到了不占位的元素）
//
// 必须查清，否则"能隐藏"这个结论没有视觉意义。
//
// ## v3 做法
//   · 打印每张目标卡的 boundingRect（top/left/width/height）+ 它所在的最近滚动容器
//   · 打印隐藏前后「视口内可见卡的 BV 列表」变化 —— 这才是用户肉眼看到的
//   · 统计首屏（viewport 内）到底有几张卡、它们的 BV 是什么
//
// 用法：node probe-position.mjs --session <sid> --tab <tab>

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
  const all = [...document.querySelectorAll('.bili-video-card')];
  const vh = window.innerHeight;
  const rows = all.map((c, i) => {
    const r = c.getBoundingClientRect();
    const a = c.querySelector('a[href*="/video/BV"]');
    const bv = a ? (a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/) || [''])[0] : null;
    const title = (c.querySelector('.bili-video-card__info--tit')?.getAttribute('title') || '').slice(0, 26);
    return {
      idx: i,
      isRcmd: c.classList.contains('is-rcmd'),
      bv: bv,
      title: title,
      top: Math.round(r.top + window.scrollY),
      height: Math.round(r.height),
      width: Math.round(r.width),
      inViewport: r.bottom > 0 && r.top < vh,
    };
  });

  const rcmdRows = rows.filter((x) => x.isRcmd);
  const first10 = rcmdRows.slice(0, 10);

  return JSON.stringify({
    scrollY: Math.round(window.scrollY),
    viewportH: vh,
    docHeight: document.body.scrollHeight,
    totalCards: rows.length,
    rcmdCards: rcmdRows.length,
    cardsWithBV: rows.filter((x) => x.bv).length,
    inViewportCount: rows.filter((x) => x.inViewport && x.width > 0 && x.height > 0).length,
    // 前 10 张 is-rcmd 的位置与尺寸
    first10Rcmd: first10,
    first10TotalHeight: first10.reduce((s, x) => s + x.height, 0),
    first10MinTop: Math.min(...first10.map((x) => x.top)),
    first10MaxBottom: Math.max(...first10.map((x) => x.top + x.height)),
    // 全部行（前 30）供核对
    allRows: rows.slice(0, 30),
  });
})()`;

const raw = evaluate(EXPR);
const r = JSON.parse(raw.slice(raw.indexOf('{')));

console.log('=== 页面几何 ===');
console.log(`  viewportH=${r.viewportH}  docHeight=${r.docHeight}  scrollY=${r.scrollY}`);
console.log(`  总卡数=${r.totalCards}  is-rcmd=${r.rcmdCards}  有BV=${r.cardsWithBV}  视口内可见=${r.inViewportCount}`);

console.log('\n=== 前 10 张 is-rcmd 卡的位置与尺寸 ===');
console.log('  idx  isRcmd  BV                top     h     w   inVP  title');
r.first10Rcmd.forEach((x) => {
  console.log(`  ${String(x.idx).padStart(3)}  ${String(x.isRcmd).padEnd(6)}  ${(x.bv || '-').padEnd(13)} ${String(x.top).padStart(6)} ${String(x.height).padStart(4)} ${String(x.width).padStart(5)}  ${String(x.inViewport).padEnd(5)} ${x.title}`);
});
console.log(`\n  前 10 张合计高度 = ${r.first10TotalHeight}px`);
console.log(`  它们占据的纵向范围：${r.first10MinTop} → ${r.first10MaxBottom}  （跨度 ${r.first10MaxBottom - r.first10MinTop}px）`);
console.log(`  视口高度 = ${r.viewportH}px → 前 10 张${r.first10MaxBottom <= r.viewportH ? '**全部落在首屏内**' : '**跨越首屏边界**'}`);

console.log('\n=== 全部卡前 30 行 ===');
console.log('  idx  isRcmd  BV                top     h    inVP  title');
r.allRows.forEach((x) => {
  console.log(`  ${String(x.idx).padStart(3)}  ${String(x.isRcmd).padEnd(6)}  ${(x.bv || '-').padEnd(13)} ${String(x.top).padStart(6)} ${String(x.height).padStart(4)}  ${String(x.inViewport).padEnd(5)} ${x.title}`);
});
