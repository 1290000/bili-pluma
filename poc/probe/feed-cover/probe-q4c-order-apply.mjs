/**
 * feed-cover 探针 Q4c：**用 grid `order` 把后面的卡提到前面** —— 完整可行性验证。
 *
 * ## 思路
 * 首屏 10 张（A 身份）grid 位置在前、后面的（B 身份）在后。
 * 若容器是 grid 且子元素是 `auto` 定位，`order` 能让 B 的卡**视觉上跑到前面**，
 * **不动 DOM、不改高度、不改滚动 sentinel** —— 这是比隐藏干净得多的方案。
 *
 * ## 要验证
 * 1. 设 order 后，**最上面**的卡是哪一批的（对比 BV 序列）
 * 2. 文档总高度是否变化（不变 = 不影响滚动）
 * 3. 滚动后新加载的卡会不会跑到前面（order 是否保持）
 * 4. 滚动是否仍正常触发
 *
 * ⚠️ 只读：只改 CSS + 滚动，不点视频、不发写请求。
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
  console.error('用法: node probe-q4c-order-apply.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr, show = true) => {
  const r = evaluate(session, tab, expr);
  if (show) console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  if (show) console.log('  ' + r.out.slice(0, 2600));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// 视觉顺序快照：按 getBoundingClientRect().top 排序，取前 8 张的 BV
const VISUAL = `(()=>{
  const items=[...document.querySelectorAll('.feed-card')].map(e=>{
    const card=e.querySelector('.bili-video-card');
    const a=e.querySelector('a[href*="/video/BV"]');
    const r=e.getBoundingClientRect();
    return {top:Math.round(r.top+window.scrollY), bv:a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null};
  }).filter(x=>x.bv).sort((a,b)=>a.top-b.top);
  return JSON.stringify({
    visualFirst8: items.slice(0,8).map(x=>x.bv),
    docHeight: document.documentElement.scrollHeight,
    totalFeedCards: document.querySelectorAll('.feed-card').length,
    rcmdCount: performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length,
    scrollY: Math.round(window.scrollY)
  });
})()`;

const s0 = step('基线：视觉顺序（不设 order）', VISUAL);

step(
  '应用 order：把第 11 张起的 .feed-card 提到前面',
  `(()=>{
     document.querySelectorAll('.__fc_push__').forEach(e=>e.classList.remove('__fc_push__'));
     const old=document.getElementById('__fc_push_css__'); if(old) old.remove();
     const grid=document.querySelector('.container.is-version8');
     if(!grid) return JSON.stringify({ok:false,reason:'no-grid'});
     // grid 第一个子元素是 recommended-swipe（轮播），保持原位
     const kids=[...grid.children];
     const cards=kids.filter(k=>k.classList.contains('feed-card'));
     // 前 10 张 = 首屏 A 身份；其余推到前面
     const toPush=cards.slice(10);
     toPush.forEach(e=>e.classList.add('__fc_push__'));
     const st=document.createElement('style'); st.id='__fc_push_css__';
     st.textContent='.__fc_push__{order:-1!important}';
     document.head.appendChild(st);
     return JSON.stringify({ok:true,pushed:toPush.length,totalCards:cards.length});
   })()`,
);

const s1 = step('设置 order 后：视觉顺序', VISUAL);

step(
  '滚动一次（验证 order 后滚动是否仍触发）',
  `(async()=>{ window.scrollTo(0,document.documentElement.scrollHeight); await new Promise(r=>setTimeout(r,5000)); window.scrollTo(0,0); await new Promise(r=>setTimeout(r,300)); return 'ok'; })()`,
  false,
);

const s2 = step('滚动后（已滚回顶部）：视觉顺序', VISUAL);

console.log('\n=== 汇总 ===');
console.log('基线与设 order 后，「视觉最前 8 条」是否相同:',
  s0 && s1 ? s0.visualFirst8.join(',') === s1.visualFirst8.join(',') : null);
console.log('文档高度变化（0 = 不影响滚动布局）:', s0 && s1 ? s1.docHeight - s0.docHeight : null);
console.log('滚动后 rcmd 增量:', s1 && s2 ? s2.rcmdCount - s1.rcmdCount : null);
console.log('基线前8:', JSON.stringify(s0 && s0.visualFirst8));
console.log('order后前8:', JSON.stringify(s1 && s1.visualFirst8));
console.log('滚动后前8:', JSON.stringify(s2 && s2.visualFirst8));

// 清理
evaluate(
  session,
  tab,
  `(()=>{document.querySelectorAll('.__fc_push__').forEach(e=>e.classList.remove('__fc_push__'));const o=document.getElementById('__fc_push_css__');if(o)o.remove();return 1})()`,
);
