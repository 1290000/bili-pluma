/**
 * feed-cover 探针 S2：**变体实验的滚动补位验证** —— 只隐藏 `.feed-card` 后连滚 3 轮。
 *
 * ## 验证什么
 * S 组已证明：隐藏 10 个 `.feed-card` 后第一张可见卡 `top` **回到 255**（无空洞）。
 * 但还要确认：
 *   1. 滚动是否仍触发（rcmdDelta）
 *   2. 每轮之后第一张卡是否**仍然顶在 255**（不被新内容挤走）
 *   3. 有没有卡"掉上去"造成错位
 *
 * ## 判据
 * `top` 每轮都是 255（±10px）→ 补位稳定，方案成立
 */
import { evaluate } from './../api-inventory/bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-s2-fill-scroll.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr, show = true) => {
  const r = evaluate(session, tab, expr);
  if (show) console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  if (show) console.log('  ' + r.out.slice(0, 2400));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

const MEASURE = `(()=>{
  const allCards=[...document.querySelectorAll('.bili-video-card')];
  const vis=allCards.filter(e=>{const r=e.getBoundingClientRect();return r.height>0 && getComputedStyle(e).display!=='none'});
  const swipe=document.querySelector('.recommended-swipe');
  const feedCards=[...document.querySelectorAll('.feed-card')];
  const hiddenFeed=feedCards.filter(e=>getComputedStyle(e).display==='none');
  const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
  // 第一张可见卡的类名与来源
  const first=vis[0];
  const firstParentCls=first?(()=>{
    let n=first;
    while(n && !n.className) n=n.parentElement;
    // 往上找最近的 grid 子元素
    const grid=document.querySelector('.container.is-version8');
    let cur=first;
    while(cur && cur.parentElement!==grid) cur=cur.parentElement;
    return cur?(cur.className||'').toString().split(' ')[0]:null;
  })():null;
  return JSON.stringify({
    firstVisibleTop: first?Math.round(first.getBoundingClientRect().top):null,
    firstCardSourceClass: firstParentCls,
    visibleCards:vis.length,
    feedCardsTotal:feedCards.length,
    feedCardsHidden:hiddenFeed.length,
    swipeHeight:swipe?Math.round(swipe.getBoundingClientRect().height):null,
    docHeight:document.documentElement.scrollHeight,
    rcmdCount:rcmd,
    scrollY:Math.round(window.scrollY)
  });
})()`;

// 注入并隐藏
step(
  '建立基线 + 隐藏 .feed-card',
  `(()=>{
     document.querySelectorAll('.__fc_hide_feedcard__').forEach(e=>e.classList.remove('__fc_hide_feedcard__'));
     const o=document.getElementById('__fc_s__'); if(o) o.remove();
     const st=document.createElement('style'); st.id='__fc_s__';
     st.textContent='.__fc_hide_feedcard__{display:none!important}';
     document.head.appendChild(st);
     const fc=[...document.querySelectorAll('.feed-card')];
     fc.forEach(e=>e.classList.add('__fc_hide_feedcard__'));
     window.scrollTo(0,0);
     return JSON.stringify({applied:fc.length, assertApplied: document.querySelectorAll('.__fc_hide_feedcard__').length===fc.length});
   })()`,
  false,
);

const rounds = [];
const m0 = step('初始（隐藏后，滚回顶部）', MEASURE);
rounds.push({ round: 0, ...m0 });

for (let i = 1; i <= 3; i += 1) {
  step(
    `第 ${i} 轮滚动`,
    `(async()=>{ window.scrollTo(0,document.documentElement.scrollHeight); await new Promise(r=>setTimeout(r,5200)); window.scrollTo(0,0); await new Promise(r=>setTimeout(r,400)); return 'ok'; })()`,
    false,
  );
  const m = step(`第 ${i} 轮后（已滚回顶部）`, MEASURE);
  rounds.push({ round: i, ...m });
}

console.log('\n=== 各轮汇总 ===');
for (const r of rounds) {
  console.log(
    `第${r.round}轮: top=${r.firstVisibleTop} 来源=${r.firstCardSourceClass} 可见卡=${r.visibleCards} 隐藏feed=${r.feedCardsHidden} 轮播高=${r.swipeHeight} 文档高=${r.docHeight} rcmd=${r.rcmdCount}`,
  );
}
const tops = rounds.map((r) => r.firstVisibleTop);
const allAt255 = tops.every((t) => t !== null && Math.abs(t - 255) <= 10);
console.log('\n每轮 top 都是 255(±10):', allAt255, ' tops=', JSON.stringify(tops));
console.log('rcmd 总增量:', rounds[rounds.length - 1].rcmdCount - rounds[0].rcmdCount);

// 清理
evaluate(
  session,
  tab,
  `(()=>{document.querySelectorAll('.__fc_hide_feedcard__').forEach(e=>e.classList.remove('__fc_hide_feedcard__'));const o=document.getElementById('__fc_s__');if(o)o.remove();window.scrollTo(0,0);return 1})()`,
);
