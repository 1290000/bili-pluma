/**
 * 取证脚本 D：host 归属盘点 —— 哪些行为不在 `BILI_API_HOSTS` 上。
 *
 * 做法：在首页/视频页真实运行时，用 PerformanceObserver 之外的
 * `performance.getEntriesByType('resource')` 读已发生的请求（只读、无副作用），
 * 按 host 归组。这能反映"页面真实打了哪些域名"，比逐个猜接口可靠。
 *
 * ⚠️ 只读。不注入、不改请求。
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
  console.error('用法: node probe-d-hosts.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 3000));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'D1 当前页资源请求按 host 归组（API 类）',
  `(()=>{
     const byHost={};
     for(const e of performance.getEntriesByType('resource')){
       try{
         const u=new URL(e.name);
         if(!/bilibili|bilivideo|hdslb/.test(u.hostname)) continue;
         if(/\\.(m4s|mp4|js|css|png|jpg|jpeg|webp|svg|woff2?|wasm|gif)$/i.test(u.pathname)) continue;
         if(!byHost[u.hostname]) byHost[u.hostname]=[];
         const p=u.pathname;
         if(!byHost[u.hostname].includes(p)) byHost[u.hostname].push(p);
       }catch(e){}
     }
     const out={};
     for(const k of Object.keys(byHost)) out[k]=byHost[k].slice(0,12);
     return JSON.stringify({hostCount:Object.keys(out).length,hosts:out});
   })()`,
);
