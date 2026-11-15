/**
 * 取证脚本 P：**换一换的数据是否完全来自 rcmd 接口** —— Q4 的最终判定。
 *
 * 判据：抓"换一换"触发的那条 rcmd 请求的 URL/path，确认它是白名单可覆盖的那个接口，
 * 并核对它返回的 item 是否就是刷新后 DOM 首屏的内容。
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
  console.error('用法: node probe-p-switch-source.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const r = evaluate(
  session,
  tab,
  `(async()=>{
     const ents=performance.getEntriesByType('resource').filter(x=>/feed\\/rcmd/.test(x.name));
     const last=ents[ents.length-1];
     if(!last) return JSON.stringify({ok:false,reason:'no-rcmd-entry'});
     const u=last.name;
     const j=await fetch(u,{credentials:'include'}).then(x=>x.json());
     const apiBv=((j.data&&j.data.item)||[]).map(x=>x.bvid).filter(Boolean);
     const domBv=[...document.querySelectorAll('.bili-video-card')]
       .map(el=>{const a=el.querySelector('a[href*="/video/BV"]');return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null})
       .filter(Boolean);
     const domSet=new Set(domBv);
     const hit=apiBv.filter(b=>domSet.has(b));
     return JSON.stringify({
       path:new URL(u).pathname,
       rcmdReqCount:ents.length,
       apiCount:apiBv.length, domCount:domBv.length,
       apiBvInDom:hit.length,
       domFirst5:domBv.slice(0,5), apiFirst5:apiBv.slice(0,5),
       dataMid:j.data&&j.data.mid
     });
   })()`,
);

console.log('### P：换一换的数据来源');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 600));
  process.exit(1);
}
console.log(r.out);
