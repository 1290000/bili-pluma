/**
 * feed-cover 探针 T：**确认补测时的身份状态**（决定 A.3b 结论是否成立）。
 *
 * ## 要回答
 * 补测（probe-s / s2 / s3）里，`bili-feed-card` 里的数据**到底是谁的**？
 *   - 若 `feed/rcmd` 被 DNR 换成扩流账号（B）Cookie → 结论成立
 *   - 若没有换 → `bili-feed-card` 里其实是**页面账号（A）的 rcmd** → 隐藏 A 的 SSR、显示 A 的 rcmd，方案等于没做
 *
 * ## 判据（三步，全部只读）
 * 1. **读扩展的代理状态**（`page/snapshot` 桥）→ `proxy.enabled` / 主账号 mid / 取流账号 mid
 * 2. **比对 rcmd 响应里的 `data.mid`** → 它等于谁，就说明这条请求用的是谁的身份
 * 3. **读 nav** → 浏览器当前登录身份
 *
 * ⚠️ 不打印任何凭据值，只比较 mid 是否相等。
 */
import { evaluate } from './../api-inventory/bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-t-identity-proof.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 500));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2600));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// ① 扩展代理状态（页面桥，只读）
step(
  'T-1 扩展代理状态（page/snapshot 桥）',
  `(async()=>{
     const snap=await new Promise((resolve)=>{
       const t=setTimeout(()=>resolve({timeout:true}),4000);
       const h=(e)=>{
         if(e.data && e.data.__ns==='__PLUMA__' && e.data.type==='snapshot-reply'){
           clearTimeout(t); window.removeEventListener('message',h);
           resolve(e.data.snapshot||{noSnapshot:true});
         }
       };
       window.addEventListener('message',h);
       window.postMessage({__ns:'__PLUMA__',type:'snapshot'},'*');
     });
     return JSON.stringify({
       gotSnapshot: !snap.timeout && !snap.noSnapshot,
       proxy: snap.proxy||null,
       primary: snap.primary?{mid:snap.primary.mid,uname:snap.primary.uname,vipLabel:snap.primary.vipLabel}:null,
       playbackAccount: snap.playbackAccount?{mid:snap.playbackAccount.mid,uname:snap.playbackAccount.uname,vipLabel:snap.playbackAccount.vipLabel}:null,
       page: snap.page||null,
       timeout: !!snap.timeout
     });
   })()`,
);

// ② 浏览器当前登录身份（nav）
step(
  'T-2 浏览器当前登录身份（nav）',
  `(async()=>{
     const j=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'}).then(r=>r.json());
     return JSON.stringify({isLogin:j.data&&j.data.isLogin, mid:j.data&&j.data.mid, uname:j.data&&j.data.uname, vipStatus:j.data&&j.data.vipStatus});
   })()`,
);

// ③ rcmd 响应里的 data.mid —— 这是"这条请求用了谁的身份"的直接判据
step(
  'T-3 rcmd 响应的 data.mid（= 这条请求实际使用的身份）',
  `(async()=>{
     const j=await fetch('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=12&fresh_idx=1&fresh_type=4&y_num=3&brush=1',{credentials:'include'}).then(r=>r.json());
     return JSON.stringify({
       code:j.code,
       dataMid:j.data&&j.data.mid,
       itemCount:(j.data&&j.data.item||[]).length
     });
   })()`,
);

// ④ 页面内已加载的 bili-feed-card 里的 BV → 判断它们属于哪个 rcmd 批次
step(
  'T-4 当前 DOM 中 bili-feed-card 的实际内容',
  `(()=>{
     const bfc=[...document.querySelectorAll('.bili-feed-card')];
     const bvs=bfc.map(e=>{
       const a=e.querySelector('a[href*="/video/BV"]');
       return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null;
     }).filter(Boolean);
     const fc=[...document.querySelectorAll('.feed-card')];
     const fcBv=fc.map(e=>{
       const a=e.querySelector('a[href*="/video/BV"]');
       return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null;
     }).filter(Boolean);
     return JSON.stringify({
       feedCardCount:fc.length, feedCardBvSample:fcBv.slice(0,3),
       biliFeedCardCount:bfc.length, biliFeedCardBvSample:bvs.slice(0,3)
     });
   })()`,
);
