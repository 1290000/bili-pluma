/**
 * 取证脚本 I2：把"登录 vs 游客 的差异"拆到**具体字段**，判"公开/私有/混合"。
 *
 * I1 只给了 sameSame 布尔值，太粗。这里逐接口比对**顶层字段集合**，
 * 找出哪些字段是"登录才有的"（= 个性化/私有痕迹）。
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
  console.error('用法: node probe-i2-field-diff.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const r = evaluate(
  session,
  tab,
  `(async()=>{
     const g=async(u,cred)=>{
       try{ const res=await fetch(u,{credentials:cred}); const j=await res.json();
            return {code:j.code,data:j.data}; }catch(e){return {err:'net'}}
     };
     const diff=async(name,u)=>{
       const a=await g(u,'include'); const b=await g(u,'omit');
       if(a.err||b.err) return {name,err:'net'};
       const ka=a.data&&typeof a.data==='object'?Object.keys(a.data).sort():[];
       const kb=b.data&&typeof b.data==='object'?Object.keys(b.data).sort():[];
       const onlyLogin=ka.filter(x=>!kb.includes(x));
       const onlyAnon=kb.filter(x=>!ka.includes(x));
       const common=ka.filter(x=>kb.includes(x));
       // 共有字段里，值是否相同
       const changed=common.filter(k=>JSON.stringify(a.data[k])!==JSON.stringify(b.data[k]));
       return {name,codeLogin:a.code,codeAnon:b.code,
               onlyLogin:onlyLogin.slice(0,12),onlyAnon:onlyAnon.slice(0,6),
               changedCommon:changed.slice(0,12)};
     };
     const out=[];
     out.push(await diff('video/view','https://api.bilibili.com/x/web-interface/view?bvid=BV1beNcz2ECq'));
     out.push(await diff('history/cursor','https://api.bilibili.com/x/web-interface/history/cursor?ps=5'));
     out.push(await diff('fav/folder','https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid={{主账号mid}}'));
     out.push(await diff('reply/list','https://api.bilibili.com/x/v2/reply?type=1&oid=170001&pn=1&ps=5'));
     out.push(await diff('relation/followings','https://api.bilibili.com/x/relation/followings?vmid={{主账号mid}}&pn=1&ps=5'));
     return JSON.stringify(out);
   })()`,
);

console.log('### I2 字段级差异（登录 vs 游客）');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 500));
  process.exit(1);
}
const parsed = JSON.parse(r.out);
for (const it of parsed) {
  console.log('\n---', it.name, '---');
  console.log(JSON.stringify(it, null, 1));
}
