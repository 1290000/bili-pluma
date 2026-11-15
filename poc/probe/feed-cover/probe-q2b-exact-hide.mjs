/**
 * feed-cover 探针 Q2b：**修正隐藏范围** —— 用 JS 精确取前 10 张，而不是 CSS nth-of-type。
 *
 * ## 为什么 nth-of-type 不准
 * `.bili-video-card:nth-of-type(-n+10)` 是按**同类型元素中的序号**算的，
 * 而卡片外层是 `.feed-card > .bili-feed-card > .bili-video-card`，
 * 中间还夹着别的 div，所以实际上只命中了 9 张。
 *
 * 正确做法：JS 取 `querySelectorAll('.bili-video-card')` 的前 10 个，逐个加 inline style
 * （用 `!important` 通过设置属性做不到，但可以加一个专用 class + 一条 CSS 规则）。
 *
 * ## 这个探针同时回答
 *   - 精确隐藏 10 张后，滚动是否仍触发
 *   - 首屏位置留下的空白有多少像素（判"能不能被后面的卡补上"）
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
  console.error('用法: node probe-q2b-exact-hide.mjs --session <sid> --tab <tabId> --mode <display|visibility|height>');
  process.exit(2);
}

const MODE = get('--mode') || 'display';

const step = (label, expr, quiet) => {
  const r = evaluate(session, tab, expr);
  if (!quiet) console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  if (!quiet) console.log('  ' + r.out.slice(0, 2000));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// 精确标记前 10 张
const mark = `(()=>{
  document.querySelectorAll('.__fc_hidden__').forEach(e=>e.classList.remove('__fc_hidden__'));
  const old=document.getElementById('__fc_css__'); if(old) old.remove();
  const cards=[...document.querySelectorAll('.bili-video-card')];
  const first10=cards.slice(0,10);
  first10.forEach(e=>e.classList.add('__fc_hidden__'));
  const st=document.createElement('style');
  st.id='__fc_css__';
  st.textContent=${JSON.stringify(
    MODE === 'display'
      ? '.__fc_hidden__{display:none!important}'
      : MODE === 'visibility'
        ? '.__fc_hidden__{visibility:hidden!important}'
        : '.__fc_hidden__{height:0!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}',
  )};
  document.head.appendChild(st);
  return JSON.stringify({
    marked:first10.length,
    cardsTotal:cards.length,
    docHeight:document.documentElement.scrollHeight,
    mode:'${MODE}'
  });
})()`;

const before = step(`[${MODE}] 精确隐藏前 10 张`, mark);

step(
  `[${MODE}] 滚到底等 5 秒`,
  `(async()=>{ window.scrollTo(0,document.documentElement.scrollHeight); await new Promise(r=>setTimeout(r,5200)); return 'done'; })()`,
  true,
);

const after = step(
  `[${MODE}] 滚动后`,
  `(()=>{
     const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
     return JSON.stringify({
       rcmdCount:rcmd,
       allCards:document.querySelectorAll('.bili-video-card').length,
       hiddenMarked:document.querySelectorAll('.__fc_hidden__').length,
       docHeight:document.documentElement.scrollHeight
     });
   })()`,
);

if (before && after) {
  console.log('\n=== 汇总 ===');
  console.log(
    JSON.stringify({
      mode: MODE,
      marked: before.marked,
      rcmdDelta: after.rcmdCount - 2,
      cardDelta: after.allCards - before.cardsTotal,
      docHeightBefore: before.docHeight,
      docHeightAfter: after.docHeight,
    }),
  );
}

// 清理
evaluate(
  session,
  tab,
  `(()=>{document.querySelectorAll('.__fc_hidden__').forEach(e=>e.classList.remove('__fc_hidden__'));const o=document.getElementById('__fc_css__');if(o)o.remove();return 1})()`,
);
