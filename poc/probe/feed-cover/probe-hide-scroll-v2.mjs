// Q2/Q3 v2：隐藏首屏卡后无限滚动是否仍工作（修正 v1 的三个缺陷）
//
// ## v1 为什么无效（如实记录）
//
// 1. **"新 rcmd 请求=0 但新增卡=18" 自相矛盾** —— 新增 18 张必然来自 rcmd。
//    根因：`performance` 的 resource buffer 有上限（默认 250 条），
//    页面加载已久、资源很多时早期条目被丢弃，长度计数不再单调 → 差值不可信。
//
// 2. **visible 计数错误** —— `:nth-of-type(-n+10)` 匹配的是"同类型元素中的前 10 个"，
//    而 `.bili-video-card` 的父容器里有很多同 tag 兄弟（骨架、广告），
//    实际命中的不是"前 10 张推荐卡"。A 组 visible 从 48 → 11 就是过度匹配的证据。
//
// 3. **各组未隔离** —— 上一组滚动已经把所有卡加载到底，下一组无新内容可加载。
//    必须每组前 reload，且等待网络空闲。
//
// ## v2 的做法
//
//   · rcmd 计数用**自己装的拦截器 + 计数器**（不依赖 performance buffer）
//   · 隐藏用 **JS 直接给精确的 N 个元素加 class**（不用 nth-of-type）
//   · 每组前 **reload + 等 load**，用"有没有新的 rcmd 调用"和"卡数变化"双判据
//   · 每组的隐藏目标明确打印出来（idx + BV），可核对
//
// 用法：node probe-hide-scroll-v2.mjs --session <sid> --tab <url>

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

// 步骤 1：装计数器（reload 之后立刻装）
const INSTALL = `(() => {
  if (window.__hv2) return JSON.stringify({ already: 1, n: window.__hv2.count });
  const RCMD = '/x/web-interface/wbi/index/top/feed/rcmd';
  window.__hv2 = { count: 0, last: [] };
  const of = window.fetch;
  window.fetch = function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
    if (u.indexOf(RCMD) >= 0) { window.__hv2.count++; window.__hv2.last.push({ t: Date.now(), u: u.slice(0, 80) }); }
    return of.apply(this, a);
  };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    if (String(u).indexOf(RCMD) >= 0) { window.__hv2.count++; window.__hv2.last.push({ t: Date.now(), u: String(u).slice(0, 80) }); }
    return oo.call(this, m, u, ...r);
  };
  return JSON.stringify({ installed: 1 });
})()`;

// 步骤 2：给定隐藏方式，精确选中前 N 张卡并观测
const makeCase = (mode, n) =>
  `(async () => {
  const MODE = ${JSON.stringify(mode)};
  const N = ${n};

  // 精确选前 N 张「有推荐内容」的卡：优先 is-rcmd 且有 BV
  const all = [...document.querySelectorAll('.bili-video-card')];
  const rcmdCards = all.filter((c) => c.classList.contains('is-rcmd'));
  const targets = rcmdCards.slice(0, N);
  const targetInfo = targets.map((c, i) => {
    const a = c.querySelector('a[href*="/video/BV"]');
    const bv = a ? (a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/) || [''])[0] : null;
    return { i: i, bv: bv };
  });

  const measure = () => {
    const cards = [...document.querySelectorAll('.bili-video-card')];
    const vh = window.innerHeight;
    const boxes = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { w: r.width, h: r.height, top: r.top, bottom: r.bottom };
    });
    const visible = boxes.filter((b) => b.w > 0 && b.h > 0).length;
    const inViewportVisible = boxes.filter((b) => b.w > 0 && b.h > 0 && b.bottom > 0 && b.top < vh).length;
    return {
      total: cards.length,
      visible: visible,
      inViewportVisible: inViewportVisible,
      bodyHeight: document.body.scrollHeight,
      rcmdCount: window.__hv2 ? window.__hv2.count : -1,
    };
  };

  const before = measure();

  // 应用隐藏（直接改元素样式，不用选择器）
  const stash = [];
  targets.forEach((el) => {
    stash.push({ el: el, css: el.getAttribute('style') });
    if (MODE === 'none') { el.style.setProperty('display', 'none', 'important'); }
    else if (MODE === 'vis') { el.style.setProperty('visibility', 'hidden', 'important'); }
    else if (MODE === 'h0') {
      el.style.setProperty('height', '0', 'important');
      el.style.setProperty('overflow', 'hidden', 'important');
      el.style.setProperty('margin', '0', 'important');
      el.style.setProperty('padding', '0', 'important');
    }
    else if (MODE === 'order') { el.style.setProperty('order', '9999', 'important'); }
  });

  await new Promise((r) => setTimeout(r, 600));
  const afterHide = measure();

  // 滚动到底，触发无限滚动
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise((r) => setTimeout(r, 3000));

  const afterScroll = measure();

  // 恢复
  stash.reverse().forEach((s) => {
    if (s.css === null) s.el.removeAttribute('style');
    else s.el.setAttribute('style', s.css);
  });
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 300));

  return JSON.stringify({
    mode: MODE, n: N,
    targetsShown: targetInfo.slice(0, 12),
    targetCount: targets.length,
    before, afterHide, afterScroll,
    newRcmd: afterScroll.rcmdCount - before.rcmdCount,
    newCards: afterScroll.total - before.total,
    verdict: (afterScroll.rcmdCount - before.rcmdCount) > 0
      ? ((afterScroll.total - before.total) > 0 ? 'OK_BOTH' : 'REQ_BUT_NO_RENDER')
      : 'SCROLL_BROKEN',
  });
})()`;

// reload 辅助：用 bsk navigate 重新加载
const NAV = () => {
  execFileSync('bsk', ['navigate', '--session', SESSION, 'https://www.bilibili.com/'], {
    env: ENV, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024,
  });
};

const MODES = [
  ['control', 'control'],
  ['display:none', 'none'],
  ['visibility:hidden', 'vis'],
  ['height:0', 'h0'],
];

function run() {
  const results = [];
  for (const [label, mode] of MODES) {
    console.log(`\n${'='.repeat(50)}\n=== ${label} ===`);
    NAV();
    // 等页面把首屏 rcmd 发完
    // （navigate 返回 reached=load，再等一会儿让 Vue 水合完成）
    evaluate('(async () => { await new Promise(r => setTimeout(r, 2500)); return JSON.stringify({ ok: 1 }); })()');

    const inst = evaluate(INSTALL);
    console.log('  拦截器:', inst.trim().slice(0, 100));

    const r = json(evaluate(makeCase(mode, 10)));
    results.push({ key: mode, label, ...r });

    console.log(`  目标卡数: ${r.targetCount}`);
    console.log('  前 12 张目标:', r.targetsShown.map((t) => t.bv || '-').join(', '));
    console.log(`  before     : total=${r.before.total} visible=${r.before.visible} inVP=${r.before.inViewportVisible} bodyH=${r.before.bodyHeight} rcmd=${r.before.rcmdCount}`);
    console.log(`  afterHide  : total=${r.afterHide.total} visible=${r.afterHide.visible} inVP=${r.afterHide.inViewportVisible} bodyH=${r.afterHide.bodyHeight} rcmd=${r.afterHide.rcmdCount}`);
    console.log(`  afterScroll: total=${r.afterScroll.total} visible=${r.afterScroll.visible} inVP=${r.afterScroll.inViewportVisible} bodyH=${r.afterScroll.bodyHeight} rcmd=${r.afterScroll.rcmdCount}`);
    console.log(`  → 新 rcmd = ${r.newRcmd}, 新增卡 = ${r.newCards}, 判定 = ${r.verdict}`);
  }
  fs.writeFileSync('D:\\Temp\\hide-scroll-v2.json', JSON.stringify(results, null, 2), 'utf8');
  console.log('\n→ D:\\Temp\\hide-scroll-v2.json');
}

run();
