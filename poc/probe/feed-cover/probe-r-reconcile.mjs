/**
 * feed-cover 探针 R：**复核"隐藏后滚动是否触发"** —— 排除两种测法的差异。
 *
 * ## 背景：与并行成员的数据冲突
 * `hide-scroll-result.json` 里 `A-display-none` 记录 `newRcmdRequests: 0`（不触发），
 * 而 `probe-q2b-exact-hide.mjs` 记录 `rcmdDelta: 1`（触发）。
 *
 * ## 差异可能来自
 * a. 对方用 `.bili-video-card.is-rcmd:nth-of-type(-n+10)` —— 这个选择器按**同类型序号**算，
 *    实际命中数 ≠ 10（实测 `visible: 11`，说明隐藏了远超 10 张）
 * b. 对方在**已滚动过**的页面上测（`before.total: 75`），而我在干净页面（`total: 39`）
 *
 * ## 本探针
 * 在**干净 reload** 后，分别用两种选择器隐藏，测量：
 *   - 实际命中数（`matched`）
 *   - 隐藏后可见卡数
 *   - 滚到底后 rcmd 增量
 * 一次跑完两种，做同条件对照。
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
  console.error('用法: node probe-r-reconcile.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr, show = true) => {
  const r = evaluate(session, tab, expr);
  if (show) console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  if (show) console.log('  ' + r.out.slice(0, 2200));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// 测 A：对方的 nth-of-type 选择器
step(
  'R-A 用对方的 nth-of-type 选择器（判实际命中数）',
  `(()=>{
     const old=document.getElementById('__fc_r__'); if(old) old.remove();
     document.querySelectorAll('.__fc_m__').forEach(e=>e.classList.remove('__fc_m__'));
     const st=document.createElement('style'); st.id='__fc_r__';
     st.textContent='.bili-video-card.is-rcmd:nth-of-type(-n+10){display:none!important}';
     document.head.appendChild(st);
     const all=[...document.querySelectorAll('.bili-video-card')];
     const hidden=all.filter(e=>getComputedStyle(e).display==='none');
     const visible=all.filter(e=>{const r=e.getBoundingClientRect(); return r.height>0 && getComputedStyle(e).display!=='none'});
     return JSON.stringify({
       totalCards:all.length,
       displayNoneCount:hidden.length,
       visibleCount:visible.length,
       note:'displayNoneCount 远大于 10 说明该选择器误伤'
     });
   })()`,
);

const beforeA = step(
  'R-A 滚动前 rcmd 数',
  `JSON.stringify({rcmd:performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length})`,
);

step(
  'R-A 滚到底等 5 秒',
  `(async()=>{ window.scrollTo(0,document.documentElement.scrollHeight); await new Promise(r=>setTimeout(r,5200)); return 'ok'; })()`,
  false,
);

const afterA = step(
  'R-A 滚动后',
  `JSON.stringify({
     rcmd:performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length,
     totalCards:document.querySelectorAll('.bili-video-card').length,
     scrollY:Math.round(window.scrollY),
     maxScroll:document.documentElement.scrollHeight-window.innerHeight
   })`,
);

console.log('\n=== R-A 汇总（对方选择器）===');
console.log(
  JSON.stringify({
    rcmdDelta: beforeA && afterA ? afterA.rcmd - beforeA.rcmd : null,
    before: beforeA,
    after: afterA,
  }),
);

// 清理
evaluate(
  session,
  tab,
  `(()=>{const o=document.getElementById('__fc_r__');if(o)o.remove();document.querySelectorAll('.__fc_m__').forEach(e=>e.classList.remove('__fc_m__'));window.scrollTo(0,0);return 1})()`,
);
