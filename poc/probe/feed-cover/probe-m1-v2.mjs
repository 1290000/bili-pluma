// M1 v2：真实鼠标点击「换一换」，验证推荐流是否真变
//
// v1 失败原因：JS `el.click()` 点的是外层 DIV（`feed-roll-btn`），
// Vue 的监听在 `BUTTON.roll-btn` 上，且 2.5s 可能不够。
//
// v2 修正：
//   · 用 bsk 的真实鼠标点击（`bsk click`）打在 BUTTON 上
//   · 每次点击后等 5s
//   · 记录点击前后的 BV 序列 + rcmd 请求计数（自装拦截器）
//
// 用法：node probe-m1-v2.mjs --session <sid> --tab <tab> [--rounds 3]

import { execFileSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session', 'khya');
const TAB = arg('tab', '1673235541');
const ROUNDS = Number(arg('rounds', 3));
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const run_ = (args) =>
  execFileSync('bsk', args, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });

const evaluate = (expr) => run_(['evaluate', '--session', SI, '--tab-id', TAB, expr]);

const json = (raw) => {
  const s = raw.indexOf('{');
  return JSON.parse(raw.slice(s));
};

// 装拦截器 + 快照
const INSTALL = `(() => {
  if (window.__m1) return JSON.stringify({ already: 1 });
  const RCMD = '/x/web-interface/wbi/index/top/feed/rcmd';
  window.__m1 = { rcmd: 0 };
  const of = window.fetch;
  window.fetch = function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
    if (u.indexOf(RCMD) >= 0) window.__m1.rcmd++;
    return of.apply(this, a);
  };
  return JSON.stringify({ installed: 1 });
})()`;

const SNAP = `(() => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const cards = [...document.querySelectorAll('.bili-video-card')];
  const bvs = cards.map((c) => {
    const a = c.querySelector('a[href*="/video/BV"]');
    return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null;
  }).filter(Boolean);
  return JSON.stringify({ bvs: bvs, rcmd: window.__m1 ? window.__m1.rcmd : -1 });
})()`;

function inter(a, b) {
  const B = new Set(b);
  return a.filter((x) => B.has(x));
}

function clickRefresh() {
  // bsk click 用 CSS 选择器（不是坐标）
  try {
    const out = run_(['click', '--session', SI, '--tab-id', TAB, '--selector', 'button.roll-btn', '--json']);
    return { ok: true, out: out.trim().slice(0, 200) };
  } catch (e) {
    return { ok: false, reason: 'bsk click failed: ' + (e.message || '').slice(0, 200) };
  }
}

function sleep(ms) {
  // bsk 没有 sleep，用 evaluate 里的延迟
  evaluate(`(async () => { await new Promise(r => setTimeout(r, ${ms})); return JSON.stringify({ok:1}); })()`);
}

function run() {
  console.log('=== 安装拦截器 ===');
  console.log('  ' + evaluate(INSTALL).trim().slice(0, 80));

  const snaps = [];
  for (let i = 0; i <= ROUNDS; i++) {
    const s = json(evaluate(SNAP));
    snaps.push(s);
    console.log(`\n[${i}] BV=${s.bvs.length}  rcmd请求=${s.rcmd}`);
    console.log(`     前5: ${s.bvs.slice(0, 5).join(', ')}`);

    if (i < ROUNDS) {
      const c = clickRefresh();
      console.log(`     点击: ${c.ok ? 'ok @' + c.at : 'FAIL ' + c.reason}`);
      sleep(5000);
    }
  }

  console.log('\n=== 重合度 ===');
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1].bvs, b = snaps[i].bvs;
    const common = inter(a, b);
    const rate = b.length ? ((2 * common.length) / (a.length + b.length) * 100).toFixed(1) : 'n/a';
    console.log(`  [${i - 1}]→[${i}]  |a|=${a.length} |b|=${b.length} 共同=${common.length} 重合率=${rate}%  Δrcmd=${snaps[i].rcmd - snaps[i - 1].rcmd}`);
  }

  console.log('\n=== 原始序列 ===');
  snaps.forEach((s, i) => console.log(`  [${i}] ${s.bvs.join(', ')}`));
}

run();
