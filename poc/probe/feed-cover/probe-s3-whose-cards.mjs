/**
 * feed-cover 探针 S3：**确认第一张可见卡属于哪一批** —— 判"补位"到底补了谁的卡。
 *
 * ## 疑点
 * S2 里 `firstCardSourceClass: "recommended-swipe"` —— 第一张可见卡来自**顶部轮播内部**，
 * 而轮播是 SSR 下发的（页面身份 A）。那"补位"补的到底是谁？
 *
 * ## 要测
 * 1. 轮播 `recommended-swipe` 内部有几张卡？它们属于 A 还是 B？
 * 2. 隐藏 `.feed-card` 后，**第一屏可见的卡**里 A/B 各占多少？
 * 3. 轮播之后的第一个内容区是谁的卡？
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
  console.error('用法: node probe-s3-whose-cards.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 3000));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'S3-1 隐藏 .feed-card 后，按"来源容器"分类统计首屏可见卡',
  `(()=>{
     document.querySelectorAll('.__fc_hide_feedcard__').forEach(e=>e.classList.remove('__fc_hide_feedcard__'));
     const o=document.getElementById('__fc_s__'); if(o) o.remove();
     const st=document.createElement('style'); st.id='__fc_s__';
     st.textContent='.__fc_hide_feedcard__{display:none!important}';
     document.head.appendChild(st);
     [...document.querySelectorAll('.feed-card')].forEach(e=>e.classList.add('__fc_hide_feedcard__'));
     window.scrollTo(0,0);

     const grid=document.querySelector('.container.is-version8');
     const kids=[...grid.children];
     const vh=window.innerHeight;
     const rows=kids.map((e,i)=>{
       const r=e.getBoundingClientRect();
       const cls=(e.className||'').toString().split(' ')[0];
       const cards=e.querySelectorAll('.bili-video-card').length;
       return {i,cls,cards,top:Math.round(r.top),h:Math.round(r.height),inViewport:r.top<vh && r.bottom>0};
     }).filter(x=>x.h>0 || x.cards>0);

     const inVp=rows.filter(x=>x.inViewport);
     const swipeRow=rows.find(x=>x.cls==='recommended-swipe');
     return JSON.stringify({
       viewportH:vh,
       swipeInternalCards:swipeRow?swipeRow.cards:null,
       swipeHeight:swipeRow?swipeRow.h:null,
       inViewportContainers:inVp.map(x=>({cls:x.cls,top:x.top,h:x.h,cards:x.cards})),
       firstNonSwipeContainer:(()=>{
         const f=rows.find(x=>x.cls!=='recommended-swipe' && x.cards>0 && x.h>0);
         return f?{cls:f.cls,top:f.top,cards:f.cards}:null;
       })()
     });
   })()`,
);

step(
  'S3-2 轮播内的卡是什么（href / BV）',
  `(()=>{
     const sw=document.querySelector('.recommended-swipe');
     if(!sw) return JSON.stringify({found:false});
     const cards=[...sw.querySelectorAll('.bili-video-card')];
     const bvs=cards.map(e=>{
       const a=e.querySelector('a[href*="/video/BV"]');
       return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null;
     }).filter(Boolean);
     return JSON.stringify({
       found:true,
       swipeCards:cards.length,
       bvs:bvs.slice(0,8),
       hasTitles:cards.filter(e=>e.querySelector('[class*="info--tit"]')).length
     });
   })()`,
);

// 清理
evaluate(
  session,
  tab,
  `(()=>{document.querySelectorAll('.__fc_hide_feedcard__').forEach(e=>e.classList.remove('__fc_hide_feedcard__'));const o=document.getElementById('__fc_s__');if(o)o.remove();return 1})()`,
);
