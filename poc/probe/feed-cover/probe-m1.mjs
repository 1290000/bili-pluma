// M1 实测：换 Cookie 后点「换一换」，推荐流是否真的换成目标账号的
//
// ## 判据设计（Lead 要求的对照组）
//
// ⚠️ 关键：**推荐本身随机**，"变了没有"不能作为证据。
// 必须与"不代理时连续两次换一换的自然差异"对照。
//
// 所以本实验采样三组：
//   G1  换一换 → 记录 BV 集合 A1
//   G2  再换一次  → 记录 BV 集合 A2
//   G3  再换一次  → 记录 BV 集合 A3
//   计算 A1/A2、A2/A3 的自然重合度（基线）
//
// 然后看 rcmd 请求的 `nav` 侧身份是否真的是取流账号 ——
// **这一条是更有力的证据**：直接看 rcmd 响应若带 mid 字段则最佳，
// rcmd 响应没有 mid，但 `/x/web-interface/nav` 有。
//
// 所以本实验同时采集：
//   ① 每次换一换后的 BV 序列（判"推荐变了"）
//   ② 每次换一换后立刻打 /nav（看 Cookie 身份）→ **判"谁在看"**
//
// ## 若 DNR 只代理 rcmd 不代理 nav
//   则 ② 会一直显示浏览器账号，但 ① 可能显示取流账号的推荐 ——
//   这正是 Lead 说的"混合态"，需要产品决策。
//
// 用法：node probe-m1.mjs --session <sid> --tab <tab> [--rounds 3]

import { execFileSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session', 'khya');
const TAB = arg('tab', '1673235541');
const ROUNDS = Number(arg('rounds', '3'));
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const evaluate = (expr) =>
  execFileSync('bsk', ['evaluate', '--session', SI, '--tab-id', TAB, expr], {
    env: ENV, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024,
  });

const json = (raw) => {
  const s = raw.indexOf('{');
  return JSON.parse(raw.slice(s));
};

// ── 步骤 1：找「换一换」按钮 ──
const FIND_REFRESH = `(() => {
  // B 站首页「换一换」是一个带 refresh 图标的按钮
  const cands = [...document.querySelectorAll('button, div, span')]
    .filter((e) => {
      const t = (e.textContent || '').trim();
      return t === '换一换' || t === '刷新' || /换一批/.test(t);
    })
    .map((e) => ({
      tag: e.tagName,
      cls: (e.className || '').toString().slice(0, 80),
      text: (e.textContent || '').trim().slice(0, 20),
      rect: (() => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    }));
  return JSON.stringify({ count: cands.length, cands: cands.slice(0, 10) });
})()`;

// ── 步骤 2：读当前 BV 序列 + 身份 ──
const SNAP = `(async () => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const cards = [...document.querySelectorAll('.bili-video-card')];
  const bvs = cards
    .map((c) => {
      const a = c.querySelector('a[href*="/video/BV"]');
      return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null;
    })
    .filter(Boolean);

  // 身份：/nav 显示的是 Cookie 身份（若 DNR 代理了 nav 则是取流账号）
  let nav = null;
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav?_t=' + Date.now(), {
      credentials: 'include', cache: 'no-store',
    });
    const j = await r.json();
    nav = { code: j.code, isLogin: j.data && j.data.isLogin, mid: j.data && j.data.mid, vip: j.data && j.data.vipStatus };
  } catch (e) { nav = { error: String(e) }; }

  return JSON.stringify({ bvs: bvs.slice(0, 30), nav: nav });
})()`;

// ── 步骤 3：点「换一换」 ──
const clickRefresh = `(async () => {
  const el = [...document.querySelectorAll('button, div, span')]
    .find((e) => { const t = (e.textContent || '').trim(); return t === '换一换' || /换一批/.test(t); });
  if (!el) return JSON.stringify({ clicked: false, reason: 'no refresh button' });
  el.click();
  await new Promise((r) => setTimeout(r, 2500));
  return JSON.stringify({ clicked: true, text: (el.textContent || '').trim() });
})()`;

function inter(a, b) {
  const B = new Set(b);
  return a.filter((x) => B.has(x));
}

function run() {
  console.log('=== 找「换一换」按钮 ===');
  const f = json(evaluate(FIND_REFRESH));
  console.log(`  找到 ${f.count} 个候选`);
  f.cands.forEach((c) => console.log(`    ${c.tag} "${c.text}" cls="${c.cls}" at (${c.rect.x},${c.rect.y})`));

  if (!f.count) {
    console.log('\n❌ 没找到「换一换」按钮，无法继续。');
    return;
  }

  console.log('\n=== 采样 ===');
  const snaps = [];
  for (let i = 0; i <= ROUNDS; i++) {
    const s = json(evaluate(SNAP));
    snaps.push(s);
    console.log(`  [${i}] BV 数=${s.bvs.length}  nav.mid=${s.nav?.mid ?? '?'}  isLogin=${s.nav?.isLogin}`);
    if (i < ROUNDS) {
      const c = json(evaluate(clickRefresh));
      console.log(`      点击换一换: ${c.clicked ? '成功' : '失败 ' + c.reason}`);
    }
  }

  console.log('\n=== 重合度分析（相邻两次的自然差异 = 基线）===');
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1].bvs;
    const b = snaps[i].bvs;
    const common = inter(a, b);
    console.log(`  [${i - 1}]→[${i}]  |a|=${a.length} |b|=${b.length} 共同=${common.length}  重合率=${b.length ? ((2 * common.length) / (a.length + b.length) * 100).toFixed(1) : 'n/a'}%`);
  }

  console.log('\n=== 身份（/nav 的 Cookie）===');
  const mids = [...new Set(snaps.map((s) => s.nav?.mid).filter(Boolean))];
  console.log(`  出现过的 mid: ${mids.join(', ')}`);
  console.log(`  若只有 1 个 mid → DNR 未代理 /nav（或未配置取流账号）`);
}

run();
