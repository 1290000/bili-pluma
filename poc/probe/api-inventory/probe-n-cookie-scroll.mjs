/**
 * 取证脚本 N：Q2 + Q4 —— 主文档是否由 Cookie 决定；滚动触发点。
 *
 * Q2：同一 URL 发两次（include / omit），比较 HTML 的推荐条数与 mid 回显。
 *     这是"游客态 vs 登录态"的替代实验（本机只有一个账号，已标注）。
 * Q4：滚动第 1 次 rcmd 请求发生在首屏下方多少像素；此时首屏是否被重请求。
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
  console.error('用法: node probe-n-cookie-scroll.mjs --session <sid> --tab <tabId>');
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

// N1（Q2）：主文档 HTML 是否由 Cookie 决定
step(
  'N1【Q2】同一 URL，include vs omit 的 HTML 差异',
  `(async()=>{
     const grab=async(cred)=>{
       const r=await fetch('https://www.bilibili.com/',{credentials:cred});
       const h=await r.text();
       const cards=(h.match(/bili-video-card is-rcmd/g)||[]).length;
       const titles=(h.match(/bili-video-card__info--tit/g)||[]).length;
       const midEcho=(h.match(/mid:\\d{5,12}/g)||[]);
       const bvs=[...new Set(Array.from(h.matchAll(/BV[0-9A-Za-z]{10}/g)).map(m=>m[0]))];
       return {status:r.status,len:h.length,cards,titles,midEcho:midEcho.slice(0,2),uniqBv:bvs.length};
     };
     const login=await grab('include');
     const anon=await grab('omit');
     return JSON.stringify({login,anon,
       lenDiffers:login.len!==anon.len,
       cardCountDiffers:login.cards!==anon.cards,
       midEchoOnlyInLogin: login.midEcho.length>0 && anon.midEcho.length===0});
   })()`,
);

// N2（Q4）：滚动触发的第一个 rcmd 请求位置
step(
  'N2【Q4】滚动触发点：第一次 rcmd 请求时滚动到了多少像素',
  `(async()=>{
     const before=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
     const cardH=[...document.querySelectorAll('.bili-video-card')].slice(0,10)
       .map(e=>Math.round(e.getBoundingClientRect().height));
     const avgH=cardH.length?Math.round(cardH.reduce((a,b)=>a+b,0)/cardH.length):null;
     const docH=document.documentElement.scrollHeight;
     const vh=window.innerHeight;
     const scrolledBefore=window.scrollY;
     // 滚到 60%
     window.scrollTo(0,Math.round(docH*0.6));
     await new Promise(r=>setTimeout(r,2500));
     const after=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
     return JSON.stringify({
       cardCount:document.querySelectorAll('.bili-video-card').length,
       avgCardHeight:avgH,
       docHeight:docH, viewportHeight:vh,
       scrollYBefore:scrolledBefore, scrollYAfter:window.scrollY,
       rcmdBefore:before, rcmdAfter:after,
       newRequests:after-before
     });
   })()`,
);

// N3（Q4）：是否存在用户主动触发的"换一批"入口
step(
  'N3【Q4】首页是否有"换一批/刷新推荐"类按钮',
  `(()=>{
     const texts=[...document.querySelectorAll('button,a,div[class*="refresh"],div[class*="change"]')]
       .map(e=>(e.textContent||'').trim().slice(0,20))
       .filter(t=>/换一批|换一换|刷新|下次一定|更多/.test(t));
     const uniq=[...new Set(texts)];
     return JSON.stringify({candidates:uniq.slice(0,10),count:uniq.length,
       hasRefreshClass:!!document.querySelector('[class*="refresh"]')});
   })()`,
);
