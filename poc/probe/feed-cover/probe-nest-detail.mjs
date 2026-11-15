// 嵌套前提下的可行方案探查
//
// ## 已知（不再重复验证）
//   .feed-card 内含 .bili-feed-card 10/10，直接子节点只有 DIV.bili-feed-card
//   → 隐藏 .feed-card 元素 = 连里面的 bili-feed-card 一起藏
//
// ## 本次要查的四条路
//   ① 结构细节：.feed-card / 内层 .bili-feed-card 的属性、class、BV、几何
//   ② 内外内容是否同一张卡（同一 BV？还是两张不同的卡？）
//   ③ display:contents 可行性（去掉 A 的盒子，保留孩子布局）
//   ④ .feed-card 是不是透明 wrapper（无 padding/margin/background）
//
// 纪律：只读 + 可逆样式实验（reload 即恢复）。
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
    return { raw: out.slice(0, 800) };
  }
};
const sleep = (ms) => evaluate(`(async()=>{await new Promise(r=>setTimeout(r,${ms}));return JSON.stringify({ok:1})})()`);

const STRUCT = `(() => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const bvOf = (el) => { const a = el.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null; };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), h: Math.round(r.height), w: Math.round(r.width) }; };

  const feedCards = [...document.querySelectorAll('.feed-card')];
  const out = [];

  for (let i = 0; i < Math.min(3, feedCards.length); i++) {
    const fc = feedCards[i];
    const inner = fc.querySelector('.bili-feed-card');
    const innerCs = inner ? getComputedStyle(fc) : null;
    out.push({
      idx: i,
      // ① 结构细节
      feedCard: {
        classes: fc.className,
        attrs: [...fc.attributes].map(a => ({ name: a.name, value: String(a.value).slice(0, 80) })),
        outerHead: fc.outerHTML.slice(0, 500),
        rect: rect(fc),
        childCount: fc.children.length,
        children: [...fc.children].map(c => c.tagName + '.' + String(c.className).slice(0, 50)),
        // ④ 是不是透明 wrapper
        box: {
          display: innerCs ? innerCs.display : null,
          padding: innerCs ? innerCs.padding : null,
          margin: innerCs ? innerCs.margin : null,
          background: innerCs ? innerCs.backgroundColor : null,
          border: innerCs ? innerCs.border : null,
          position: innerCs ? innerCs.position : null,
          overflow: innerCs ? innerCs.overflow : null,
          gridRow: innerCs ? innerCs.gridRow : null,
          gridColumn: innerCs ? innerCs.gridColumn : null,
        },
      },
      // ② 内层与外表的关系
      innerBiliFeedCard: inner ? {
        classes: inner.className,
        isRcmd: inner.classList.contains('is-rcmd'),
        bv: bvOf(inner),
        rect: rect(inner),
        hasVideoCard: !!inner.querySelector('.bili-video-card'),
        videoCardIsRcmd: inner.querySelector('.bili-video-card') ? inner.querySelector('.bili-video-card').classList.contains('is-rcmd') : null,
        videoCardBv: bvOf(inner.querySelector('.bili-video-card') || inner),
        innerHasFeedCard: !!inner.querySelector('.feed-card'),
        depth1Children: [...inner.children].map(c => c.tagName + '.' + String(c.className).slice(0, 40)),
      } : null,
      // ② 外表自己的 BV（若外层直接有 a 标签）
      feedCardOwnBv: bvOf(fc),
    });
  }

  // 全局统计：feed-card 的 BV 集合 vs bili-feed-card 的 BV 集合
  const fcBvs = [...new Set(feedCards.map(bvOf).filter(Boolean))];
  const bfBvs = [...new Set([...document.querySelectorAll('.bili-feed-card')].map(bvOf).filter(Boolean))];
  const overlap = fcBvs.filter(x => bfBvs.includes(x));

  return JSON.stringify({
    counts: { feedCard: feedCards.length, biliFeedCard: document.querySelectorAll('.bili-feed-card').length },
    samples: out,
    setRelation: {
      feedCardBvs: fcBvs,
      feedCardBvCount: fcBvs.length,
      overlapWithBiliFeedCard: overlap.length,
      allFeedCardBvAreInBiliFeedCard: fcBvs.every(x => bfBvs.includes(x)),
    },
  });
})()`;

console.log('='.repeat(70));
console.log('【① ② ④】结构与内容关系');
console.log('='.repeat(70));
const s = evaluate(STRUCT);
if (s.raw) {
  console.log('解析失败:', JSON.stringify(s).slice(0, 600));
  process.exit(1);
}

console.log(`数量: feed-card=${s.counts.feedCard}, bili-feed-card=${s.counts.biliFeedCard}`);
console.log(`feed-card 的 BV 数: ${s.setRelation.feedCardBvCount}`);
console.log(`其中也在 bili-feed-card 里的: ${s.setRelation.overlapWithBiliFeedCard}`);
console.log(`全部都在: ${s.setRelation.allFeedCardBvAreInBiliFeedCard}`);
console.log(`feed-card BVs: ${s.setRelation.feedCardBvs.join(', ')}`);

for (const x of s.samples) {
  console.log(`\n--- feed-card #${x.idx} ---`);
  console.log(`  classes: ${x.feedCard.classes}`);
  console.log(`  attrs  : ${JSON.stringify(x.feedCard.attrs)}`);
  console.log(`  rect   : ${JSON.stringify(x.feedCard.rect)}`);
  console.log(`  children(${x.feedCard.childCount}): ${JSON.stringify(x.feedCard.children)}`);
  console.log(`  box    : ${JSON.stringify(x.feedCard.box)}`);
  console.log(`  outerHead: ${x.feedCard.outerHead.slice(0, 260)}`);
  console.log(`  >>> 内层 bili-feed-card:`);
  if (x.innerBiliFeedCard) {
    const b = x.innerBiliFeedCard;
    console.log(`      classes: ${b.classes}`);
    console.log(`      isRcmd : ${b.isRcmd}`);
    console.log(`      bv     : ${b.bv}`);
    console.log(`      rect   : ${JSON.stringify(b.rect)}`);
    console.log(`      videoCard: isRcmd=${b.videoCardIsRcmd} bv=${b.videoCardBv}`);
    console.log(`      depth1: ${JSON.stringify(b.depth1Children)}`);
  }
  console.log(`  外层自有 BV: ${x.feedCardOwnBv}`);
}

fs.writeFileSync('D:/Temp/nest-detail.json', JSON.stringify(s, null, 2), 'utf8');
