// M1 双向实测：点「换一换」后，feed/rcmd 响应里的 data.mid 是谁
//
// ## 用户要求的口径（两个方向都要）
//
//   M1-a  取流身份 = 扩展账号 → 换来的卡必须是**取流账号**的
//   M1-b  取流身份 = 浏览器账号 → 换来的卡必须是**浏览器账号**的（不能串号）
//   M1-c  只改面板里的取流身份，其余不变，对比两个方向
//
// ## 判据（Lead 指定，避开"随机推荐不能比重合度"的坑）
//
//   直接读 `feed/rcmd` 响应的 `data.mid`：
//     == 取流账号 mid   → 那批是取流账号的
//     == 页面账号 mid   → 那批是页面账号的
//   不需要比较内容。
//
// ## 顺路两个小测（engineer-a 需要）
//   ① feed/rcmd 是 fetch 还是 XHR
//   ② 首页 Vue store（Pinia）里有没有当前推荐的 mid
//
// ## 只读原则
//   - 不点视频、不发写请求、不登录登出
//   - 不打印任何凭据（SESSDATA 等）
//   - 只读 DOM + 拦截响应 + 点「换一换」（用户明确允许）
//
// 用法：
//   node probe-m1-bidir.mjs --session <sid> --tab <tab> --phase <a|b>

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session', 'khya');
const TAB = arg('tab', '1673235541');
const PHASE = arg('phase', 'a');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const evaluate = (expr) =>
  execFileSync('bsk', ['evaluate', '--session', SI, '--tab-id', TAB, expr], {
    env: ENV, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024,
  });

const json = (raw) => JSON.parse(raw.slice(raw.indexOf('{')));

// ── 装拦截器：捕获 feed/rcmd 的 data.mid + 记录是 fetch 还是 XHR ──
const INSTALL = `(() => {
  if (window.__m1b) return JSON.stringify({ already: 1, n: window.__m1b.calls.length });
  const RCMD = '/x/web-interface/wbi/index/top/feed/rcmd';
  window.__m1b = { calls: [] };

  const push = (via, url, j) => {
    try {
      window.__m1b.calls.push({
        at: Date.now(),
        via: via,
        url: String(url).slice(0, 120),
        code: j && j.code,
        // ★ 核心判据
        dataMid: j && j.data && (j.data.mid !== undefined ? j.data.mid : null),
        dataLoginMid: j && j.data && (j.data.login_mid !== undefined ? j.data.login_mid : null),
        n: j && j.data && j.data.item ? j.data.item.length : 0,
        topLevelKeys: j && j.data ? Object.keys(j.data).slice(0, 12) : null,
      });
    } catch (e) {}
  };

  const of = window.fetch;
  window.fetch = function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
    const p = of.apply(this, a);
    if (u.indexOf(RCMD) >= 0) {
      p.then((r) => r.clone().json()).then((j) => push('fetch', u, j)).catch(() => {});
    }
    return p;
  };

  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    if (String(u).indexOf(RCMD) >= 0) {
      this.addEventListener('load', () => {
        try { push('xhr', u, JSON.parse(this.responseText)); } catch (e) {}
      });
    }
    return oo.call(this, m, u, ...rest);
  };

  return JSON.stringify({ installed: 1 });
})()`;

// ── 读面板当前状态（辅助功能树已由外部读取，这里读 DOM 线索）──
const SNAP_STATE = `(() => {
  const h = document.getElementById('pluma-panel-host');
  const r = h ? h.getBoundingClientRect() : null;
  return JSON.stringify({
    panelOpen: r ? r.width > 100 : false,
    rcmdCalls: window.__m1b ? window.__m1b.calls.length : -1,
    calls: window.__m1b ? window.__m1b.calls : [],
  });
})()`;

// ── Vue store 里有没有推荐 mid（engineer-a 的小测 2）──
const VUE_PROBE = `(() => {
  const out = { found: false };
  try {
    const st = window.__pinia && window.__pinia.state && window.__pinia.state.value;
    if (!st) { out.reason = 'no pinia state'; return JSON.stringify(out); }
    const stores = Object.keys(st);
    out.stores = stores.slice(0, 20);
    const hits = [];
    for (const k of stores) {
      let s = '';
      try { s = JSON.stringify(st[k]); } catch (e) { continue; }
      if (!s) continue;
      // 找含 mid 且含推荐/BV 的 store
      if (s.indexOf('BV') >= 0) {
        const mids = [...new Set((s.match(/"mid":\\s*(\\d+)/g) || []).map((x) => x.replace(/[^0-9]/g, '')))];
        hits.push({ store: k, len: s.length, midsInStore: mids.slice(0, 8), hasBV: true });
      }
    }
    out.storesWithBV = hits.slice(0, 8);
    out.found = hits.length > 0;
  } catch (e) { out.error = String(e); }
  return JSON.stringify(out);
})()`;

function clickRefresh() {
  try {
    const out = execFileSync(
      'bsk',
      ['click', '--session', SI, '--tab-id', TAB, '--selector', 'button.roll-btn'],
      { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024 }
    );
    return { ok: true, out: out.trim().slice(0, 150) };
  } catch (e) {
    return { ok: false, err: String(e.message || '').slice(0, 200) };
  }
}

function sleep(ms) {
  evaluate(`(async () => { await new Promise(r => setTimeout(r, ${ms})); return JSON.stringify({ok:1}); })()`);
}

function run() {
  console.log(`=== PHASE ${PHASE.toUpperCase()} ===`);

  console.log('\n[1] 安装拦截器');
  console.log('   ', evaluate(INSTALL).trim().slice(0, 100));

  console.log('\n[2] 点「换一换」触发 feed/rcmd');
  const c = clickRefresh();
  console.log('   ', c.ok ? 'click ok' : 'FAIL ' + c.err);
  sleep(5000);

  console.log('\n[3] 读取捕获结果');
  const s = json(evaluate(SNAP_STATE));
  console.log(`    捕获 ${s.calls.length} 次 rcmd 调用`);
  s.calls.forEach((x) => {
    console.log(`      via=${x.via}  code=${x.code}  data.mid=${x.dataMid}  login_mid=${x.dataLoginMid}  n=${x.n}`);
    console.log(`        data keys: ${JSON.stringify(x.topLevelKeys)}`);
  });

  console.log('\n[4] Vue store 有没有推荐 mid（engineer-a 小测 2）');
  const v = json(evaluate(VUE_PROBE));
  console.log('   ', JSON.stringify(v).slice(0, 600));

  const out = { phase: PHASE, at: new Date().toISOString(), click: c, rcmdCalls: s.calls, vue: v };
  fs.writeFileSync(`D:/Temp/m1-${PHASE}.json`, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n→ D:/Temp/m1-${PHASE}.json`);
}

run();
