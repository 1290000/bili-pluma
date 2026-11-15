/**
 * feed-cover 探针 Q1（生死线）：**`feed/rcmd` 首次响应返回多少张？**
 *
 * ## 关键设计
 * `PerformanceObserver({type:'resource', buffered:true})` 能读到**本次文档生命周期内已发生**的
 * 资源请求 —— 所以在页面 load 后注入也能拿到"首次 rcmd"的 URL（含完整 query）。
 *
 * 然后**用同一组 query 参数重放一次**，读 `data.item.length` —— 这直接回答"首次给几张"。
 *
 * 同时记录 DOM 卡片数的时间序列（MutationObserver）。
 *
 * ⚠️ 只读：不发写请求、不点视频、不登录登出。
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
  console.error('用法: node probe-q1-first-response.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 500));
    return null;
  }
  console.log('  ' + r.out.slice(0, 3500));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'Q1-1 本次文档里已发生的 rcmd 请求（buffered PerformanceObserver）',
  `(async()=>{
     const entries=await new Promise((resolve)=>{
       const out=[];
       const po=new PerformanceObserver((list)=>{
         for(const e of list.getEntries()) if(/feed\\/rcmd/.test(e.name)) out.push({t:Math.round(e.startTime),dur:Math.round(e.duration),url:e.name});
       });
       po.observe({type:'resource',buffered:true});
       setTimeout(()=>{po.disconnect();resolve(out);},400);
     });
     return JSON.stringify({
       count:entries.length,
       entries:entries.map(e=>({t:e.t,dur:e.dur,url:e.url.slice(0,180)}))
     });
   })()`,
);

step(
  'Q1-2 当前 DOM 稳定态',
  `(()=>{
     const all=[...document.querySelectorAll('.bili-video-card')];
     return JSON.stringify({
       isRcmd:document.querySelectorAll('.bili-video-card.is-rcmd').length,
       allCards:all.length,
       withBv:all.filter(e=>e.querySelector('a[href*="/video/BV"]')).length,
       withTitle:all.filter(e=>e.querySelector('[class*="info--tit"]')).length
     });
   })()`,
);

step(
  'Q1-3 用首次 rcmd 的完整参数重放，读 item 数（口径：首次给几张）',
  `(async()=>{
     const entries=await new Promise((resolve)=>{
       const out=[];
       const po=new PerformanceObserver((list)=>{
         for(const e of list.getEntries()) if(/feed\\/rcmd/.test(e.name)) out.push(e.name);
       });
       po.observe({type:'resource',buffered:true});
       setTimeout(()=>{po.disconnect();resolve(out);},300);
     });
     if(!entries.length) return JSON.stringify({ok:false,reason:'no-rcmd'});
     const results=[];
     for(const u of entries.slice(0,2)){
       const j=await fetch(u,{credentials:'include'}).then(r=>r.json());
       const items=(j.data&&j.data.item)||[];
       results.push({
         url:u.slice(0,150),
         code:j.code,
         itemCount:items.length,
         dataMid:j.data&&j.data.mid,
         hasFloor:!!(j.data&&j.data.floor_info)
       });
     }
     return JSON.stringify({ok:true,results});
   })()`,
);
