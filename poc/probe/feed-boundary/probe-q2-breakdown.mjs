/**
 * feed-boundary 探针：Q2 拆解 —— 首屏 10 条 SSR 与 rcmd 首轮之后的 23 条是什么关系。
 *
 * ## 疑点
 * 初始快照里 `totalCards=39`、`realBv=23`、`rcmdCount=2`。
 * 而 SSR 只有 10 张 is-rcmd。那 23 条从哪来？39 张卡里 16 张没有 BV 是什么？
 *
 * 本探针逐张卡片打印 idx / 有无 BV / 类名，把 39 张的结构摊开。
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
  console.error('用法: node probe-q2-breakdown.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 4000));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'Q2 拆解：39 张卡逐张类型',
  `(()=>{
     const els=[...document.querySelectorAll('.bili-video-card')];
     const rows=els.map((e,i)=>{
       const a=e.querySelector('a[href*="/video/BV"]');
       const bv=a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null;
       const titleEl=e.querySelector('[class*="info--tit"]');
       return {
         i,
         bv,
         hasTitle:!!titleEl,
         title:(titleEl&&titleEl.textContent||'').trim().slice(0,14),
         cls:e.className.replace('bili-video-card','').trim()||'(none)'
       };
     });
     return JSON.stringify({
       total:rows.length,
       withBv:rows.filter(r=>r.bv).length,
       withoutBv:rows.filter(r=>!r.bv).length,
       noBvRows:rows.filter(r=>!r.bv).map(r=>({i:r.i,hasTitle:r.hasTitle,title:r.title,cls:r.cls})).slice(0,20)
     });
   })()`,
);
