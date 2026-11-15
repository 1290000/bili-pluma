/**
 * 取证脚本 I：读取类接口的**身份敏感性**分类（Q2 第 ③ 档）。
 *
 * ## 问题
 * GET 接口换了 Cookie 之后，看到的是**谁的数据**？
 * 要区分三种：
 *   - **公开数据**：响应与身份无关（谁调都一样）→ 换 Cookie 无意义但无害
 *   - **私有数据**：响应随身份变 → 换 Cookie 就"看到另一个账号的"
 *   - **混合**：主体公开，但夹带个性化/权限字段
 *
 * ## 方法（只读）
 * 同一个 GET 接口发两次：
 *   - 一次 `credentials:'include'`（当前登录身份）
 *   - 一次 `credentials:'omit'`（游客身份）
 * 比较响应，看哪些字段变了。
 *
 * ⚠️ 全程只读，不发任何 POST。
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
  console.error('用法: node probe-i-read-identity.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2200));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'I1 读取类接口：登录态 vs 游客态 的差异（判"公开/私有"）',
  `(async()=>{
     const g=async(u,cred)=>{
       try{
         const r=await fetch(u,{credentials:cred});
         const j=await r.json();
         return {status:r.status,code:j.code,msg:j.message,data:j.data};
       }catch(e){return {err:'net'}}
     };
     const cmp=async(name,u)=>{
       const a=await g(u,'include');
       const b=await g(u,'omit');
       if(a.err||b.err) return {name,err:'net'};
       const sa=JSON.stringify(a.data),sb=JSON.stringify(b.data);
       return {name,
         codeLogin:a.code, codeAnon:b.code,
         sameSame:sa===sb,
         loginLen:sa?sa.length:0, anonLen:sb?sb.length:0
       };
     };
     const out=[];
     // ① 公开：视频信息
     out.push(await cmp('video/view','https://api.bilibili.com/x/web-interface/view?bvid=BV1beNcz2ECq'));
     // ② 私有：历史
     out.push(await cmp('history/cursor','https://api.bilibili.com/x/web-interface/history/cursor?ps=5'));
     // ③ 私有：收藏夹列表（自己的）
     out.push(await cmp('fav/folder','https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid={{主账号mid}}'));
     // ④ 混合：评论（公开的评论区）
     out.push(await cmp('reply/list','https://api.bilibili.com/x/v2/reply?type=1&oid=170001&pn=1&ps=5'));
     // ⑤ 关注列表（公开）
     out.push(await cmp('relation/followings','https://api.bilibili.com/x/relation/followings?vmid={{主账号mid}}&pn=1&ps=5'));
     // ⑥ 自己的收藏夹资源列表
     out.push(await cmp('fav/resource/list','https://api.bilibili.com/x/v3/fav/resource/list?media_id=1&pn=1&ps=5'));
     return JSON.stringify(out);
   })()`,
);
