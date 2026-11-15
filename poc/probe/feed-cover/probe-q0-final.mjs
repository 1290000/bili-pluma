// Q0 FINAL：首屏 10 张卡的数据来源判定（不依赖 reload 时序）
//
// ## 前面失败的原因（如实记录）
//
// v1：比"一次 fetch 的 SSR"与"一次 rcmd"→ 两者都是随机的，无意义
// v2：比"事后重新 fetch 的 HTML"与当前 DOM → 每次 fetch 都是新推荐，无意义
// v3：reload 后注入拦截器 → 首屏那次 rcmd 在注入前已发出，抓不到
//     （performance 实测：首屏 rcmd 在 1525ms 就发出了，而 bsk 注入远晚于此）
//
// ## FINAL 的正确做法：**在 DOM 层判定数据世代，而不是在接口层**
//
// 关键事实（已由 performance 实测）：
//   首屏加载发出多次 rcmd（fresh_idx_1h 递增），每次返回 12 条 → 纯追加。
//   所以 DOM 里的卡 = SSR 首屏批 + 若干次 rcmd 批，顺序是**先 SSR 后 rcmd**。
//
// 判定方法（不需要抓响应体）：
//   ① 在**当前页面**（已加载完成）记录 DOM 全部卡的 (idx, bv) 序列 —— 这是"现状基线"
//   ② 触发一次新的 rcmd（滚动），记录新增卡的 BV
//   ③ 比对：新增的 BV 是否只在末尾追加（若是 → rcmd 永远纯追加）
//   ④ **关键一步**：检查「DOM 里第一批卡」与「页面加载时发出的每个 rcmd 请求」的关系
//      —— 用 `performance.getEntriesByType('resource')` 拿到首屏所有 rcmd 的 URL，
//         逐个**用相同参数重放**。若重放结果与该次请求的 fresh_idx 对应位置一致度高，
//         说明接口对该分页是确定的；再比对 DOM 前 10 是否落在任一 rcmd 结果里。
//
// ⚠️ 重放有随机性 → 这一路的结论只能标"弱证据"。
//
// ## 但有一个**强证据**可以拿到，且它直接决定用户想法成立与否：
//
//   SSR 下发的 10 张卡**带 trackid=web_pegasus_***（页面身份走的 pegasus 通道），
//   而 rcmd 接口返回的卡**带 trackid 或 pos 字段不同**。
//   直接读 DOM 里每张卡的 <a href> 里的 trackid / 或 data-* 属性 → **能分辨来源**。
//
//   这是 FINAL 的核心判据：**从 DOM 属性直接读来源，不猜接口。**
//
// 用法：node probe-q0-final.mjs --session <sid> --tab <tab>

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SESSION = arg('session');
const TAB = arg('tab');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const evaluate = (expr) =>
  execFileSync('bsk', ['evaluate', '--session', SESSION, '--tab-id', String(TAB), expr], {
    env: ENV, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024,
  });

// 先看 DOM 里每张卡有什么可用于判定来源的属性
const INSPECT = `(() => {
  const cards = [...document.querySelectorAll('.bili-video-card')];
  const rows = cards.map((c, i) => {
    const a = c.querySelector('a[href*="/video/BV"]');
    const href = a ? a.getAttribute('href') : null;
    const trackid = href ? (href.match(/trackid=([^&]+)/) || [,''])[1] : null;
    // 所有 data-* 属性
    const dataAttrs = {};
    for (const at of c.attributes) if (at.name.indexOf('data-') === 0) dataAttrs[at.name] = at.value;
    // 卡的 class 全貌
    return {
      idx: i,
      cls: c.className,
      bv: href ? (href.match(/BV[0-9A-Za-z]{10}/) || [''])[0] : null,
      trackid: trackid,
      trackPrefix: trackid ? trackid.split('-').slice(0, 3).join('-') : null,
      dataAttrs: dataAttrs,
    };
  });
  return JSON.stringify({ count: rows.length, rows: rows.slice(0, 45) });
})()`;

// 统计 trackid 前缀分布（这是来源指纹）
const STATS = `(() => {
  const cards = [...document.querySelectorAll('.bili-video-card')];
  const buckets = {};
  const details = [];
  cards.forEach((c, i) => {
    const a = c.querySelector('a[href*="/video/BV"]');
    const href = a ? a.getAttribute('href') : null;
    const bv = href ? (href.match(/BV[0-9A-Za-z]{10}/) || [''])[0] : null;
    const tk = href ? (href.match(/trackid=([^&]+)/) || [,''])[1] : '';
    // trackid 形如 web_pegasus_0.router-web-pegasus-2479516-gfll4.1794376031909.576
    const kind = tk ? (tk.split('.')[0] || '') : '(none)';
    buckets[kind] = (buckets[kind] || 0) + 1;
    details.push({ idx: i, bv: bv, kind: kind });
  });
  return JSON.stringify({ buckets, details: details.slice(0, 45) });
})()`;

function run() {
  console.log('=== DOM 卡片来源指纹 ===');
  const s = JSON.parse(evaluate(STATS).replace(/^[^{]*/, ''));
  console.log('trackid 前缀分布:', JSON.stringify(s.buckets, null, 1));
  console.log('\n逐卡:');
  s.details.forEach((d) => console.log(`  ${String(d.idx).padStart(2)} ${(d.bv || '-').padEnd(14)} ${d.kind}`));

  console.log('\n=== 前 4 张卡的完整属性（找可用的来源标记）===');
  const ins = JSON.parse(evaluate(INSPECT).replace(/^[^{]*/, ''));
  ins.rows.slice(0, 6).forEach((r) => {
    console.log(`  idx=${r.idx} cls="${r.cls}"`);
    console.log(`     bv=${r.bv} trackid=${r.trackPrefix} data=${JSON.stringify(r.dataAttrs)}`);
  });

  fs.writeFileSync('poc/probe/feed-cover/q0-final-result.json', JSON.stringify({ s, ins }, null, 2), 'utf8');
  console.log('\n→ poc/probe/feed-cover/q0-final-result.json');
}

run();
