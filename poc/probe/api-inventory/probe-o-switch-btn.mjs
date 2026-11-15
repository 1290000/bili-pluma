/**
 * 取证脚本 O：Q4 核心 —— "换一换"按钮是否**完全由接口驱动**（全量替换首页推荐）。
 *
 * ## 判据
 * 1. 记录点击前 DOM 的所有 BV
 * 2. 找到"换一换"按钮并点击（**这是用户主动行为，不是写操作，无副作用**）
 * 3. 记录点击后的 BV 集合
 * 4. 观察：
 *    - 是否新增了 rcmd 请求
 *    - 首屏位置的卡片是否**整体换掉**（= 换一换能覆盖首屏）
 *
 * 若换一换后首屏整批换新，且它走的是 rcmd 接口 → 那么"换 Cookie 后点一次换一换"
 * 就能把整页变成目标账号的推荐，**不需要整页换身份**。
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
  console.error('用法: node probe-o-switch-btn.mjs --session <sid> --tab <tabId>');
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

// O1：定位"换一换"按钮
step(
  'O1 定位"换一换"按钮',
  `(()=>{
     const all=[...document.querySelectorAll('button,a,div,span')];
     const hits=all.filter(e=>{
       const t=(e.textContent||'').trim();
       return t==='换一换'||t==='刷新内容'||t==='换一批';
     }).map(e=>({tag:e.tagName,cls:(e.className||'').toString().slice(0,60),text:(e.textContent||'').trim().slice(0,12),visible:e.offsetParent!==null}));
     return JSON.stringify({hits:hits.slice(0,8)});
   })()`,
);

// O2：点击前的 BV 快照
step(
  'O2 点击前：卡片 BV 快照 + rcmd 请求数',
  `(()=>{
     const bvs=[...document.querySelectorAll('.bili-video-card')]
       .map(e=>{const a=e.querySelector('a[href*="/video/BV"]');return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null}).filter(Boolean);
     const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
     window.__O2={bvs,rcmd};
     return JSON.stringify({cardCount:bvs.length,first6:bvs.slice(0,6),rcmdCount:rcmd});
   })()`,
);

// O3：点击"换一换"
step(
  'O3 点击"换一换"',
  `(()=>{
     const all=[...document.querySelectorAll('button,a,div,span')];
     const btn=all.find(e=>{
       const t=(e.textContent||'').trim();
       return (t==='换一换'||t==='刷新内容') && e.offsetParent!==null;
     });
     if(!btn) return JSON.stringify({clicked:false,reason:'not-found'});
     btn.click();
     return JSON.stringify({clicked:true,tag:btn.tagName,cls:(btn.className||'').toString().slice(0,60)});
   })()`,
);

// O4：点击后对比
step(
  'O4 点击后：BV 是否整体换新 + 有无新 rcmd 请求',
  `(async()=>{
     await new Promise(r=>setTimeout(r,3000));
     const bvs=[...document.querySelectorAll('.bili-video-card')]
       .map(e=>{const a=e.querySelector('a[href*="/video/BV"]');return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null}).filter(Boolean);
     const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
     const before=(window.__O2&&window.__O2.bvs)||[];
     const after=new Set(bvs);
     const overlap=before.filter(b=>after.has(b)).length;
     return JSON.stringify({
       beforeCount:before.length, afterCount:bvs.length,
       beforeFirst6:before.slice(0,6), afterFirst6:bvs.slice(0,6),
       overlap, 
       rcmdBefore:(window.__O2&&window.__O2.rcmd)||null, rcmdAfter:rcmd,
       rcmdDelta:rcmd-((window.__O2&&window.__O2.rcmd)||0),
       fullyReplaced: before.length>0 && overlap===0
     });
   })()`,
);
