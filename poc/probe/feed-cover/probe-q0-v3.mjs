// Q0-v3 最终判据：用户看到的那 10 张首屏卡，数据来源是 SSR 还是 rcmd？
//
// ## 为什么 v1/v2 都无效（如实记录，避免下次重犯）
//
// v1：只比「一次 fetch 的 SSR BV」与「一次 rcmd BV」→ 两者都是随机的，|S∩R|=0
//     可以被推荐随机性解释，**不是独立性证据**。
// v2：把「事后重新 fetch 的首页 HTML」当 SSR 基准 → **那是一次全新的推荐**，
//     与当前页面那次加载无关。实测 SSR BVs 与 DOM BVs 完全不相交 ——
//     这个"不相交"是随机性，不是结构差异。**仍然无效。**
//
// ## v3 的正确切入：不问"两个接口重不重合"，直接问"DOM 里的卡是谁给的"
//
// 关键洞察：SSR 下发给自己那 10 张卡的数据**必然在文档 HTML 里**（页面就是这样渲染的）。
// 所以：
//   ① 在页面**加载前**挂 fetch/XHR 拦截器，捕获本次加载的**全部** feed/rcmd 响应（含首次）；
//   ② 加载完成后，读 DOM 里每张卡的 BV；
//   ③ 判定每张卡：
//        在 rcmd 响应里      → 数据来自 rcmd（= 取流账号身份）
//        不在 rcmd 响应里    → 数据来自 SSR（= 页面/浏览器账号身份）
//
// 这直接回答了用户的想法成不成立：
//   - 若首屏 10 张**都不在** rcmd 响应里 → 它们确实是 SSR（页面身份），隐藏方案有前提
//   - 若首屏 10 张**都在** rcmd 响应里 → 首屏早已是 rcmd 数据，隐藏无从谈起
//   - 混合 → 按实际比例判断
//
// Q0-b 基线仍然要留：连打两次 rcmd，量出推荐的自然重合度，
// 用来解释"有多少卡是两次 rcmd 之间就自然不同的"，避免把随机性当结论。
//
// ## 红线
// 只读：拦截响应 + 读 DOM + 触发滚动。不点视频、不发写请求、不登录登出、不打印凭据。
//
// 用法：node poc/probe/feed-cover/probe-q0-v3.mjs --session <sid> --tab <tab>

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SESSION = arg('session');
const TAB = arg('tab');
if (!SESSION || !TAB) {
  console.error('用法：node probe-q0-v3.mjs --session <sid> --tab <tab>');
  process.exit(2);
}

const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const evaluate = (expr) =>
  execFileSync('bsk', ['evaluate', '--session', SESSION, '--tab-id', String(TAB), expr], {
    env: ENV,
    encoding: 'utf8',
    shell: false, // shell:true 会二次解析 ! 与 "
    maxBuffer: 64 * 1024 * 1024,
  });

const parse = (raw) => {
  const s = raw.indexOf('{');
  if (s < 0) return { raw: raw.slice(0, 2000) };
  try {
    return JSON.parse(raw.slice(s));
  } catch (e) {
    return { parseError: e.message, raw: raw.slice(0, 2000) };
  }
};

// ── 步骤 1：安装拦截器（在 reload 之前，用 sessionStorage 标记"已安装"是无效的，
//             因为 reload 会清 JS 上下文 —— 所以要靠 bsk 在 reload 后立刻再注入。
//             但 bsk 0.3.3 没有 document_start 能力，首次 rcmd 可能已经发出。
//
// 可行的替代：**不 reload，直接在当前页面上"重放"一次首页加载的判定** ——
// 即：读 DOM 现有卡片，同时捕获此后新增的 rcmd 响应。
// 对首屏那 10 张，它们的 BV 若**不在**任何后续 rcmd 响应里，就说明它们来自 SSR。
// 这是可行的，因为后续 rcmd 每次都是新增 8–12 条、纯追加（feed-boundary RESULT §4 已实测）。

const INSTALL = `(() => {
  if (window.__q0v3) return JSON.stringify({ already: true });
  const RCMD = '/x/web-interface/wbi/index/top/feed/rcmd';
  window.__q0v3 = { rcmd: [], scrollAt: [] };
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const p = origFetch.apply(this, args);
    if (url.indexOf(RCMD) >= 0) {
      p.then((r) => r.clone().json()).then((j) => {
        const items = (j && j.data && j.data.item) || [];
        window.__q0v3.rcmd.push({
          at: Date.now(),
          seq: window.__q0v3.rcmd.length,
          n: items.length,
          bvs: items.map((it) => it && it.bvid).filter(Boolean),
        });
      }).catch(() => {});
    }
    return p;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    if (String(u).indexOf(RCMD) >= 0) {
      this.addEventListener('load', () => {
        try {
          const j = JSON.parse(this.responseText);
          const items = (j && j.data && j.data.item) || [];
          window.__q0v3.rcmd.push({
            at: Date.now(),
            seq: window.__q0v3.rcmd.length,
            via: 'xhr',
            n: items.length,
            bvs: items.map((it) => it && it.bvid).filter(Boolean),
          });
        } catch (e) {}
      });
    }
    return origOpen.call(this, m, u, ...rest);
  };
  return JSON.stringify({ installed: true, existingRcmdCalls: window.__q0v3.rcmd.length });
})()`;

// ── 步骤 2：读 DOM 当前卡片 + 触发滚动，观察新增 rcmd
const OBSERVE = `(async () => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const snap = () => {
    const cards = [...document.querySelectorAll('.bili-video-card')];
    return cards.map((c, i) => {
      const t = c.querySelector('.bili-video-card__info--tit');
      return {
        idx: i,
        isRcmd: c.classList.contains('is-rcmd'),
        bv: ((c.innerHTML || '').match(BV_RE) || [])[0] || null,
        title: (t && (t.getAttribute('title') || t.textContent) || '').trim().slice(0, 36),
      };
    });
  };

  const beforeScroll = snap();
  const rcmdBefore = (window.__q0v3.rcmd || []).length;

  // 触发一次滚动加载（真实行为，不伪造请求）
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise((r) => setTimeout(r, 2600));
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise((r) => setTimeout(r, 2600));

  const afterScroll = snap();
  const rcmdAll = (window.__q0v3.rcmd || []).slice();
  const rcmdAfter = rcmdAll.slice(rcmdBefore);

  // 基线：连打两次 rcmd（只读接口，与前文 Q0-b 同义）
  const fetchOnce = async () => {
    const url = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=12&fresh_type=4&fresh_idx=1&fresh_idx_1h=1&_t=' + Date.now();
    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
    const j = await r.json();
    const items = (j && j.data && j.data.item) || [];
    return { code: j && j.code, n: items.length, bvs: items.map((it) => it && it.bvid).filter(Boolean) };
  };
  const B1 = await fetchOnce();
  await new Promise((r) => setTimeout(r, 1000));
  const B2 = await fetchOnce();

  // 触发时页面已发出的 rcmd（若拦截器装得晚，这里为空）
  return JSON.stringify({
    beforeScroll: beforeScroll.slice(0, 30),
    afterScroll: afterScroll.slice(0, 30),
    domCardCountBefore: beforeScroll.length,
    domCardCountAfter: afterScroll.length,
    rcmdCapturedBefore: rcmdBefore,
    rcmdCapturedAfter: rcmdAfter,
    allCaptured: rcmdAll,
    baseline: { B1, B2 },
  });
})()`;

function run() {
  console.log('=== 步骤 1：装拦截器 ===');
  const inst = parse(evaluate(INSTALL));
  console.log(JSON.stringify(inst));

  console.log('\n=== 步骤 2：读 DOM + 滚动 + 基线 ===');
  const obs = parse(evaluate(OBSERVE));
  if (obs.parseError || obs.raw) {
    console.error('解析失败:', JSON.stringify(obs).slice(0, 1500));
    process.exit(1);
  }

  // ── 判定 ──
  const rcmdBvSet = new Set();
  for (const r of obs.allCaptured || []) for (const bv of r.bvs) rcmdBvSet.add(bv);
  for (const r of obs.rcmdCapturedAfter || []) for (const bv of r.bvs) rcmdBvSet.add(bv);
  for (const bv of obs.baseline?.B1?.bvs || []) rcmdBvSet.add(bv);
  for (const bv of obs.baseline?.B2?.bvs || []) rcmdBvSet.add(bv);

  const bvsBefore = (obs.beforeScroll || []).map((c) => c.bv).filter(Boolean);
  const first10 = bvsBefore.slice(0, 10);

  const fromRcmd = first10.filter((bv) => rcmdBvSet.has(bv));
  const fromSsr = first10.filter((bv) => !rcmdBvSet.has(bv));

  console.log('\n### 首屏前 10 张卡的来源判定');
  console.log(`  DOM 卡数（滚动前）= ${obs.domCardCountBefore}，有 BV 的 = ${bvsBefore.length}`);
  console.log(`  前 10 张 BV:`, JSON.stringify(first10));
  console.log(`  其中出现在某个 rcmd 响应里（= 取流账号数据）: ${fromRcmd.length}`);
  console.log(`  其中不在任何 rcmd 响应里（= SSR/页面身份）  : ${fromSsr.length}`);
  if (fromSsr.length) console.log(`    SSR 侧:`, fromSsr.join(', '));
  if (fromRcmd.length) console.log(`    rcmd 侧:`, fromRcmd.join(', '));

  console.log('\n### 基线：两次 rcmd 的自然重合度');
  const b1 = obs.baseline?.B1?.bvs || [];
  const b2 = obs.baseline?.B2?.bvs || [];
  const common = b1.filter((x) => b2.includes(x));
  console.log(`  |B1|=${b1.length} |B2|=${b2.length} 共同=${common.length}`);
  console.log(`  基线重合率 = ${b2.length ? ((2 * common.length) / (b1.length + b2.length) * 100).toFixed(1) : 'n/a'}%`);

  console.log('\n### 滚动新增');
  console.log(`  rcmd 捕获次数（拦截器装好后）= ${(obs.rcmdCapturedAfter || []).length}`);
  console.log(`  DOM 卡数 ${obs.domCardCountBefore} → ${obs.domCardCountAfter}`);
  for (const r of obs.rcmdCapturedAfter || []) {
    console.log(`    第 ${r.seq} 次: n=${r.n} ${r.via || 'fetch'}`);
  }

  console.log('\n### 原始列表（可核对）');
  console.log('\nDOM 滚动前（前 20）:');
  (obs.beforeScroll || []).forEach((c) => console.log(`  ${String(c.idx).padStart(2)} isRcmd=${c.isRcmd} ${c.bv || '-'} ${c.title}`));
  for (const r of obs.allCaptured || []) {
    console.log(`\nrcmd 第 ${r.seq} 次 (n=${r.n}):`);
    r.bvs.forEach((bv, i) => console.log(`  ${String(i).padStart(2)} ${bv}`));
  }
  console.log('\n基线 B1:', b1.join(', '));
  console.log('基线 B2:', b2.join(', '));

  fs.writeFileSync('poc/probe/feed-cover/q0-v3-result.json', JSON.stringify(obs, null, 2), 'utf8');
  console.log('\n原始 JSON → poc/probe/feed-cover/q0-v3-result.json');
}

run();
