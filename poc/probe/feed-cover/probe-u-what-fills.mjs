/**
 * feed-cover 探针 U：**在身份未分离的环境里，验证"补上来的是什么"**。
 *
 * ## 已确认的事实（probe-t）
 * - Pluma 扩展**未注入本页**（`__PLUMA_HANDSHAKE__` 不存在、`page/snapshot` 桥超时）
 * - 浏览器登录 A（mid={{主账号mid}}），`rcmd` 的 `data.mid` 也是 A
 * - `feed-card` 与 `bili-feed-card` 的 BV 样本**部分相同**
 *
 * ## 所以必须重新审视 A.3b 的结论
 * 之前说"补上来的是 B 的卡"是**错误的**——本机根本没配置取流账号 B，
 * 补上来的 `bili-feed-card` 是 **A 的 rcmd 数据**。
 *
 * ## 本探针要建立的正确判据
 * 在没有双账号的情况下，**能证明什么、不能证明什么**：
 *   ✅ 能证明：**结构上**，隐藏 `.feed-card` 后 `bili-feed-card` 顶到 255（补位机制成立）
 *   ❌ 不能证明：`bili-feed-card` 是**另一个账号**的数据（需 M1：DNR 实际换 Cookie）
 *
 * 另外补一条可查的旁证：`feed-card` 与 `bili-feed-card` 的 BV **是否重叠**
 * —— 若重叠，说明两者是同一身份的不同批次；若不重叠，说明它们是不同来源。
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
  console.error('用法: node probe-u-what-fills.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 500));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2800));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'U-1 feed-card（SSR批）与 bili-feed-card（rcmd批）的 BV 关系',
  `(()=>{
     const bvOf=(root)=>[...root.querySelectorAll('a[href*="/video/BV"]')]
       .map(a=>(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]).filter(Boolean);
     const fc=[...document.querySelectorAll('.feed-card')];
     const bfc=[...document.querySelectorAll('.bili-feed-card')];
     const fcBv=[...new Set(fc.flatMap(bvOf))];
     const bfcBv=[...new Set(bfc.flatMap(bvOf))];
     const inter=fcBv.filter(b=>bfcBv.includes(b));
     return JSON.stringify({
       feedCardCount:fc.length, feedCardBvUnique:fcBv.length,
       biliFeedCardCount:bfc.length, biliFeedCardBvUnique:bfcBv.length,
       overlap:inter.length,
       overlapSample:inter.slice(0,3),
       feedFirst5:fcBv.slice(0,5),
       biliFirst5:bfcBv.slice(0,5)
     });
   })()`,
);

step(
  'U-2 rcmd 响应当前返回的 BV 是否出现在 DOM 的 bili-feed-card 里',
  `(async()=>{
     const j=await fetch('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=12&fresh_idx=1&fresh_type=4&y_num=3&brush=1',{credentials:'include'}).then(r=>r.json());
     const apiBv=((j.data&&j.data.item)||[]).map(x=>x.bvid).filter(Boolean);
     const bfcBv=[...new Set([...document.querySelectorAll('.bili-feed-card')]
       .flatMap(e=>[...e.querySelectorAll('a[href*="/video/BV"]')])
       .map(a=>(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]).filter(Boolean))];
     const hit=apiBv.filter(b=>bfcBv.includes(b));
     return JSON.stringify({
       apiItemCount:apiBv.length,
       apiDataMid:j.data&&j.data.mid,
       hitInDom:hit.length,
       note:'hit>0 说明 DOM 里的 bili-feed-card 确实来自这个 rcmd 接口'
     });
   })()`,
);

step(
  'U-3 扩展注入探针的完整清单（判 Pluma 是否生效）',
  `(()=>{
     const probes={
       handshake: typeof window.__PLUMA_HANDSHAKE__!=='undefined',
       pgc: typeof window.__PLUMA_PGC__!=='undefined',
       playinfoPresent: typeof window.__playinfo__!=='undefined',
       plumaGlobals: Object.keys(window).filter(k=>/PLUMA|pluma/i.test(k))
     };
     return JSON.stringify(probes);
   })()`,
);
