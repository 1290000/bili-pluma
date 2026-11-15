/**
 * feed-cover 探针 Q4f：**order 方案的代价** —— A 的卡去哪了？会不会重复？
 *
 * ## 关键疑问
 * 设 `order:-1` 后 B 的卡跑到了前面，那原来的 10 张 A 卡在**视觉上的哪个位置**？
 *   - 被挤到 B 后面（B 在前、A 在后）→ 用户往下滚还是会看到 A 的卡 ⚠️
 *   - 还是被完全遮住 → 用户看不到 ✅（但 DOM 里仍在，滚到底时会看到）
 *
 * 另外验证：**有没有重复 BV**（order 只是重排，不会重复，但要实测确认）。
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
  console.error('用法: node probe-q4f-cost.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr, show = true) => {
  const r = evaluate(session, tab, expr);
  if (show) console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  if (show) console.log('  ' + r.out.slice(0, 3200));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  '施加 order + 记录 A 卡（.feed-card）的视觉位置',
  `(()=>{
     const old=document.getElementById('__fc_p__'); if(old) old.remove();
     const st=document.createElement('style'); st.id='__fc_p__';
     st.textContent='.container.is-version8 > .bili-feed-card{order:-1!important}';
     document.head.appendChild(st);
     return 'ok';
   })()`,
  false,
);

const r = step(
  'Q4f：A 卡与 B 卡的视觉分布',
  `(()=>{
     const grid=document.querySelector('.container.is-version8');
     const items=[...grid.children].map(e=>{
       const a=e.querySelector('a[href*="/video/BV"]');
       const rect=e.getBoundingClientRect();
       return {
         cls:(e.className||'').toString().split(' ')[0],
         bv:a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null,
         absoluteTop:Math.round(rect.top+window.scrollY),
         h:Math.round(rect.height)
       };
     }).filter(x=>x.h>0).sort((a,b)=>a.absoluteTop-b.absoluteTop);

     const aCards=items.filter(x=>x.cls==='feed-card');
     const bCards=items.filter(x=>x.cls==='bili-feed-card');
     const allBv=items.map(x=>x.bv).filter(Boolean);
     const dup=allBv.filter((v,i)=>allBv.indexOf(v)!==i);

     return JSON.stringify({
       totalVisible:items.length,
       aCount:aCards.length, bCount:bCards.length,
       aFirstTop:aCards.length?aCards[0].absoluteTop:null,
       aLastTop:aCards.length?aCards[aCards.length-1].absoluteTop:null,
       bFirstTop:bCards.length?bCards[0].absoluteTop:null,
       bLastTop:bCards.length?bCards[bCards.length-1].absoluteTop:null,
       visualOrderTop8:items.slice(0,8).map(x=>x.cls+':'+x.bv),
       duplicateBvCount:dup.length,
       docHeight:document.documentElement.scrollHeight,
       scrollHeightVisible:document.documentElement.scrollHeight - window.innerHeight
     });
   })()`,
);

// 清理
evaluate(session, tab, `(()=>{const o=document.getElementById('__fc_p__');if(o)o.remove();return 1})()`);

if (r) {
  console.log('\n=== 判读 ===');
  console.log('A 卡（feed-card）首位置:', r.aFirstTop, ' B 卡首位置:', r.bFirstTop);
  console.log('A 卡在 B 卡之后 =', r.aFirstTop !== null && r.bFirstTop !== null && r.aFirstTop > r.bFirstTop);
  console.log('重复 BV 数:', r.duplicateBvCount);
}
