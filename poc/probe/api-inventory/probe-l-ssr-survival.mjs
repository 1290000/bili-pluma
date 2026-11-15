/**
 * 取证脚本 L：**决定性实验** —— 首屏 10 张 SSR 卡片在 rcmd 返回后是否还在。
 *
 * ## 精确设计
 * 1. 先用 `credentials:'omit/include'` 拉 HTML，提取 **SSR 卡片的 BV 列表**（这是"假如没有 JS"时用户看到的）
 * 2. 打开真实页面，等 rcmd 全部完成
 * 3. 从 DOM 提取**终态 BV 列表**
 * 4. 求：SSR 的 BV 有多少**还在终态 DOM 里**
 *    - 若全部/大部分还在 → **追加或保留**（首屏没被换）
 *    - 若几乎都不在 → **替换**（首屏被 rcmd 覆盖）
 *
 * 这个判据不依赖时序，只依赖集合关系，反而更硬。
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
  console.error('用法: node probe-l-ssr-survival.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const r = evaluate(
  session,
  tab,
  `(async()=>{
     // ① 取 HTML 里的 SSR 卡片 BV（只认 bili-video-card__image--link 附近的）
     const h=await fetch('https://www.bilibili.com/',{credentials:'include'}).then(x=>x.text());
     const ssr=[];
     const re=/bili-video-card__image--link[^>]*href="([^"]+)"/g;
     let m;
     while((m=re.exec(h))){
       const bv=(m[1].match(/BV[0-9A-Za-z]{10}/)||[])[0];
       if(bv) ssr.push(bv);
     }

     // ② 终态 DOM 的 BV
     const dom=[...document.querySelectorAll('.bili-video-card')]
       .map(e=>{const a=e.querySelector('a[href*="/video/BV"]');return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null})
       .filter(Boolean);

     // ③ 集合关系
     const domSet=new Set(dom);
     const survived=ssr.filter(b=>domSet.has(b));

     return JSON.stringify({
       ssrCards:ssr.length,
       ssrBv:ssr.slice(0,12),
       domCards:document.querySelectorAll('.bili-video-card').length,
       domBv:dom.slice(0,12),
       survived:survived.length,
       survivedList:survived.slice(0,12),
       survivalRate: ssr.length? +(survived.length/ssr.length).toFixed(2):null
     });
   })()`,
);

console.log('### L1 SSR 卡片在终态 DOM 中的存活情况');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 600));
  process.exit(1);
}
console.log(r.out);
