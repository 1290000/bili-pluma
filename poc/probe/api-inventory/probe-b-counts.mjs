/**
 * 取证脚本 B：计数/写入类接口 —— **纯只读**探测。
 *
 * ⚠️ 本脚本**不发任何写请求**。只做三件事：
 *   1. `GET` 探测接口存在性（写接口对 GET 会返回方法/参数错误，不会落数据）
 *   2. 从**官方前端自己的 JS bundle** 里查 csrf 的传递位置（AGENTS.md §1.5：抓官方前端，不猜）
 *   3. 读只读接口（历史、进度）的真实返回结构
 *
 * 为什么不用"空 csrf 发 POST"试探：即使 id 无效，某些接口仍可能产生副作用，
 * 而本任务的约束是"不修改任何真实数据"。所以写路径的结论以
 * **官方前端源码 + 只读探测** 为准，拿不到就明确写"未验证"。
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
  console.error('用法: node probe-b-counts.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 1600));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// B1：写接口存在性（GET 探测，不会写数据）
step(
  'B1 写接口存在性（GET 探测，不落数据）',
  `(async()=>{
     const g=async(u)=>{const r=await fetch(u,{credentials:'include'});const j=await r.json().catch(()=>({}));return {status:r.status,code:j.code,msg:j.message}};
     return JSON.stringify({
       like: await g('https://api.bilibili.com/x/web-interface/archive/like?aid=1&like=1'),
       coin: await g('https://api.bilibili.com/x/web-interface/coin/add?aid=1&multiply=1'),
       fav: await g('https://api.bilibili.com/x/v3/fav/resource/deal?rid=1&type=2'),
       reply: await g('https://api.bilibili.com/x/v2/reply/add?oid=1&type=1'),
       relation: await g('https://api.bilibili.com/x/relation/modify?fid=1&act=2'),
       heartbeat: await g('https://api.bilibili.com/x/click-interface/web/heartbeat?aid=1&cid=1')
     });
   })()`,
);

// B2：只读接口 —— 历史与进度
step(
  'B2 只读：播放历史 /x/web-interface/history/cursor',
  `(async()=>{
     const r=await fetch('https://api.bilibili.com/x/web-interface/history/cursor?ps=3',{credentials:'include'});
     const j=await r.json();
     const list=(j.data&&j.data.list)||[];
     return JSON.stringify({status:r.status,code:j.code,listLen:list.length,itemKeys:list[0]?Object.keys(list[0]).sort():null});
   })()`,
);

step(
  'B3 只读：进度 /x/player/wbi/v2（主账号视角）',
  `(async()=>{
     const r=await fetch('https://api.bilibili.com/x/player/wbi/v2?aid=170001&cid=279786',{credentials:'include'});
     const j=await r.json();
     return JSON.stringify({status:r.status,code:j.code,hasLastPlayTime:!!(j.data&&typeof j.data.last_play_time!=='undefined'),dataKeys:j.data?Object.keys(j.data).sort():null});
   })()`,
);

// B4：官方前端 JS 里 csrf 的传递位置（关键证据来源）
step(
  'B4 官方前端 JS 里如何传 csrf（读 bundle 源码）',
  `(async()=>{
     const urls=[...document.querySelectorAll('script[src]')].map(s=>s.src).filter(u=>/bilibili/.test(u)).slice(0,8);
     const found={};
     for(const u of urls){
       try{
         const t=await fetch(u).then(r=>r.text());
         if(t.includes('bili_jct')){
           const i=t.indexOf('bili_jct');
           found[u.split('/').pop().slice(0,40)]={ctx:t.slice(Math.max(0,i-160),i+160)};
         }
       }catch(e){}
     }
     return JSON.stringify({scanned:urls.length,found});
   })()`,
);
