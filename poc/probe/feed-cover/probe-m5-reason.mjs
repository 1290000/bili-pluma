// M5 补充：怎么读到 primaryReason（page-state.view().primary.reason）
//
// ## 已排除
//   - `page/snapshot` 的 snapshot.primary 只有 5 个字段（uname/level/loggedIn/source/placeholder）
//     → **不是 view().primary**，是 buildPageSnapshot 裁剪后的
//   - 我刚才读到的 `source: "cached"` 是**账号资料的来源**，不是 primaryReason
//
// ## 候选读取路径
//   1. 主世界的 `window.__PLUMA_PGC__` / `__PLUMA_HANDSHAKE__`（bsk evaluate 直读）
//   2. 诊断台（popup 里的"诊断"Tab，走 collectFacts）
//   3. `page/quality` 消息（页面发的，含 note）
//
// 先用 1（最简单，无需桥）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session');
const TAB = arg('tab');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const runBs = (args) =>
  execFileSync('bsk', args, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
const evaluate = (expr) => {
  const out = runBs(['evaluate', '--session', SI, '--tab-id', TAB, expr]);
  const i = out.search(/[{[]/);
  try {
    return JSON.parse(out.slice(i));
  } catch {
    return { raw: out.slice(0, 500) };
  }
};

console.log('=== 1. 主世界诊断对象 ===');
const g = evaluate(`(() => JSON.stringify({
  PGC: typeof window.__PLUMA_PGC__,
  PGC_val: window.__PLUMA_PGC__ ? Object.keys(window.__PLUMA_PGC__) : null,
  HANDSHAKE: typeof window.__PLUMA_HANDSHAKE__,
  plumaKeys: Object.keys(window).filter(k => /pluma/i.test(k)),
}))()`);
console.log(JSON.stringify(g, null, 1));

console.log('\n=== 2. __PLUMA_PGC__ 全量 ===');
const pgc = evaluate(`(() => window.__PLUMA_PGC__ ? JSON.stringify(window.__PLUMA_PGC__) : 'undefined')()`);
console.log(JSON.stringify(pgc).slice(0, 1500));

console.log('\n=== 3. __playinfo__ 存在性（判 client-written 的间接证据）===');
const pi = evaluate(`(() => {
  const v = window.__playinfo__;
  return JSON.stringify({
    exists: typeof v !== 'undefined',
    type: typeof v,
    isNull: v === null,
    hasDash: !!(v && v.data && v.data.dash),
    dashDuration: v && v.data && v.data.dash ? v.data.dash.duration : null,
  });
})()`);
console.log(JSON.stringify(pi, null, 1));

console.log('\n=== 4. 诊断台（如果有 popup 桥）===');
// 试试 page/snapshot 里有没有别的字段承载 reason
const BRIDGE = `(async () => {
  const r = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
        clearTimeout(t); window.removeEventListener('message', h);
        resolve({ ok: true, snapshot: e.data.snapshot });
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
  });
  return JSON.stringify(r);
})()`;
const b = evaluate(BRIDGE);
if (b.ok) {
  console.log('snapshot.view 全量:');
  console.log(JSON.stringify(b.snapshot?.view, null, 1));
  console.log('snapshot 顶层字段:', Object.keys(b.snapshot || {}).join(', '));
}

fs.writeFileSync('D:/Temp/m5b.json', JSON.stringify({ g, pgc, pi, snapshot: b.snapshot }, null, 2), 'utf8');
