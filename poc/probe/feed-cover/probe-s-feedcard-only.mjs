/**
 * feed-cover 探针 S：**变体实验** —— 只隐藏 `.feed-card`（10 张），不碰轮播内的卡。
 *
 * ## 为什么要重做
 * 之前的"154px 空洞"实验用 `.bili-video-card` 选择器隐藏前 10 张，
 * 而 `recommended-swipe`（顶部轮播）**内部也嵌了 `.bili-video-card`**，
 * 于是轮播里那几张也被藏了 → 轮播高度从 433 塌到 134（少 299px）。
 *
 * **所以"空洞"可能是轮播误伤造成的，不是"10 张卡没补上"。**
 * 本实验严格只动 `.feed-card`（那是 A 的批次的**专属类名**），轮播一律不碰。
 *
 * ## 判据（Lead 给定，写死）
 * - 若第一张可见卡 `top` 回到 **255**（= 顶栏高）→ **"隐藏 A 让 B 补位"其实可行**
 * - 若仍是 **409** → 结论不变，路径不可行
 *
 * ## 附加验证（防"假绿"）
 * 必须同时断言：
 *   - 实际隐藏数 == 10（`feed-card` 总数）
 *   - 轮播 `recommended-swipe` 高度在隐藏前后**不变**（否则又误伤了）
 */
import { evaluate } from './../api-inventory/bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
const MODE = get('--mode') || 'display';
if (!session || !tab) {
  console.error('用法: node probe-s-feedcard-only.mjs --session <sid> --tab <tabId> [--mode display|visibility|height]');
  process.exit(2);
}

const CSSMAP = {
  display: '.__fc_hide_feedcard__{display:none!important}',
  visibility: '.__fc_hide_feedcard__{visibility:hidden!important}',
  height:
    '.__fc_hide_feedcard__{height:0!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}',
};

const step = (label, expr, show = true) => {
  const r = evaluate(session, tab, expr);
  if (show) console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  if (show) console.log('  ' + r.out.slice(0, 2400));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// 清理上一轮残留
step(
  '清理残留',
  `(()=>{
     document.querySelectorAll('.__fc_hide_feedcard__').forEach(e=>e.classList.remove('__fc_hide_feedcard__'));
     const o=document.getElementById('__fc_s__'); if(o) o.remove();
     window.scrollTo(0,0);
     return JSON.stringify({cleaned:true});
   })()`,
  false,
);

// 基线测量（隐藏前）
const before = step(
  `[${MODE}] 隐藏前基线`,
  `(()=>{
     const grid=document.querySelector('.container.is-version8');
     const feedCards=[...document.querySelectorAll('.feed-card')];
     const swipe=document.querySelector('.recommended-swipe');
     const allCards=[...document.querySelectorAll('.bili-video-card')];
     const vis=allCards.filter(e=>{const r=e.getBoundingClientRect();return r.height>0 && getComputedStyle(e).display!=='none'});
     return JSON.stringify({
       gridChildren:grid?grid.children.length:null,
       feedCardCount:feedCards.length,
       swipeHeight:swipe?Math.round(swipe.getBoundingClientRect().height):null,
       totalVideoCards:allCards.length,
       visibleCards:vis.length,
       firstVisibleTop:vis[0]?Math.round(vis[0].getBoundingClientRect().top):null,
       headerH:(()=>{const h=document.querySelector('.bili-header,header');return h?Math.round(h.getBoundingClientRect().height):null})(),
       docHeight:document.documentElement.scrollHeight
     });
   })()`,
);

// 只隐藏 .feed-card
const hid = step(
  `[${MODE}] 只隐藏 .feed-card（不碰轮播）`,
  `(()=>{
     const st=document.createElement('style'); st.id='__fc_s__';
     st.textContent=${JSON.stringify(CSSMAP[MODE])};
     document.head.appendChild(st);
     const feedCards=[...document.querySelectorAll('.feed-card')];
     feedCards.forEach(e=>e.classList.add('__fc_hide_feedcard__'));
     // 断言：命中数必须 == feed-card 总数，且不多不少
     const applied=document.querySelectorAll('.__fc_hide_feedcard__').length;
     // 断言：轮播内部没有被误挂
     const swipe=document.querySelector('.recommended-swipe');
     const swipeAffected=swipe?swipe.querySelectorAll('.__fc_hide_feedcard__').length:0;
     return JSON.stringify({
       feedCardTotal:feedCards.length,
       applied,
       assertHitEqualsTotal: applied===feedCards.length,
       swipeInternalAffected:swipeAffected,
       assertSwipeUntouched: swipeAffected===0
     });
   })()`,
);

// 隐藏后测量
const after = step(
  `[${MODE}] 隐藏后测量`,
  `(()=>{
     const swipe=document.querySelector('.recommended-swipe');
     const allCards=[...document.querySelectorAll('.bili-video-card')];
     const vis=allCards.filter(e=>{const r=e.getBoundingClientRect();return r.height>0 && getComputedStyle(e).display!=='none'});
     return JSON.stringify({
       swipeHeight:swipe?Math.round(swipe.getBoundingClientRect().height):null,
       visibleCards:vis.length,
       firstVisibleTop:vis[0]?Math.round(vis[0].getBoundingClientRect().top):null,
       docHeight:document.documentElement.scrollHeight
     });
   })()`,
);

console.log('\n=== 结论（判据：firstVisibleTop 是否回到 255）===');
if (before && after && hid) {
  const back = after.firstVisibleTop === before.headerH;
  console.log(
    JSON.stringify(
      {
        mode: MODE,
        assert_hit_equals_total: hid.assertHitEqualsTotal,
        assert_swipe_untouched: hid.assertSwipeUntouched,
        headerH: before.headerH,
        firstVisibleTop_before: before.firstVisibleTop,
        firstVisibleTop_after: after.firstVisibleTop,
        swipeHeight_before: before.swipeHeight,
        swipeHeight_after: after.swipeHeight,
        swipeHeightDelta: (after.swipeHeight ?? 0) - (before.swipeHeight ?? 0),
        docHeightDelta: after.docHeight - before.docHeight,
        verdict_went_back_to_255: back,
      },
      null,
      1,
    ),
  );
}

// 清理
evaluate(
  session,
  tab,
  `(()=>{document.querySelectorAll('.__fc_hide_feedcard__').forEach(e=>e.classList.remove('__fc_hide_feedcard__'));const o=document.getElementById('__fc_s__');if(o)o.remove();return 1})()`,
);
