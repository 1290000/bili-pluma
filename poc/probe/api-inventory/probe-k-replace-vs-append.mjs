/**
 * 取证脚本 K：Q1 的**替换 vs 追加**判定 —— 用 SPA 内跳转隔离变量。
 *
 * ## 思路
 * 若首屏 10 张卡是 SSR 直出，那么：
 *   - 页面刚 load 时（rcmd 还没回）DOM 里应该只有那 10 张
 *   - rcmd 回来后，如果**替换** → 卡数不变/变化很小，但内容全换
 *     如果**追加** → 卡数增加
 *
 * bsk 拿不到 document_start，但可以用 **SPA 内导航**：
 * 先到首页，再去一个非首页路由，再回到首页 —— 第二次回首页时**主文档不重新请求**，
 * 页面只能靠接口重建列表。对比两次的卡片数与首条 BV，就能区分。
 *
 * 另外用 `MutationObserver` 实时记录卡片数量变化序列（这是最直接的证据）。
 */
import { evaluate } from './bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-k-replace-vs-append.mjs --session <sid> --tab <tabId>');
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

// K1：用 MutationObserver 观测「从现在起」卡片数的变化轨迹
//     这不是从加载开始，而是从此刻开始 —— 但配合 reload 前注入即可覆盖关键窗口
step(
  'K1 从现在起观测卡片数变化 + 首条 BV 变化（10 秒窗口）',
  `(async()=>{
     const snap=()=>{
       const els=[...document.querySelectorAll('.bili-video-card')];
       const bvs=els.map(e=>{const a=e.querySelector('a[href*="/video/BV"]');return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null}).filter(Boolean);
       return {n:els.length,bvs};
     };
     const s0=snap();
     const log=[];
     const obs=new MutationObserver(()=>{
       const s=snap();
       const last=log[log.length-1];
       if(!last || last.n!==s.n){ log.push({t:Math.round(performance.now()),n:s.n}) }
     });
     obs.observe(document.body,{childList:true,subtree:true});
     // 主动触发一次刷新推荐（模拟用户行为）
     await new Promise(r=>setTimeout(r,800));
     const s1=snap();
     const inter0=s0.bvs.filter(b=>s1.bvs.includes(b)).length;
     await new Promise(r=>setTimeout(r,4000));
     obs.disconnect();
     const s2=snap();
     return JSON.stringify({
       start:{n:s0.n,first:s0.bvs.slice(0,3)},
       afterSmallWait:{n:s1.n,first:s1.bvs.slice(0,3),overlapWithStart:inter0},
       afterLongWait:{n:s2.n,first:s2.bvs.slice(0,3)},
       countTrail:log.slice(0,20)
     });
   })()`,
);

// K2：SPA 回访 —— 去别的路由再回首页，看首屏卡片是否还在
step(
  'K2 首页首屏卡片是否带"SSR 直出"的静态标记',
  `(()=>{
     const els=[...document.querySelectorAll('.bili-video-card')];
     // SSR 直出的卡片通常在 data-v-* 之外，且评论区/骨架标记不同
     const first3=els.slice(0,3).map(e=>{
       const a=e.querySelector('a[href*="/video/BV"]');
       return {bv:a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null,
               cls:e.className.slice(0,60),
               hasComment:!!e.querySelector('[class*="info--tit"]')};
     });
     return JSON.stringify({total:els.length,first3});
   })()`,
);
