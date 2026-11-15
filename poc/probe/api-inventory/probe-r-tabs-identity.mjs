/**
 * 取证脚本 R：Q3/Q4 补 —— 各页签流能否作为"接口驱动的可换身份入口"。
 *
 * 判据：接口在 登录 vs 游客 两态下返回的数据是否相同。
 *   - 相同 → 与身份无关，**换 Cookie 无意义**（热门/排行榜都是这种）
 *   - 不同 → 随身份变，可换
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
  console.error('用法: node probe-r-tabs-identity.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const r = evaluate(
  session,
  tab,
  `(async()=>{
     const cmp=async(name,url)=>{
       const g=async(cred)=>{
         try{
           const res=await fetch(url,{credentials:cred});
           const j=await res.json();
           return {code:j.code,data:j.data};
         }catch(e){return {err:'net'}}
       };
       const a=await g('include'); const b=await g('omit');
       if(a.err||b.err) return {name,err:'net'};
       const bvs=(d)=>{
         if(!d) return [];
         const s=JSON.stringify(d);
         return [...new Set(Array.from(s.matchAll(/BV[0-9A-Za-z]{10}/g)).map(m=>m[0]))];
       };
       const av=bvs(a.data), bv=bvs(b.data);
       const setB=new Set(bv);
       const inter=av.filter(x=>setB.has(x));
       return {name,codeLogin:a.code,codeAnon:b.code,
               loginBv:av.length,anonBv:bv.length,
               overlap:inter.length,
               sameData:JSON.stringify(a.data)===JSON.stringify(b.data)};
     };
     const out=[];
     out.push(await cmp('popular','https://api.bilibili.com/x/web-interface/popular?ps=10&pn=1'));
     out.push(await cmp('ranking','https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all'));
     out.push(await cmp('rcmd-feed','https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=10'));
     out.push(await cmp('history','https://api.bilibili.com/x/web-interface/history/cursor?ps=3'));
     return JSON.stringify(out);
   })()`,
);

console.log('### R：页签流是否随身份变');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 600));
  process.exit(1);
}
for (const it of JSON.parse(r.out)) {
  console.log('  ' + JSON.stringify(it));
}
