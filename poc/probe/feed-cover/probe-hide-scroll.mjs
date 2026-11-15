// Q2/Q3 决定性实验：隐藏首屏 N 张后，无限滚动还能不能补位？
//
// ## 为什么这个实验才是用户问题的核心
//
// 前几轮我一直在纠结"那 10 张卡到底来自 SSR 还是 rcmd"。
// 但用户的诉求是：**把前面的卡藏掉，后面的卡能不能补上来。**
// 这取决于两件事，**两个都能直接实测**：
//   ① 藏掉 N 张后，滚动是否仍触发新 rcmd 请求（= viewer 的 IntersectionObserver 有没有坏）
//   ② 新加载的卡是否真的填进了视觉上空出来的位置（= 用户看到的内容有没有变多）
//
// ## 三种隐藏方式分别测（用户/AI 关心的差异）
//
//   A  display:none            —— 完全脱离布局（"屏蔽广告"那种手法）
//   B  visibility:hidden       —— 保留布局，留空位
//   C  height:0;overflow:hidden—— 塌陷
//   D  对照组：不隐藏
//
// 每种都是：记录当前 DOM 卡数 → 应用样式 → 记录视觉高度 → 滚动 → 等 → 记录新增卡数
//
// ## 判据（写死，避免事后解释）
//
//   若 新 rcmd 请求数 == 0         → **无限滚动被破坏**（该隐藏方式不可用）
//   若 新 rcmd 请求数 > 0 且 新增卡数 > 0 → **补位成功**
//   若 新 rcmd 请求数 > 0 但 新增卡为 0    → 请求发了但没渲染，需查
//
// 用法：node probe-hide-scroll.mjs --session <sid> --tab <tab>

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

const json = (raw) => JSON.parse(raw.slice(raw.indexOf('{')));

const STYLE_ID = 'pluma-q0-hide-style';

// 共用的观测脚本：给定 CSS，注入 → 观测 → 滚动 → 观测
const makeExpr = (css, label) =>
  `(async () => {
  const ID = '${STYLE_ID}';
  const old = document.getElementById(ID);
  if (old) old.remove();
  if (${JSON.stringify(css)}) {
    const st = document.createElement('style');
    st.id = ID;
    st.textContent = ${JSON.stringify(css)};
    document.head.appendChild(st);
  }

  const measure = () => {
    const cards = [...document.querySelectorAll('.bili-video-card')];
    const visible = cards.filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const bodyH = document.body.scrollHeight;
    // 首屏（视口内）可见卡数
    const vh = window.innerHeight;
    const inViewport = visible.filter((c) => {
      const r = c.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh;
    }).length;
    return {
      total: cards.length,
      visible: visible.length,
      bodyHeight: bodyH,
      inViewport,
      maxScroll: document.body.scrollHeight - window.innerHeight,
    };
  };

  const before = measure();

  // 记录 rcmd 请求（用 performance 计数器，不依赖拦截器）
  const countRcmd = () => performance.getEntriesByType('resource')
    .filter((r) => r.name.indexOf('feed/rcmd') >= 0).length;
  const rcmdBefore = countRcmd();

  // 滚到底部触发无限滚动
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise((r) => setTimeout(r, 2600));
  const midRcmd = countRcmd();
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise((r) => setTimeout(r, 3000));
  const rcmdAfter = countRcmd();

  const after = measure();

  // 清理
  const s = document.getElementById(ID);
  if (s) s.remove();
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 400));

  return JSON.stringify({
    label: ${JSON.stringify(label)},
    css: ${JSON.stringify(css)},
    before,
    after,
    newRcmdRequests: rcmdAfter - rcmdBefore,
    newCards: after.total - before.total,
    visibleDelta: after.visible - before.visible,
    bodyHeightDelta: after.bodyHeight - before.bodyHeight,
  });
})()`;

const CASES = [
  { key: 'D-control', label: '对照组：不隐藏', css: '' },
  {
    key: 'A-display-none',
    label: 'A display:none —— 隐藏前 10 张 is-rcmd',
    css: '.bili-video-card.is-rcmd:nth-of-type(-n+10){display:none!important}',
  },
  {
    key: 'B-visibility-hidden',
    label: 'B visibility:hidden —— 隐藏前 10 张',
    css: '.bili-video-card.is-rcmd:nth-of-type(-n+10){visibility:hidden!important}',
  },
  {
    key: 'C-height-0',
    label: 'C height:0;overflow:hidden —— 塌陷前 10 张',
    css: '.bili-video-card.is-rcmd:nth-of-type(-n+10){height:0!important;overflow:hidden!important;margin:0!important;padding:0!important}',
  },
];

function run() {
  const results = [];
  for (const c of CASES) {
    const r = json(evaluate(makeExpr(c.css, c.label)));
    results.push({ key: c.key, ...r });
    console.log(`\n=== ${c.key} ===`);
    console.log(`  before: total=${r.before.total} visible=${r.before.visible} bodyH=${r.before.bodyHeight} inViewport=${r.before.inViewport}`);
    console.log(`  after : total=${r.after.total} visible=${r.after.visible} bodyH=${r.after.bodyHeight}`);
    console.log(`  新 rcmd 请求 = ${r.newRcmdRequests}   新增卡 = ${r.newCards}   bodyHeight 变化 = ${r.bodyHeightDelta}`);
    console.log(`  判定: ${r.newRcmdRequests > 0 && r.newCards > 0 ? '✅ 滚动正常 + 有补位' : r.newRcmdRequests === 0 ? '❌ 无限滚动被破坏' : '⚠️ 请求发了但无新增'}`);
  }
  fs.writeFileSync('poc/probe/feed-cover/hide-scroll-result.json', JSON.stringify(results, null, 2), 'utf8');
  console.log('\n→ poc/probe/feed-cover/hide-scroll-result.json');
}

run();
