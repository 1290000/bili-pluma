/**
 * 取证脚本 G：首页「首屏 SSR + 后续 rcmd」混合态 —— 会不会撞出重复 BV（只读确认 2）。
 *
 * ## 问题
 * 若只把 `feed/rcmd` 换 Cookie：
 *   - 首屏 10 条来自 SSR（当前账号 A）
 *   - 往下滚动 → rcmd（账号 B）
 *   → 会出现「首屏 A、后续 B」。用户能看出来吗？
 *
 * ## 只读判据（不靠主观）
 * 1. 模拟连续翻 3 页 rcmd（`fresh_idx` 递增 + `ps=30`），收集所有 BV
 * 2. 与**首屏 SSR 的 BV 集合**求交集 → 有交集 = 会出现重复卡片
 * 3. 同时看 rcmd 内部翻页之间是否自己重复
 *
 * ⚠️ 只发 GET（rcmd 是 GET），不产生任何写入。
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
  console.error('用法: node probe-g-mixed-feed.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2500));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'G1 首屏 SSR 的 BV 集合 vs 连续 3 页 rcmd 的 BV 集合',
  `(async()=>{
     // ① 首屏 SSR：从首页 HTML 提 BV（只取 video 链接里的，避免脚本里的无关 BV）
     const html=await fetch('https://www.bilibili.com/',{credentials:'include'}).then(r=>r.text());
     const cardRe=/bili-video-card__info--tit[^>]*title="[^"]*"[\\s\\S]{0,400}?BV[0-9A-Za-z]{10}/g;
     const ssrSet=new Set();
     let m;
     while((m=cardRe.exec(html))){ const bv=(m[0].match(/BV[0-9A-Za-z]{10}/)||[])[0]; if(bv) ssrSet.add(bv); }
     // 兜底：如果正则没命中，退回全体 BV（会报 cardMatched:false）
     const allBv=[...new Set(Array.from(html.matchAll(/BV[0-9A-Za-z]{10}/g)).map(x=>x[0]))];
     const ssr=ssrSet.size?[...ssrSet]:allBv;

     // ② rcmd 连翻 3 页
     const pages=[];
     const seenAll=[];
     for(let i=0;i<3;i++){
       const u='https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=30&fresh_idx='+i+'&fresh_idx_1h='+i;
       const j=await fetch(u,{credentials:'include'}).then(r=>r.json());
       const bvs=((j.data&&j.data.item)||[]).map(x=>x.bvid).filter(Boolean);
       pages.push({idx:i,count:bvs.length,first:bvs.slice(0,3)});
       seenAll.push(...bvs);
     }
     const rcmdSet=new Set(seenAll);
     const overlap=ssr.filter(b=>rcmdSet.has(b));

     // ③ rcmd 内部跨页重复
     const dupInRcmd=seenAll.length-rcmdSet.size;

     return JSON.stringify({
       ssrCount:ssr.length,
       cardMatched:ssrSet.size>0,
       rcmdPages:pages,
       rcmdUnique:rcmdSet.size,
       rcmdTotal:seenAll.length,
       dupWithinRcmd:dupInRcmd,
       overlapWithSsr:overlap.length,
       overlapSample:overlap.slice(0,5)
     });
   })()`,
);

step(
  'G2 rcmd 是否回显请求者 mid（确认"换成谁就是谁"）',
  `(async()=>{
     const r=await fetch('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=12',{credentials:'include'});
     const j=await r.json();
     const n=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'}).then(x=>x.json());
     return JSON.stringify({dataMid:j.data&&j.data.mid,navMid:n.data.mid,same:j.data.mid===n.data.mid});
   })()`,
);
