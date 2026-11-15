/**
 * 取证脚本 B4b：从官方前端 bundle 里找 csrf 的传递位置。
 *
 * 做法（AGENTS.md §1.5「抓官方前端，不要猜」）：
 *   1. 收集页面所有同源 / CDN 的 JS bundle
 *   2. 在源码里搜 `csrf` 关键字，取上下文
 *   3. 看它被拼进 URL query 还是 form body
 *
 * ⚠️ 只读。不执行、不修改任何代码。
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
  console.error('用法: node probe-b4-csrf.mjs --session <sid> --tab <tabId>');
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

// 1) 列出页面里所有脚本，看有多少可分析
step(
  'B4-1 页面脚本清单',
  `JSON.stringify({total:document.querySelectorAll('script[src]').length,urls:[...document.querySelectorAll('script[src]')].map(s=>s.src).slice(0,20)})`,
);

// 2) 在可访问的 bundle 里搜 csrf
step(
  'B4-2 bundle 内 csrf 上下文',
  `(async()=>{
     const urls=[...document.querySelectorAll('script[src]')].map(s=>s.src);
     const hits=[];
     for(const u of urls.slice(0,25)){
       try{
         const r=await fetch(u);
         if(!r.ok) continue;
         const t=await r.text();
         if(!t.includes('csrf')) continue;
         let i=t.indexOf('csrf');
         let n=0;
         while(i>=0 && n<2){
           hits.push({file:u.split('/').pop().slice(0,36),ctx:t.slice(Math.max(0,i-200),i+200)});
           i=t.indexOf('csrf',i+1); n++;
         }
       }catch(e){}
     }
     return JSON.stringify({scanned:urls.slice(0,25).length,hits:hits.slice(0,6)});
   })()`,
);

// 3) 直接找 B站前端的请求封装（检查 xhr/fetch 拦截器怎么写 csrf）
step(
  'B4-3 页面是否暴露请求封装（window 上的 axios 等）',
  `JSON.stringify({hasAxios:typeof window.axios!=='undefined',hasFetchWrapped:window.fetch.toString().indexOf('native code')===-1,cookieNames:document.cookie.split(';').map(s=>s.split('=')[0].trim())})`,
);
