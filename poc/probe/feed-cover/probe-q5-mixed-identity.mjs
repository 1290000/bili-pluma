/**
 * feed-cover 探针 Q5：**顶栏身份 vs 推荐流身份** —— "混合身份"的观感事实采集。
 *
 * ## 用户担心的点
 * 若首屏推荐换成取流账号的，但顶栏头像/未read数/私信仍是页面账号，
 * 用户会不会困惑？
 *
 * ## 本探针只采集**事实**（不猜测用户感受）
 *   - 顶栏有没有可见的账号标识元素
 *   - 这些元素是否在首屏可视区内（= 与推荐卡同屏）
 *   - 推荐卡与顶栏的像素距离
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
  console.error('用法: node probe-q5-mixed-identity.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const r = evaluate(
  session,
  tab,
  `(()=>{
     const rect=(sel)=>{
       const e=document.querySelector(sel);
       if(!e) return null;
       const b=e.getBoundingClientRect();
       const cs=getComputedStyle(e);
       if(cs.display==='none'||cs.visibility==='hidden') return {hidden:true};
       return {top:Math.round(b.top),bottom:Math.round(b.bottom),left:Math.round(b.left),w:Math.round(b.width),h:Math.round(b.height)};
     };
     const text=(sel)=>{
       const e=document.querySelector(sel);
       return e?(e.textContent||'').trim().slice(0,20):null;
     };
     return JSON.stringify({
       // 顶栏
       header: rect('.bili-header,header'),
       avatar: rect('.header-avatar-wrap, .bili-avatar'),
       avatarText: text('.header-avatar-wrap'),
       // 未读数 / 私信 徽标
       unreadBadges: [...document.querySelectorAll('[class*="unread"],[class*="badge"],[class*="red-point"]')]
         .slice(0,6).map(e=>({cls:(e.className||'').toString().slice(0,40),text:(e.textContent||'').trim().slice(0,8)})),
       // 首屏推荐卡位置
       firstCard: rect('.bili-video-card'),
       viewportH: window.innerHeight,
       // 顶栏是否固定在顶部
       headerPosition: (()=>{const h=document.querySelector('.bili-header,header');return h?getComputedStyle(h).position:null})(),
       scrollY: Math.round(window.scrollY)
     });
   })()`,
);

console.log('### Q5：顶栏与推荐流的同屏关系');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 500));
  process.exit(1);
}
console.log(JSON.stringify(JSON.parse(r.out), null, 1));
