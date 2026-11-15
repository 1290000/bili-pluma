// task-19 真机复核 ①：feed-card / bili-feed-card 的父子嵌套关系
//
// ## 要回答的（task-19 剩余 6 项里的 2/3/4/5/6）
//   #3 feed-card 内部是否真的有 bili-feed-card 子节点（嵌套是否属实）
//   #2 feed-card 数量是否恒为 10（多次 reload）
//   #4 height>0 的 .is-rcmd 数是否稳定 ≥10
//   #5 recommended-swipe 内嵌卡是否带 is-rcmd
//   #6 .feed-card 里有没有 height=0
//
// ## 纪律
//   只读：只读 DOM，不改任何元素、不发写请求。
//
// 用法：node probe-feed-nesting.mjs --session <sid> --tab <tab> [--rounds 3]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session');
const TAB = arg('tab');
const ROUNDS = Number(arg('rounds', '3'));
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

const MEASURE = `(() => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const grid = document.querySelector('.container.is-version8');
  const feedCards = [...document.querySelectorAll('.feed-card')];
  const biliFeedCards = [...document.querySelectorAll('.bili-feed-card')];
  const rcmdBiliCards = [...document.querySelectorAll('.bili-video-card.is-rcmd')];

  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), h: Math.round(r.height), w: Math.round(r.width) }; };
  const bvOf = (el) => { const a = el.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null; };

  // ── #3 嵌套关系 ──
  const feedCardContainingBili = feedCards.filter((f) => f.querySelector('.bili-feed-card')).length;
  const biliContainingFeed = biliFeedCards.filter((b) => b.querySelector('.feed-card')).length;
  const sameElBothClasses = feedCards.filter((f) => f.classList.contains('bili-feed-card')).length;

  // 嵌套样例：第一张 feed-card 的直接子结构
  let nestingSample = null;
  if (feedCards[0]) {
    nestingSample = {
      feedCardClasses: feedCards[0].className,
      feedCardRect: rect(feedCards[0]),
      directChildTags: [...feedCards[0].children].map((c) => c.tagName + '.' + String(c.className).slice(0, 40)),
      innerBiliFeedCards: feedCards[0].querySelectorAll('.bili-feed-card').length,
      innerBiliVideoCards: feedCards[0].querySelectorAll('.bili-video-card').length,
    };
  }

  // ── #2 feed-card 数量 + 几何 ──
  const feedCardInfo = feedCards.map((f, i) => ({ i, ...rect(f), bv: bvOf(f) }));

  // ── #4 height>0 的 is-rcmd ──
  const rcmdGeom = rcmdBiliCards.map((c, i) => ({ i, ...rect(c), bv: bvOf(c) }));
  const rcmdWithHeight = rcmdGeom.filter((x) => x.h > 0).length;

  // ── #5 recommended-swipe 内嵌卡是否带 is-rcmd ──
  const swipe = document.querySelector('.recommended-swipe');
  const swipeInfo = swipe ? {
    exists: true,
    rect: rect(swipe),
    innerVideoCards: swipe.querySelectorAll('.bili-video-card').length,
    innerIsRcmd: swipe.querySelectorAll('.bili-video-card.is-rcmd').length,
  } : { exists: false };

  // ── #6 feed-card 里有没有 height=0 ──
  const feedCardsZeroHeight = feedCardInfo.filter((x) => x.h === 0).length;

  // ── grid 直接子元素分类 ──
  const gridKids = grid ? [...grid.children].map((c, i) => ({
    i,
    cls: String(c.className).slice(0, 45),
    ...rect(c),
    hasFeedCard: !!c.querySelector('.feed-card'),
    hasBiliFeedCard: !!c.querySelector('.bili-feed-card'),
    isFeedCardSelf: c.classList.contains('feed-card'),
    isBiliFeedCardSelf: c.classList.contains('bili-feed-card'),
  })) : [];

  return JSON.stringify({
    at: new Date().toISOString(),
    url: location.href,
    timestamp: Date.now(),
    counts: {
      feedCard: feedCards.length,
      biliFeedCard: biliFeedCards.length,
      rcmdVideoCard: rcmdBiliCards.length,
      rcmdWithHeight,
      gridChildren: grid ? grid.children.length : null,
    },
    nesting: {
      feedCardContainingBili,
      biliContainingFeed,
      sameElBothClasses,
      sample: nestingSample,
    },
    feedCardInfo,
    feedCardsZeroHeight,
    rcmdGeom: rcmdGeom.slice(0, 20),
    swipeInfo,
    gridKids: gridKids.slice(0, 32),
  });
})()`;

const results = [];
for (let r = 1; r <= ROUNDS; r++) {
  console.log(`\n${'='.repeat(66)}\n### 第 ${r}/${ROUNDS} 次采样`);
  if (r > 1) {
    console.log('reload...');
    try {
      runBs(['reload', '--session', SI, '--tab-id', TAB]);
    } catch (e) {
      console.log('  reload 报错:', String(e.message || '').slice(0, 120));
    }
    // 等页面稳定
    evaluate(`(async()=>{await new Promise(r=>setTimeout(r,4000));return JSON.stringify({ok:1})})()`);
  }
  const d = evaluate(MEASURE);
  if (d.raw) {
    console.log('  解析失败:', JSON.stringify(d).slice(0, 300));
    continue;
  }
  results.push(d);

  console.log(`  counts: ${JSON.stringify(d.counts)}`);
  console.log(`  嵌套: feedCard含bili=${d.nesting.feedCardContainingBili}  bili含feedCard=${d.nesting.biliContainingFeed}  同一元素两class=${d.nesting.sameElBothClasses}`);
  console.log(`  feedCard 数量 = ${d.counts.feedCard}，其中 height=0 的 = ${d.feedCardsZeroHeight}`);
  console.log(`  rcmd 卡 ${d.counts.rcmdVideoCard} 张，height>0 的 ${d.counts.rcmdWithHeight} 张`);
  console.log(`  swipe: ${JSON.stringify(d.swipeInfo)}`);
  if (r === 1) {
    console.log('\n  嵌套样例（第一张 feed-card）:');
    console.log('   ', JSON.stringify(d.nesting.sample, null, 1).replace(/\n/g, '\n    '));
    console.log('\n  grid 直接子元素（前 20）:');
    d.gridKids.slice(0, 20).forEach((k) => console.log(`    [${String(k.i).padStart(2)}] ${k.cls.padEnd(45)} top=${String(k.top).padStart(5)} h=${String(k.h).padStart(4)} selfFeed=${k.isFeedCardSelf} selfBili=${k.isBiliFeedCardSelf} 内含feed=${k.hasFeedCard} 内含bili=${k.hasBiliFeedCard}`));
  }
}

fs.writeFileSync('D:/Temp/nesting.json', JSON.stringify(results, null, 2), 'utf8');

console.log(`\n\n${'='.repeat(66)}\n### 汇总（${results.length} 次采样）`);
if (results.length) {
  const fc = results.map((x) => x.counts.feedCard);
  const bf = results.map((x) => x.counts.biliFeedCard);
  const rh = results.map((x) => x.counts.rcmdWithHeight);
  const nest = results.map((x) => `${x.nesting.feedCardContainingBili}/${x.counts.feedCard}`);
  console.log(`  feed-card 数量: ${fc.join(', ')}  → ${new Set(fc).size === 1 ? '稳定' : '⚠️ 不稳定'}`);
  console.log(`  bili-feed-card 数量: ${bf.join(', ')}  → ${new Set(bf).size === 1 ? '稳定' : '⚠️ 不稳定'}`);
  console.log(`  rcmd height>0: ${rh.join(', ')}  → ${new Set(rh).size === 1 ? '稳定' : '⚠️ 不稳定'}`);
  console.log(`  feed-card 内含 bili-feed-card: ${nest.join(', ')}  → ${results.every((x) => x.nesting.feedCardContainingBili === x.counts.feedCard) ? '✅ 全部嵌套（engineer-api 属实）' : '⚠️ 并非全部嵌套'}`);
  console.log(`  feed-card 里 height=0: ${results.map((x) => x.feedCardsZeroHeight).join(', ')}`);
}
