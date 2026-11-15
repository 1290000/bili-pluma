/**
 * feed-cover 探针 Q1b：**rcmd 的返回条数由什么决定** —— `ps` 还是 `fetch_row`？
 *
 * ## 为什么必须搞清
 * Q1 实测首次返回 **12 个 item**，但 DOM 里真实卡只有 23-24 条（两次请求 × 12 = 24）。
 * 也就是说"12 条 item"里**不是每条都变成卡片**（广告/直播卡/番剧卡可能走别的组件）。
 *
 * 如果隐藏 10 张首屏卡，**能不能补满**取决于：
 *   - 首次 12 条 item 里，有几条会渲染成 `.bili-video-card`（可被 count 的那种）
 *   - 后续每次 +8 的"8"是怎么来的（12 条 item → 8 张卡？）
 *
 * 本探针：对同一组参数，分别改 `ps` 与 `fetch_row`，看 itemCount 变化。
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
  console.error('用法: node probe-q1b-itemcount.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const r = evaluate(
  session,
  tab,
  `(async()=>{
     const base='https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&y_num=3&fresh_type=4&feed_version=V8&device=win';
     const test=async(label,extra)=>{
       const u=base+extra;
       const j=await fetch(u,{credentials:'include'}).then(x=>x.json());
       const items=(j.data&&j.data.item)||[];
       // 按 goto 分类（av=视频, live=直播, bangumi=番剧 ...）
       const gos={};
       for(const it of items){ const g=it.goto||'?'; gos[g]=(gos[g]||0)+1; }
       return {label,code:j.code,itemCount:items.length,gotos:gos,hasBvid:items.filter(x=>x.bvid).length};
     };
     const out=[];
     out.push(await test('fresh_idx=1&fetch_row=4 (实测首次参数)','&fresh_idx_1h=1&fetch_row=4&fresh_idx=1&brush=1'));
     out.push(await test('fresh_idx=1&fetch_row=4&ps=30','&fresh_idx_1h=1&fetch_row=4&fresh_idx=1&brush=1&ps=30'));
     out.push(await test('fresh_idx=1&fetch_row=4&ps=10','&fresh_idx_1h=1&fetch_row=4&fresh_idx=1&brush=1&ps=10'));
     out.push(await test('fresh_idx=2&fetch_row=7 (实测第二次参数)','&fresh_idx_1h=2&fetch_row=7&fresh_idx=2&brush=2'));
     out.push(await test('只给 fresh_idx=1','&fresh_idx=1'));
     return JSON.stringify(out);
   })()`,
);

console.log('### Q1b：rcmd itemCount 与参数的关系');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 500));
  process.exit(1);
}
for (const it of JSON.parse(r.out)) {
  console.log('  ' + JSON.stringify(it));
}
