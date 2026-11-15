/**
 * feed-cover 探针 Q1c：读**完整** rcmd URL 参数表（判 ps 是否存在）。
 */
import { evaluate } from './../api-inventory/bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');

const r = evaluate(
  session,
  tab,
  `(async()=>{
     const entries=await new Promise((res)=>{
       const o=[];
       const po=new PerformanceObserver((l)=>{for(const e of l.getEntries()) if(/feed\\/rcmd/.test(e.name)) o.push(e.name);});
       po.observe({type:'resource',buffered:true});
       setTimeout(()=>{po.disconnect();res(o);},400);
     });
     return JSON.stringify(entries.map((u,i)=>{
       const p=new URL(u).searchParams;
       const obj={}; p.forEach((v,k)=>{obj[k]=v});
       return {i,params:obj};
     }));
   })()`,
);

console.log('### Q1c：rcmd 完整参数');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 500));
  process.exit(1);
}
for (const it of JSON.parse(r.out)) {
  console.log(`  第${it.i}次: ` + JSON.stringify(it.params));
}
