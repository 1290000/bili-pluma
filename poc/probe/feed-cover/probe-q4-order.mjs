/**
 * feed-cover 探针 Q4：**推荐流容器是不是 flex/grid？`order` 能否改视觉顺序？**
 *
 * ## 为什么重要
 * 若容器是 flex/grid，可以用 `order` 把后 10 张卡排到前面，**不动 DOM、不改布局高度** ——
 * 比隐藏干净得多（滚动 sentinel 位置完全不变）。
 *
 * ## 要测
 * 1. 卡片列表的直接父容器的 `display` 是什么（block / flex / grid）
 * 2. 每张卡的实际父链（.feed-card > .bili-feed-card > .bili-video-card）
 * 3. 给后 N 张设 `order:-1` 是否真的改变了**视觉位置**（用 getBoundingClientRect 验证）
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
  console.error('用法: node probe-q4-order.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2600));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'Q4-1 卡片的父链与容器 display',
  `(()=>{
     const card=document.querySelector('.bili-video-card');
     const chain=[];
     let n=card;
     for(let i=0;i<5&&n;i++){
       const cs=getComputedStyle(n);
       chain.push({
         tag:n.tagName.toLowerCase(),
         cls:(n.className||'').toString().slice(0,58),
         display:cs.display,
         flexDirection:cs.display==='flex'?cs.flexDirection:null,
         gridTemplate:cs.display==='grid'?cs.gridTemplateColumns:stringShort(cs.gridTemplateColumns):null,
         childCount:n.children?n.children.length:0
       });
       n=n.parentElement;
     }
     function stringShort(s){return s?String(s).slice(0,40):s}
     return JSON.stringify({chain});
   })()`,
);

step(
  'Q4-2 兄弟卡片的直接容器（feed-card 层）display',
  `(()=>{
     // 卡片外面那层 .feed-card 才是列表项
     const items=[...document.querySelectorAll('.feed-card')].slice(0,3);
     if(!items.length) return JSON.stringify({found:false});
     const parent=items[0].parentElement;
     const cs=parent?getComputedStyle(parent):null;
     return JSON.stringify({
       found:true,
       itemCount:document.querySelectorAll('.feed-card').length,
       parentTag:parent?parent.tagName.toLowerCase():null,
       parentCls:parent?(parent.className||'').toString().slice(0,60):null,
       parentDisplay:cs?cs.display:null,
       parentChildren:parent?parent.children.length:null
     });
   })()`,
);

step(
  'Q4-3 实测：给后 10 张 .feed-card 设 order:-1 是否改变视觉位置',
  `(()=>{
     const old=document.getElementById('__fc_order__'); if(old) old.remove();
     const items=[...document.querySelectorAll('.feed-card')];
     if(!items.length) return JSON.stringify({ok:false,reason:'no-feed-card'});
     const parent=items[0].parentElement;
     const before=items.slice(0,3).map(e=>{
       const t=e.querySelector('.bili-video-card__info--tit');
       return {top:Math.round(e.getBoundingClientRect().top), title:(t&&t.textContent||'').trim().slice(0,12)};
     });
     // 把最后 10 个设 order:-1
     items.slice(-10).forEach(e=>e.classList.add('__fc_ordertest__'));
     const st=document.createElement('style'); st.id='__fc_order__';
     st.textContent='.__fc_ordertest__{order:-1!important}';
     document.head.appendChild(st);
     const cs=parent?getComputedStyle(parent):null;
     const after=items.slice(0,3).map(e=>{
       const t=e.querySelector('.bili-video-card__info--tit');
       return {top:Math.round(e.getBoundingClientRect().top), title:(t&&t.textContent||'').trim().slice(0,12)};
     });
     return JSON.stringify({
       ok:true,
       parentDisplay:cs?cs.display:null,
       beforeTops:before.map(x=>x.top),
       afterTops:after.map(x=>x.top),
       moved: JSON.stringify(before.map(x=>x.top))!==JSON.stringify(after.map(x=>x.top))
     });
   })()`,
);

// 清理
evaluate(
  session,
  tab,
  `(()=>{document.querySelectorAll('.__fc_ordertest__').forEach(e=>e.classList.remove('__fc_ordertest__'));const o=document.getElementById('__fc_order__');if(o)o.remove();return 1})()`,
);
