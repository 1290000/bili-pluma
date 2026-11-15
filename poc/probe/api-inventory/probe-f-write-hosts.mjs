/**
 * 取证脚本 F：写接口的**真实 host 清单**（只读确认 1）。
 *
 * ## 方法（零副作用）
 * 1. 对每个写接口发 **OPTIONS / GET 探测**，看响应头与 405 —— 但这只证明"该 URL 活着"，
 *    不能证明页面实际用哪个 host。
 * 2. 更硬的做法：**在页面上真实播放/操作时用 PerformanceObserver 记录**——
 *    但写操作会真的写数据，所以**不触发**。
 * 3. 因此本脚本用**三种只读手段交叉验证**：
 *    a. 直接对 `api.bilibili.com` 与 `api.biliapi.net` 各发一次 GET，
 *       记录 status（405 = 该 host 上这个接口存在且只收 POST）
 *    b. 从**官方前端 bundle** 里搜这些 path，看调用时用的域名/前缀
 *    c. 从已发生的 `performance` 资源条目里找（只读，反映真实流量）
 *
 * ⚠️ 不发 POST、不改任何数据。
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
  console.error('用法: node probe-f-write-hosts.mjs --session <sid> --tab <tabId>');
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

// F1：同一 path 在两个候选 host 上是否都存在（405 = 存在但只收 POST）
step(
  'F1 写接口在 api.bilibili.com vs api.biliapi.net 的存在性',
  `(async()=>{
     const paths=[
       '/x/click-interface/web/heartbeat',
       '/x/web-interface/archive/like',
       '/x/web-interface/coin/add',
       '/x/v3/fav/resource/deal',
       '/x/v2/reply/add',
       '/x/relation/modify'
     ];
     const hosts=['api.bilibili.com','api.biliapi.net'];
     const out={};
     for(const p of paths){
       out[p]={};
       for(const h of hosts){
         try{
           const r=await fetch('https://'+h+p,{credentials:'include'});
           out[p][h]={status:r.status};
         }catch(e){ out[p][h]={err:'net'} }
       }
     }
     return JSON.stringify(out);
   })()`,
);

// F2：官方前端 bundle 里这些 path 的调用前缀（判是否写死 api.bilibili.com）
step(
  'F2 官方 bundle 里写接口 path 的出现情况',
  `(async()=>{
     const kws=['click-interface/web/heartbeat','web-interface/archive/like','web-interface/coin/add','v3/fav/resource/deal','v2/reply/add','relation/modify'];
     const urls=[...document.querySelectorAll('script[src]')].map(s=>s.src);
     const found={};
     for(const u of urls.slice(0,30)){
       let t='';
       try{ const r=await fetch(u); if(!r.ok) continue; t=await r.text(); }catch(e){ continue }
       for(const k of kws){
         const i=t.indexOf(k);
         if(i<0) continue;
         if(!found[k]) found[k]=[];
         if(found[k].length<2) found[k].push({file:u.split('/').pop().slice(0,28),ctx:t.slice(Math.max(0,i-120),i+80)});
       }
     }
     return JSON.stringify({scanned:urls.slice(0,30).length,found});
   })()`,
);

// F3：已发生的请求里有没有 biliapi.net（反映真实双发行为）
step(
  'F3 历史资源条目里出现过的 bilibili API host',
  `(()=>{
     const hosts={};
     for(const e of performance.getEntriesByType('resource')){
       try{ const h=new URL(e.name).hostname; if(/bilibili/.test(h)) hosts[h]=(hosts[h]||0)+1 }catch(e){}
     }
     return JSON.stringify({hosts});
   })()`,
);
