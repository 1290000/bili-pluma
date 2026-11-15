/**
 * feed-cover 探针 Q4e：**用 order 把 rcmd 新卡（`.bili-feed-card`）提到首屏之前**。
 *
 * ## 已摸清的结构（Q4d 实测）
 * `.container.is-version8`（grid，4 列）的 48 个子元素：
 *   - idx 0        `recommended-swipe`   ×1   （顶部轮播）
 *   - idx 1–10     `feed-card`           ×10  ← **首屏 SSR 批（A 身份）**
 *   - idx 11…      `floor-single-card`   ×9   （楼层分隔）
 *   - idx 12…      `bili-feed-card`      ×18  ← **rcmd 加载的卡（B 身份）**
 *   - idx 36…      `bili-video-card`     ×9
 *   - idx 39       `load-more-anchor`    ×1   （滚动哨兵）
 *
 * ## 要验证
 * 给 `.bili-feed-card` 那一批设 `order:-1` 后：
 *   1. 视觉最前面的是不是 B 的卡
 *   2. 文档总高度变不变（不变 = 不影响滚动）
 *   3. 滚动后新加载的卡是否也自动享受 order
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
  console.error('用法: node probe-q4e-promote.mjs --session <sid> --tab <tabId>');
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

const VISUAL = `(()=>{
  const grid=document.querySelector('.container.is-version8');
  if(!grid) return JSON.stringify({ok:false});
  const items=[...grid.children].map(e=>{
    const a=e.querySelector('a[href*="/video/BV"]');
    const r=e.getBoundingClientRect();
    return {
      cls:(e.className||'').toString().split(' ')[0],
      bv:a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null,
      top:Math.round(r.top+window.scrollY),
      h:Math.round(r.height)
    };
  }).filter(x=>x.bv && x.h>0).sort((a,b)=>a.top-b.top);
  return JSON.stringify({
    ok:true,
    visualFirst10: items.slice(0,10).map(x=>({c:x.cls,bv:x.bv})),
    visualFirstCls: items.slice(0,3).map(x=>x.cls),
    docHeight: document.documentElement.scrollHeight,
    rcmdCount: performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length,
    childCount: grid.children.length
  });
})()`;

const s0 = step('基线：视觉顺序', VISUAL);

step(
  '施加 order：.bili-feed-card 提到最前',
  `(()=>{
     const old=document.getElementById('__fc_p__'); if(old) old.remove();
     const st=document.createElement('style'); st.id='__fc_p__';
     st.textContent='.container.is-version8 > .bili-feed-card{order:-1!important}';
     document.head.appendChild(st);
     return JSON.stringify({injected:true,matched:document.querySelectorAll('.container.is-version8 > .bili-feed-card').length});
   })()`,
);

const s1 = step('施加 order 后：视觉顺序', VISUAL);

step(
  '滚动一次',
  `(async()=>{ window.scrollTo(0,document.documentElement.scrollHeight); await new Promise(r=>setTimeout(r,5200)); window.scrollTo(0,0); await new Promise(r=>setTimeout(r,300)); return 'ok'; })()`,
  false,
);

const s2 = step('滚动后：视觉顺序', VISUAL);

console.log('\n=== 汇总 ===');
if (s0 && s1) {
  console.log('文档高度变化（0 = 不影响布局）:', s1.docHeight - s0.docHeight);
  console.log('前 3 张的类名 基线→order后:', JSON.stringify(s0.visualFirstCls), '→', JSON.stringify(s1.visualFirstCls));
  console.log('视觉顺序是否改变:', JSON.stringify(s0.visualFirst10) !== JSON.stringify(s1.visualFirst10));
}
console.log('基线前5:', JSON.stringify(s0 && s0.visualFirst10.slice(0, 5)));
console.log('order后前5:', JSON.stringify(s1 && s1.visualFirst10.slice(0, 5)));
if (s1 && s2) {
  console.log('滚动后 rcmd 增量:', s2.rcmdCount - s1.rcmdCount);
  console.log('滚动后前3类名:', JSON.stringify(s2.visualFirstCls));
  console.log('滚动后文档高:', s2.docHeight);
}

evaluate(session, tab, `(()=>{const o=document.getElementById('__fc_p__');if(o)o.remove();return 1})()`);
