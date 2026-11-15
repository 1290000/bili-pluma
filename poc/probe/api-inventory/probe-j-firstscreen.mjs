/**
 * 取证脚本 J：Q1 —— 首屏 8 条的**真正数据源**（替换 vs 追加）。
 *
 * ## 难点
 * bsk 无法在 `document_start` 注入主世界脚本（没有 CDP）。
 * 但可以**用另一个思路拿到等价证据**：
 *
 *   1. **纯 SSR 判定**：用 `credentials:'omit'` 拉一次首页 HTML（不发页面 JS），
 *      数其中的 `bili-video-card` —— 这是"没有任何 JS 介入时的首屏"。
 *   2. **JS 介入后的终态**：打开真实页面，等稳定后 `document.querySelectorAll('.bili-video-card')`。
 *   3. **对比两者**：终态 ≈ SSR 数 → 是替换/保留；终态 >> SSR 数 → 有追加。
 *
 * 再用 `performance.getEntriesByType('resource')` 拿 rcmd 的**开始时刻**，
 * 与 `navigationStart` 相减 → 判断 rcmd 是否在首屏渲染之前/之后。
 *
 * ⚠️ 只读。不注入主世界、不改页面。
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
  console.error('用法: node probe-j-firstscreen.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2500));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// J1：**纯 HTML（无 JS 执行）** 里的卡片数 —— 这就是 SSR 基线
step(
  'J1 纯 HTML 中的卡片数（不发页面 JS，等同 SSR 基线）',
  `(async()=>{
     const g=async(cred)=>{
       const r=await fetch('https://www.bilibili.com/',{credentials:cred});
       const h=await r.text();
       // 卡片标题节点出现次数 = 真实卡片数（不是脚本里的变量名）
       const cards=(h.match(/bili-video-card__info--tit/g)||[]).length;
       // 卡片链接数
       const links=(h.match(/bili-video-card__image--link/g)||[]).length;
       // 内联脚本里 recommend 的 item 数：数 bvid: 出现次数（压缩源码里是对象字面量）
       const inlineBvids=(h.match(/bvid:[a-zA-Z$]{1,3}[,}]/g)||[]).length;
       // 是否含 mid 回显
       const midMatch=h.match(/mid:(\\d{5,12})/g)||[];
       return {len:h.length,cards,links,inlineBvids,midEcho:midMatch.slice(0,3)};
     };
     return JSON.stringify({login:await g('include'),anon:await g('omit')});
   })()`,
);

// J2：真实页面终态 + rcmd 时刻
step(
  'J2 真实页面终态卡片数 + rcmd 请求时刻',
  `(()=>{
     const cards=document.querySelectorAll('.bili-video-card').length;
     const nav=performance.getEntriesByType('navigation')[0];
     const entries=performance.getEntriesByType('resource')
       .filter(e=>/feed\\/rcmd|index\\/top\\/rcmd/.test(e.name))
       .map(e=>({t:Math.round(e.startTime),dur:Math.round(e.duration),url:e.name.slice(0,90)}));
     return JSON.stringify({
       domCards:cards,
       domReadyState:document.readyState,
       navStart:nav?Math.round(nav.startTime):null,
       loadEnd:nav?Math.round(nav.loadEventEnd):null,
       rcmdRequests:entries
     });
   })()`,
);

// J3：滚动前已渲染卡片的来源判定 —— 看首屏卡片的 DOM 是否带 SSR 痕迹
step(
  'J3 首屏卡片 DOM 特征（是否 SSR 直出 vs 客户端渲染）',
  `(()=>{
     const list=[...document.querySelectorAll('.bili-video-card')].slice(0,3);
     const sample=list.map(el=>{
       const a=el.querySelector('.bili-video-card__image--link');
       return {href:a?a.getAttribute('href'):null, hasTrackId:a?/(trackid|vd_source)/.test(a.getAttribute('href')||''):false};
     });
     // 首页是否还有 __INITIAL_STATE__ / pinia
     return JSON.stringify({
       total:document.querySelectorAll('.bili-video-card').length,
       sample,
       hasInitialState:typeof window.__INITIAL_STATE__!=='undefined',
       hasPinia:typeof window.__pinia!=='undefined',
       feedRoot:document.querySelector('.feed2')?true:false
     });
   })()`,
);
