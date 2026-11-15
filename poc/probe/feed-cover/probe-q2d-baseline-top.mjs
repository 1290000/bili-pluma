/**
 * feed-cover 探针 Q2d：**判定 409px 是不是"补不满"的空洞** —— 基线对照。
 *
 * ## 疑点
 * 隐藏 10 张后 `firstVisibleTop = 409`，恒定不变。
 * 但这 **可能只是首页正常的顶部留白**（导航栏 + 轮播/banner 区），
 * 与隐藏无关。必须做基线对照。
 *
 * ## 判据
 * - 基线（不隐藏）的 `firstVisibleTop` 是多少？
 *   - 若也是 ~409 → 409 是**正常留白**，隐藏没有造成额外空洞 ✅
 *   - 若明显更小（如 ~100）→ 隐藏制造了 ~309px 空洞 ❌
 *
 * 同时量：第一张**可见卡**到视口顶部的距离、以及卡片区容器的 padding/margin。
 */
import { evaluate } from './../api-inventory/bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
const MODE = get('--mode') || 'baseline';
if (!session || !tab) {
  console.error('用法: node probe-q2d-baseline-top.mjs --session <sid> --tab <tabId> --mode <baseline|display>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2200));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

const CSS =
  '.__fc_hidden__{display:none!important}';

step(
  '准备',
  `(()=>{
     document.querySelectorAll('.__fc_hidden__').forEach(e=>e.classList.remove('__fc_hidden__'));
     const old=document.getElementById('__fc_css__'); if(old) old.remove();
     ${
       MODE === 'display'
         ? `const st=document.createElement('style');st.id='__fc_css__';st.textContent=${JSON.stringify(CSS)};document.head.appendChild(st);
            const cards=[...document.querySelectorAll('.bili-video-card')];
            cards.slice(0,10).forEach(e=>e.classList.add('__fc_hidden__'));`
         : ''
     }
     window.scrollTo(0,0);
     return 'ready';
   })()`,
);

step(
  `[${MODE}] 第一张卡片与视口的关系`,
  `(()=>{
     const all=[...document.querySelectorAll('.bili-video-card')];
     const vis=all.filter(e=>{const r=e.getBoundingClientRect();return r.height>0});
     const first3=vis.slice(0,3).map(e=>({top:Math.round(e.getBoundingClientRect().top),h:Math.round(e.getBoundingClientRect().height)}));
     const feed2=document.querySelector('.feed2');
     const rec=document.querySelector('.recommended-container_floor-aside');
     const gr=e=>e?getComputedStyle(e):null;
     return JSON.stringify({
       firstVisibleTop: vis[0]?Math.round(vis[0].getBoundingClientRect().top):null,
       first3,
       headerH: (()=>{const h=document.querySelector('.bili-header,header'); return h?Math.round(h.getBoundingClientRect().height):null})(),
       feed2Top: feed2?Math.round(feed2.getBoundingClientRect().top):null,
       feed2PaddingTop: gr(feed2)?gr(feed2).paddingTop:null,
       recTop: rec?Math.round(rec.getBoundingClientRect().top):null,
       recPaddingTop: gr(rec)?gr(rec).paddingTop:null,
       carousel: (()=>{const c=document.querySelector('.recommended-swipe, .bili-carousel, [class*="swipe"]'); return c?{top:Math.round(c.getBoundingClientRect().top),h:Math.round(c.getBoundingClientRect().height)}:null})(),
       scrollY:Math.round(window.scrollY)
     });
   })()`,
);
