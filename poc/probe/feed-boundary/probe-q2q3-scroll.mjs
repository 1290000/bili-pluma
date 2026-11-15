/**
 * feed-boundary 探针：Q2 + Q3 —— rcmd 首次替换后的条数、后续滚动净增、有无乱序。
 *
 * ## 核心是"顺序"这个判据
 * 要判断分界线会不会被"挤歪"，必须知道新卡是**插到末尾**还是**插到中间**。
 * 做法：每次 rcmd 请求完成后，记录**全部卡片的 BV 序列**，
 * 然后与上一次序列做**最长公共子序列（LCS）位置比对**：
 *   - 若旧卡相对顺序完全保持、新卡只在尾部 → 追加，分界线稳定
 *   - 若旧卡之间被插入新卡 → 乱序，分界线会歪
 *
 * ⚠️ 纯只读：只滚动 + 读 DOM，不点击视频、不发写请求。
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
  console.error('用法: node probe-q2q3-scroll.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2400));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// 抓当前所有卡片的 BV 序列（保持 DOM 顺序）
const SNAP = `(()=>{
  const bvs=[...document.querySelectorAll('.bili-video-card')].map((e,i)=>{
    const a=e.querySelector('a[href*="/video/BV"]');
    return {idx:i, bv:a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null};
  });
  const real=bvs.filter(x=>x.bv).map(x=>x.bv);
  const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
  return JSON.stringify({totalCards:bvs.length,realBv:real,rcmdCount:rcmd,scrollY:Math.round(window.scrollY),docH:document.documentElement.scrollHeight});
})()`;

// 基线
const s0 = step('Q2-0 初始状态（rcmd 首轮已完成）', SNAP);

// 滚到底，触发第 2 次
step(
  'Q2-1 滚到 70%，等第 2 次 rcmd',
  `(async()=>{
     window.scrollTo(0,Math.round(document.documentElement.scrollHeight*0.7));
     await new Promise(r=>setTimeout(r,3000));
     return 'scrolled';
   })()`,
);
const s1 = step('Q2-2 第 2 次滚动后的快照', SNAP);

// 再滚到底，触发第 3 次
step(
  'Q3-1 继续滚到底，等第 3 次 rcmd',
  `(async()=>{
     window.scrollTo(0,document.documentElement.scrollHeight);
     await new Promise(r=>setTimeout(r,3500));
     return 'scrolled';
   })()`,
);
const s2 = step('Q3-2 第 3 次滚动后的快照', SNAP);

// 顺序分析：旧序列是否保持相对顺序（子序列判定）
const analyze = (prev, cur) => {
  if (!prev || !cur) return null;
  const a = prev.realBv;
  const b = cur.realBv;
  const setB = new Set(b);
  const kept = a.filter((x) => setB.has(x));
  // kept 在 b 中的位置，判断是否单调递增（= 相对顺序保持）
  const positions = kept.map((x) => b.indexOf(x));
  let monotonic = true;
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] < positions[i - 1]) {
      monotonic = false;
      break;
    }
  }
  // 新卡出现在哪里：旧卡末位之后，还是插在中间
  const lastKeptPos = positions.length ? Math.max(...positions) : -1;
  const newAfter = b.slice(lastKeptPos + 1).filter((x) => !a.includes(x)).length;
  const newBefore = positions.length ? b.slice(0, positions[0]).filter((x) => !a.includes(x)).length : 0;
  return {
    prevCount: a.length,
    curCount: b.length,
    netAdd: b.length - a.length,
    keptCount: kept.length,
    droppedCount: a.length - kept.length,
    relativeOrderKept: monotonic,
    newCardsAfterOldTail: newAfter,
    newCardsBeforeOldHead: newBefore,
    rcmdDelta: cur.rcmdCount - prev.rcmdCount,
  };
};

console.log('\n=== Q2 分析（初始 → 第 2 次滚动）===');
console.log(JSON.stringify(analyze(s0, s1), null, 1));
console.log('\n=== Q3 分析（第 2 次 → 第 3 次滚动）===');
console.log(JSON.stringify(analyze(s1, s2), null, 1));

// 打印首尾各 5 条，肉眼可核对
if (s0 && s1 && s2) {
  console.log('\n=== 序列首尾（前5 / 后5）===');
  for (const [name, s] of [
    ['初始', s0],
    ['第2次', s1],
    ['第3次', s2],
  ]) {
    const arr = s.realBv;
    console.log(
      `${name}: 卡数=${s.totalCards} 有BV=${arr.length} 前5=${JSON.stringify(arr.slice(0, 5))} 后5=${JSON.stringify(arr.slice(-5))}`,
    );
  }
}
