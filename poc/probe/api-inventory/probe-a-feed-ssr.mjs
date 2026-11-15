/**
 * 取证脚本 A2：首页 SSR 卡片是否携带"身份"。
 *
 * 关键问题：如果首页首屏推荐是服务端按当前登录身份渲染进 HTML 的，
 * 那么"只改推荐接口的 Cookie"对**首屏**一定无效 —— 必须换整页身份。
 *
 * 判据：同一份 HTML 里能否找到与当前 mid 绑定的痕迹，以及卡片 BV 是否与
 * 接口返回的 BV 重合（重合 = 首屏数据来自同一条推荐链路，但不是接口给的，
 * 因为页面加载时接口还没返回）。
 *
 * ⚠️ 不读取任何凭据值。
 */
import { evaluate, navigate } from './bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-a-feed-ssr.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 300));
    return null;
  }
  console.log('  ' + r.out.slice(0, 1200));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// 1) 干净的首页（带一次导航，确保是首屏 HTML 而不是 SPA 后的）
console.log('--- navigate to homepage ---');
const nav = navigate(session, 'https://www.bilibili.com/');
console.log(nav.ok ? nav.out.split('\n').slice(0, 3).join(' | ') : nav.err);

// 2) 取首屏 HTML 和"接口给的第一屏"做对比
step(
  'A2-1 首页 SSR 卡片 vs 接口返回（是否同一批）',
  "(async()=>{const h=await fetch('https://www.bilibili.com/',{credentials:'include'}).then(r=>r.text());const ssr=[...new Set(Array.from(h.matchAll(/BV[0-9A-Za-z]{10}/g)).map(m=>m[0]))];const api=await fetch('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=20',{credentials:'include'}).then(r=>r.json());const apiBv=(api.data&&api.data.item||[]).map(x=>x.bvid).filter(Boolean);const overlap=apiBv.filter(b=>ssr.includes(b));return JSON.stringify({ssrBvCount:ssr.length,apiBvCount:apiBv.length,overlapCount:overlap.length,ssrFirst:ssr.slice(0,5),apiFirst:apiBv.slice(0,5)})})()",
);

// 3) SSR 里有没有 mid 回显（判"服务端按身份渲染"的直接证据）
step(
  'A2-2 SSR 是否回显当前身份 mid 或用户态',
  "(async()=>{const h=await fetch('https://www.bilibili.com/',{credentials:'include'}).then(r=>r.text());const nav=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'}).then(r=>r.json());const mid=String(nav.data.mid);const pats={midLit:h.includes(mid),isLogin:h.includes('isLogin'),vipStatus:h.includes('vipStatus'),userInfo:h.includes('userInfo'),recReasonMy:h.includes('rec_reason')};return JSON.stringify({midLen:mid.length,pats})})()",
);

// 4) 页面加载**之后** window 状态（确认首屏渲染来源）
step(
  'A2-3 页面内 store / 状态（首屏推荐是否来自 HTML）',
  "JSON.stringify({hasInitialState:typeof window.__INITIAL_STATE__!=='undefined',hasPinia:typeof window.__pinia!=='undefined',hasPlayinfo:typeof window.__playinfo__!=='undefined',cardCount:document.querySelectorAll('.bili-video-card').length})",
);
