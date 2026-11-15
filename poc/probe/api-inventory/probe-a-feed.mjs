/**
 * 取证脚本 A：首页推荐流 —— 身份载体与签名约束。
 *
 * 回答：
 *   A1. 首页推荐走哪些接口？HTML 是否 SSR 了首批推荐？
 *   A2. 身份载体是 Cookie 还是 query？响应里有没有回显身份的字段（`data.mid`）？
 *   A3. wbi 签名是否把 Cookie 身份算进签名（改 Cookie 会不会 412）？
 *
 * ⚠️ 只记录字段名、code、数量。**不读取、不打印任何凭据值。**
 *
 * 用法：node poc/probe/api-inventory/probe-a-feed.mjs --session <sid> --tab <tabId>
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
  console.error('用法: node probe-a-feed.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const run = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', r.err || r.out);
    return null;
  }
  console.log('  ' + r.out);
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// A1-1：两个推荐接口在**当前登录态**下的返回
run(
  'A1 两个候选推荐接口（当前登录态，无 wbi 签名）',
  "(async()=>{const t=async(u)=>{const r=await fetch(u,{credentials:'include'});const j=await r.json();const it=j.data&&j.data.item;return {status:r.status,code:j.code,itemLen:it?it.length:null,dataMid:j.data&&j.data.mid,dataKeys:j.data?Object.keys(j.data):null}};return JSON.stringify({old:await t('https://api.bilibili.com/x/web-interface/index/top/rcmd?fresh_type=3&ps=12'),wbi:await t('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=12')})})()",
);

// A1-2：首页 HTML 是否 SSR 了推荐卡片（关键：决定"换 Cookie 对首屏有没有用"）
run(
  'A1 首页 HTML 是否内嵌推荐（找 bili-video-card 真实卡片）',
  "(async()=>{const r=await fetch('https://www.bilibili.com/',{credentials:'include'});const h=await r.text();const cards=(h.match(/bili-video-card__info--tit/g)||[]).length;const bvs=[...new Set(Array.from(h.matchAll(/BV[0-9A-Za-z]{10}/g)).map(m=>m[0]))];const i=h.indexOf('bili-video-card__info--tit');const ctx=i<0?null:h.slice(Math.max(0,i-260),i+40);return JSON.stringify({htmlLen:h.length,cardCount:cards,uniqBv:bvs.length,firstCtx:ctx})})()",
);

// A2：坏签名 —— 判服务端是否真的校验 w_rid
run(
  'A2 坏 w_rid 是否被拒（判签名是否真的被校验）',
  "(async()=>{const t=async(u)=>{const r=await fetch(u,{credentials:'include'});const j=await r.json();return {status:r.status,code:j.code,msg:j.message}};return JSON.stringify({good:await t('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650'),bad:await t('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&wts=1&w_rid=00000000000000000000000000000000')})})()",
);

// A3：wbi 密钥是否随身份变化（nav 的 img/sub key）
run(
  'A3 nav 的 wbi keys（同一身份两次取，判是否稳定）',
  "(async()=>{const n=async()=>{const j=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'}).then(r=>r.json());const ek=u=>{const f=u.slice(u.lastIndexOf('/')+1);const d=f.indexOf('.');return d===-1?f:f.slice(0,d)};return {mid:j.data.mid,img:ek(j.data.wbi_img.img_url),sub:ek(j.data.wbi_img.sub_url)}};const a=await n();const b=await n();return JSON.stringify({same:JSON.stringify(a)===JSON.stringify(b),imgLen:a.img.length,subLen:a.sub.length,midStable:a.mid===b.mid})})()",
);

// A3b：playurl 的先例 —— 它已经是"换了 Cookie 还能成功"的那条
run(
  'A3b playurl 坏签名（先例：playurl 签名失效会怎样）',
  "(async()=>{const b='https://api.bilibili.com/x/player/wbi/playurl?avid=170001&cid=279786&qn=80&fnval=4048';const t=async(u)=>{const r=await fetch(u,{credentials:'include'});const j=await r.json();return {status:r.status,code:j.code,msg:j.message,hasDash:!!(j.data&&j.data.dash)}};return JSON.stringify({noSig:await t(b),badSig:await t(b+'&wts=1&w_rid=00000000000000000000000000000000')})})()",
);

// B-预热：确认页面首屏有几个推荐请求（若 SSR 生效，则首屏不该发 rcmd）
run(
  'A1c 当前页面类型与 SSR 标记',
  "JSON.stringify({url:location.href,hasInitialState:typeof window.__INITIAL_STATE__!=='undefined',hasPinia:typeof window.__pinia!=='undefined'})",
);
