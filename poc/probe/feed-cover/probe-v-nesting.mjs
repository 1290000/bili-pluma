/**
 * feed-cover 探针 V：**纠正对 DOM 结构的误解** —— `.feed-card` 与 `.bili-feed-card` 是什么关系。
 *
 * ## 疑点
 * U-1 实测：`feed-card` 的 8 个唯一 BV **全部**出现在 `bili-feed-card` 里，
 * 同一个 BV 在 `feed-card[0]` 和 `bili-feed-card[0]` 同时出现。
 *
 * ## 可能
 * a. 它们是**嵌套**关系（`.feed-card > .bili-feed-card > .bili-video-card`）
 * b. 它们是**同一个元素上的两个类名**
 * c. 它们是兄弟，但内容重复
 *
 * ## 这决定 A.2 的"六类子元素"表对不对
 * 如果 a 成立，那 grid 的 48 个子元素里 `.feed-card` 和 `.bili-feed-card` **不是并列的**，
 * 我之前把它们当并列类型是错的。
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
  console.error('用法: node probe-v-nesting.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 500));
    return null;
  }
  console.log('  ' + r.out.slice(0, 3200));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'V-1 grid 直接子元素的真实类名（不 split，看完整字符串）',
  `(()=>{
     const grid=document.querySelector('.container.is-version8');
     const kids=[...grid.children];
     return JSON.stringify({
       total:kids.length,
       full:kids.map((e,i)=>({i,cls:(e.className||'').toString(),tag:e.tagName.toLowerCase()}))
     });
   })()`,
);

step(
  'V-2 .feed-card 与 .bili-feed-card 的层次关系',
  `(()=>{
     const fc=[...document.querySelectorAll('.feed-card')];
     const bfc=[...document.querySelectorAll('.bili-feed-card')];
     const grid=document.querySelector('.container.is-version8');

     // feed-card 是不是 grid 直接子元素
     const fcDirect=fc.filter(e=>e.parentElement===grid).length;
     // bili-feed-card 是不是 grid 直接子元素
     const bfcDirect=bfc.filter(e=>e.parentElement===grid).length;
     // feed-card 里有没有 bili-feed-card
     const fcContainsBfc=fc.filter(e=>e.querySelector('.bili-feed-card')).length;
     // bili-feed-card 里有没有 feed-card
     const bfcContainsFc=bfc.filter(e=>e.querySelector('.feed-card')).length;
     // 同一个元素同时有两种类名？
     const both=fc.filter(e=>e.classList.contains('bili-feed-card')).length;

     return JSON.stringify({
       feedCardTotal:fc.length, feedCardDirectChildrenOfGrid:fcDirect,
       biliFeedCardTotal:bfc.length, biliFeedCardDirectChildrenOfGrid:bfcDirect,
       feedCardContainingBiliFeedCard:fcContainsBfc,
       biliFeedCardContainingFeedCard:bfcContainsFc,
       elementsWithBothClasses:both,
       sampleChain:(()=>{
         const e=document.querySelector('.bili-feed-card');
         const chain=[]; let n=e;
         for(let i=0;i<5&&n;i++){
           chain.push({tag:n.tagName.toLowerCase(),cls:(n.className||'').toString().slice(0,60)});
           n=n.parentElement;
         }
         return chain;
       })()
     });
   })()`,
);

step(
  'V-3 grid 直接子元素的类名分布（按完整 className 归组）',
  `(()=>{
     const grid=document.querySelector('.container.is-version8');
     const kids=[...grid.children];
     const map={};
     kids.forEach(e=>{
       const c=(e.className||'').toString().trim();
       map[c]=(map[c]||0)+1;
     });
     return JSON.stringify({distinct:Object.keys(map).length, groups:map});
   })()`,
);
