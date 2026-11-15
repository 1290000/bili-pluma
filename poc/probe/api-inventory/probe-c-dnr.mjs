/**
 * 取证脚本 C：DNR 能否接管 —— host 归属 + 方法约束 + CSRF 一致性。
 *
 * 三个子问题：
 *   1. 各接口 host 是否落在现有 `BILI_API_HOSTS`（api.bilibili.com / api.biliapi.net）
 *   2. 首页/视频页是否存在 SSR 内嵌数据（换 Cookie 对显示无效）
 *   3. csrf 与 cookie 的一致性要求：官方前端怎么取值（已由 B4 拿到）
 *
 * ⚠️ 只读。
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
  console.error('用法: node probe-c-dnr.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 1800));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// C1：视频页 SSR —— 首屏取流数据是否写死在 HTML（决定"换 Cookie 对视频页显示是否有效"）
step(
  'C1 视频页 HTML 是否有 __playinfo__ / SSR 取流数据',
  `(async()=>{
     const h=await fetch(location.href,{credentials:'include'}).then(r=>r.text());
     return JSON.stringify({
       htmlLen:h.length,
       hasPlayinfo:h.includes('__playinfo__'),
       hasPlayurlSSR:h.includes('playurlSSRData'),
       hasInitialState:h.includes('__INITIAL_STATE__'),
       bvCount:[...new Set(Array.from(h.matchAll(/BV[0-9A-Za-z]{10}/g)).map(m=>m[0]))].length
     });
   })()`,
);

// C2：页面运行时 —— 首屏推荐/store 的实际来源
step(
  'C2 页面运行时状态',
  `JSON.stringify({
     url:location.href,
     hasInitialState:typeof window.__INITIAL_STATE__!=='undefined',
     hasPlayinfo:typeof window.__playinfo__!=='undefined',
     hasPinia:typeof window.__pinia!=='undefined',
     loginMid:(window.__INITIAL_STATE__&&window.__INITIAL_STATE__.user&&window.__INITIAL_STATE__.user.mid)||null
   })`,
);

// C3：wbi keys 是否**全局**（不随身份变化）—— 判"换 Cookie 会不会让签名失效"的关键
//     做法：从 nav 拿 key，再从**公共接口**（playurl，不需登录）拿 key，两者相同则说明 key 与身份无关
step(
  'C3 wbi keys 是全局还是按身份（对比 nav 与游客态）',
  `(async()=>{
     const ek=u=>{const f=u.slice(u.lastIndexOf('/')+1);const d=f.indexOf('.');return d===-1?f:f.slice(0,d)};
     const n=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'}).then(r=>r.json());
     const anon=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'omit'}).then(r=>r.json());
     return JSON.stringify({
       loginMid:n.data.mid, anonLogin:anon.data.isLogin,
       loginImg:ek(n.data.wbi_img.img_url).slice(0,6),
       anonImg:ek(anon.data.wbi_img.img_url).slice(0,6),
       sameKey: ek(n.data.wbi_img.img_url)===ek(anon.data.wbi_img.img_url) && ek(n.data.wbi_img.sub_url)===ek(anon.data.wbi_img.sub_url)
     });
   })()`,
);

// C4：视频页 wbi 接口对身份的回显（login_mid 字段）
step(
  'C4 /x/player/wbi/v2 的 login_mid 是否回显当前身份',
  `(async()=>{
     const r=await fetch('https://api.bilibili.com/x/player/wbi/v2?aid=170001&cid=279786',{credentials:'include'});
     const j=await r.json();
     return JSON.stringify({code:j.code,loginMid:j.data&&j.data.login_mid,isOwner:j.data&&j.data.is_owner});
   })()`,
);
