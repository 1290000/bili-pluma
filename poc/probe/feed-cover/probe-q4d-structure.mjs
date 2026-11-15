/**
 * feed-cover 探针 Q4d：**摸清 `.container.is-version8` 的真实子元素结构**。
 *
 * ## 疑点
 * 前面测到 grid 有 **48 个子元素**，但 `.feed-card` 只有 **10 个**。
 * 说明另外 38 个字元素用的是**别的类名**（可能是 `.bili-video-card` 的另一种包装、
 * 或者直播/番剧卡、或者 `load-more` anchor）。
 *
 * 必须先看清结构，才能判断"能不能用 order 把 B 的卡提到 A 前面"。
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
  console.error('用法: node probe-q4d-structure.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 3500));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'Q4d-1 grid 全部 48 个子元素的类名分布',
  `(()=>{
     const grid=document.querySelector('.container.is-version8');
     if(!grid) return JSON.stringify({found:false});
     const kids=[...grid.children];
     const map={};
     kids.forEach((e,i)=>{
       const c=(e.className||'').toString().trim()||'(none)';
       if(!map[c]) map[c]=[];
       map[c].push(i);
     });
     const summary={};
     for(const [c,idxs] of Object.entries(map)) summary[c]={count:idxs.length,firstIdx:idxs[0]};
     return JSON.stringify({total:kids.length,dist:summary});
   })()`,
);

step(
  'Q4d-2 前 3 个与第 10-13 个子元素的结构',
  `(()=>{
     const grid=document.querySelector('.container.is-version8');
     const kids=[...grid.children];
     const desc=(e)=>{
       const card=e.querySelector('.bili-video-card');
       const a=e.querySelector('a[href*="/video/BV"]');
       const t=e.querySelector('[class*="info--tit"]');
       return {
         cls:(e.className||'').toString().slice(0,45),
         hasVideoCard:!!card,
         bv:a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null,
         title:(t&&t.textContent||'').trim().slice(0,16),
         top:Math.round(e.getBoundingClientRect().top),
         h:Math.round(e.getBoundingClientRect().height)
       };
     };
     return JSON.stringify({
       idx0:desc(kids[0]),
       idx1:desc(kids[1]),
       idx2:desc(kids[2]),
       idx10:desc(kids[10]),
       idx11:desc(kids[11]),
       idx12:desc(kids[12]),
       lastIdx:desc(kids[kids.length-1])
     });
   })()`,
);
