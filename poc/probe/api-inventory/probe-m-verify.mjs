/**
 * 取证脚本 M：**复核 L1 的 0% 存活率** —— 排除测量伪影。
 *
 * L1 得出 SSR 卡片存活率 0，这与 §2 A3 的"首屏是 SSR"结论**相反**。
 * 按 AGENTS.md §1.5，结论翻转前必须先排除测量伪影。
 *
 * 三个可能的伪影：
 *   a. 两次请求之间页面已经变了一批（首页每次推荐都不同 —— §8.3 已证实）
 *      → 所以"SSR 的 BV 不在终态里"可能只是**样本不同**，不是替换
 *   b. `.bili-video-card__image--link` 在终态里改了 class 名
 *   c. 终态 DOM 只保留了后加的 39 条，SSR 的 8 条在更早的位置但选择器没覆盖
 *
 * ## 判据设计（关键）
 * 不要跨请求比较。改为**同一次页面加载**里比较：
 *   - 用 `performance.getEntriesByType('resource')` 找 rcmd 的**响应体**不可得，
 *     改为：**记录页面加载瞬间 HTML 里 SSR 的 8 条 BV，然后在同一个页面上下文里
 *     `fetch` 同一个首页 HTML 看它是否稳定**（判伪影 a）
 *   - 检查终态 DOM 里是否还能找到 SSR 的 class 结构（判伪影 b/c）
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
  console.error('用法: node probe-m-verify.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2600));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// M1：伪影 a —— 同一 URL 连拉两次 HTML，SSR 的 8 条是否稳定
step(
  'M1 伪影 a：连拉两次首页 HTML，SSR 卡片 BV 是否稳定',
  `(async()=>{
     const grab=async()=>{
       const h=await fetch('https://www.bilibili.com/',{credentials:'include'}).then(x=>x.text());
       const out=[];const re=/bili-video-card__image--link[^>]*href="([^"]+)"/g;let m;
       while((m=re.exec(h))){const bv=(m[1].match(/BV[0-9A-Za-z]{10}/)||[])[0];if(bv)out.push(bv)}
       return out;
     };
     const a=await grab();
     await new Promise(r=>setTimeout(r,300));
     const b=await grab();
     const inter=a.filter(x=>b.includes(x));
     return JSON.stringify({aCount:a.length,bCount:b.length,overlap:inter.length,aFirst:a.slice(0,4),bFirst:b.slice(0,4)});
   })()`,
);

// M2：伪影 b/c —— 终态 DOM 里 SSR 那批 BV 到底在不在（全文档搜，不只卡片选择器）
step(
  'M2 伪影 b/c：在终态 DOM 全文里搜 SSR 的 BV',
  `(async()=>{
     const h=await fetch('https://www.bilibili.com/',{credentials:'include'}).then(x=>x.text());
     const out=[];const re=/bili-video-card__image--link[^>]*href="([^"]+)"/g;let m;
     while((m=re.exec(h))){const bv=(m[1].match(/BV[0-9A-Za-z]{10}/)||[])[0];if(bv)out.push(bv)}
     const bodyHtml=document.body.innerHTML;
     const inDom=out.filter(bv=>bodyHtml.includes(bv));
     // 终态 DOM 里所有 BV（不限卡片选择器）
     const allDom=[...new Set(Array.from(bodyHtml.matchAll(/BV[0-9A-Za-z]{10}/g)).map(x=>x[0]))];
     return JSON.stringify({
       ssrCount:out.length,
       ssrInDomAtAll:inDom.length,
       domAllBvCount:allDom.length,
       domFirst6:allDom.slice(0,6),
       ssrFirst4:out.slice(0,4)
     });
   })()`,
);

// M3：DOM 卡片的结构 —— 前几张是不是骨架（无 BV）
step(
  'M3 终态 DOM 前 12 张卡片的类名与有无 BV',
  `(()=>{
     const els=[...document.querySelectorAll('.bili-video-card')].slice(0,12);
     return JSON.stringify(els.map((e,i)=>{
       const a=e.querySelector('a[href*="/video/BV"]');
       const t=e.querySelector('[class*="info--tit"]');
       return {i,cls:e.className.slice(0,52),bv:a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null,hasTitle:!!t};
     }));
   })()`,
);
