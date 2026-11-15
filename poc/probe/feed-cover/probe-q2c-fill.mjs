/**
 * feed-cover 探针 Q2c（**方案生死线**）：隐藏 10 张后，**卡片能不能补满首屏**？
 *
 * ## 判据
 * 隐藏前 10 张后：
 *   - 首屏可见区域里，**最上面一张卡片**的 top 是多少？
 *   - 若 ≈ 0 → 无缝补满 ✅；若 > 0 → 顶部留白 ❌
 *
 * 另外测"净亏"：每次滚动净增 9 张 vs 隐藏 10 张 → 连续滚 3 轮看缺口是恒定还是累积。
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
  console.error('用法: node probe-q2c-fill.mjs --session <sid> --tab <tabId> --mode <display|visibility|height>');
  process.exit(2);
}

const MODE = get('--mode') || 'display';

const CSSMAP = {
  display: '.__fc_hidden__{display:none!important}',
  visibility: '.__fc_hidden__{visibility:hidden!important}',
  height:
    '.__fc_hidden__{height:0!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}',
};

const step = (label, expr, show = true) => {
  const r = evaluate(session, tab, expr);
  if (show) console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  if (show) console.log('  ' + r.out.slice(0, 2000));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

const ensureCSS = `(()=>{
  const old=document.getElementById('__fc_css__'); if(old) old.remove();
  const st=document.createElement('style'); st.id='__fc_css__';
  st.textContent=${JSON.stringify(CSSMAP[MODE])};
  document.head.appendChild(st);
  return 'added';
})()`;

const MEASURE = `(()=>{
  const cards=[...document.querySelectorAll('.bili-video-card')].filter(e=>!e.classList.contains('__fc_hidden__'));
  const visible=cards.filter(e=>{const r=e.getBoundingClientRect(); return r.height>0;});
  const first=visible[0]?visible[0].getBoundingClientRect():null;
  const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
  return JSON.stringify({
    visibleCards:visible.length,
    allCards:document.querySelectorAll('.bili-video-card').length,
    hidden:document.querySelectorAll('.__fc_hidden__').length,
    firstVisibleTop:first?Math.round(first.top):null,
    docHeight:document.documentElement.scrollHeight,
    scrollY:Math.round(window.scrollY),
    rcmdCount:rcmd
  });
})()`;

step('初始化样式', ensureCSS, false);

step(
  `[${MODE}] 隐藏前 10 张`,
  `(()=>{
     document.querySelectorAll('.__fc_hidden__').forEach(e=>e.classList.remove('__fc_hidden__'));
     const cards=[...document.querySelectorAll('.bili-video-card')];
     cards.slice(0,10).forEach(e=>e.classList.add('__fc_hidden__'));
     return 'marked';
   })()`,
  false,
);

const m0 = step('步骤0：隐藏后初始状态', MEASURE);

const rounds = [];
for (let i = 1; i <= 3; i += 1) {
  step(
    `第 ${i} 轮滚动`,
    `(async()=>{ window.scrollTo(0,document.documentElement.scrollHeight); await new Promise(r=>setTimeout(r,5000)); window.scrollTo(0,0); await new Promise(r=>setTimeout(r,300)); return 'ok'; })()`,
    false,
  );
  const m = step(`第 ${i} 轮后（已滚回顶部）`, MEASURE);
  if (m) {
    rounds.push({
      round: i,
      rcmdDelta: m.rcmdCount - 2,
      cardDelta: m.allCards - 39,
      visibleCards: m.visibleCards,
      firstVisibleTop: m.firstVisibleTop,
      docHeight: m.docHeight,
    });
  }
}

console.log('\n=== 汇总 ===');
console.log('初始（隐藏 10 张后，滚回顶部）:', JSON.stringify(m0));
console.log('各轮:', JSON.stringify(rounds, null, 1));

evaluate(
  session,
  tab,
  `(()=>{document.querySelectorAll('.__fc_hidden__').forEach(e=>e.classList.remove('__fc_hidden__'));const o=document.getElementById('__fc_css__');if(o)o.remove();return 1})()`,
);
