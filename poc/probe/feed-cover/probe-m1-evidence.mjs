// M1 决定性证据：当前 rcmd 请求是否带的是「取流账号」的 Cookie
//
// 面板已显示「未生效」。但面板状态可能是过时的（用户可能刚配好）。
// 最硬的判据：比较 **rcmd 响应的内容** 与 **/nav 的身份**。
//
// 关键洞察（本轮最重要的一条）：
//   rcmd 响应里每条 item 都带 `owner.mid` —— **推荐者的 mid，不是观看者**。
//   但响应头/响应体里通常没有"谁在看"的直接字段。
//
//   所以更直接的判据是：**同一个 rcmd 请求，带不同 Cookie 会返回不同内容**。
//   而"用户实际拿到的 rcmd 用的是哪个 Cookie"只能从 DNR 规则状态判断。
//
// → 但有一件事可以直接测：**/nav 是否被代理**。
//   若 DNR 白名单里没有 /nav（查 routes.ts 可知），则 /nav 永远显示浏览器账号，
//   这不代表 rcmd 没被代理。
//
// 最终可用判据：
//   ① 读 routes.ts 的白名单（静态，已知）
//   ② 用户看到的 rcmd 内容，与"带浏览器账号 Cookie 直连 rcmd"的内容比对
//      若几乎相同 → 说明 rcmd 也用浏览器账号看的 → 代理未生效
//      若明显不同 → rcmd 用了别的 Cookie
//
// 用法：node probe-m1-evidence.mjs --session <sid> --tab <tab>

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session', 'khya');
const TAB = arg('tab', '1673235541');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const evaluate = (expr) =>
  execFileSync('bsk', ['evaluate', '--session', SI, '--tab-id', TAB, expr], {
    env: ENV, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024,
  });

const EXPR = `(async () => {
  // ① 页面上点「换一换」触发的 rcmd，其返回内容 = 用户实际看到的
  //    这里直接读当前 DOM 的 BV（就是用户看到的）
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const domBvs = [...document.querySelectorAll('.bili-video-card')]
    .map((c) => { const a = c.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null; })
    .filter(Boolean);

  // ② 直接调 rcmd（走页面，会被 DNR 规则命中 —— 这正是要测的）
  const url = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=12&fresh_type=4&fresh_idx=1&fresh_idx_1h=1&_t=' + Date.now();
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  const j = await r.json();
  const items = (j && j.data && j.data.item) || [];
  const rcmdBvs = items.map((it) => it && it.bvid).filter(Boolean);

  // ③ 同一请求，但强制不带 Cookie（credentials:'omit'）——
  //    这是"游客身份"的 rcmd，作为另一个身份对照
  const url2 = url + '&omit=1';
  const r2 = await fetch(url2, { credentials: 'omit', cache: 'no-store' });
  const j2 = await r2.json();
  const items2 = (j2 && j2.data && j2.data.item) || [];
  const omitBvs = items2.map((it) => it && it.bvid).filter(Boolean);

  // ④ 身份
  let nav = null;
  try {
    const nr = await fetch('https://api.bilibili.com/x/web-interface/nav?_t=' + Date.now(), { credentials: 'include', cache: 'no-store' });
    const nj = await nr.json();
    nav = { code: nj.code, isLogin: nj.data && nj.data.isLogin, mid: nj.data && nj.data.mid, vip: nj.data && nj.data.vipStatus };
  } catch (e) { nav = { error: String(e) }; }

  return JSON.stringify({ domBvs, rcmdBvs, omitBvs, nav, rcmdCode: j && j.code, omitCode: j2 && j2.code, omitIsLogin: j2 && j2.data && j2.data.login_mid });
})()`;

const json = (() => {
  const raw = evaluate(EXPR);
  return JSON.parse(raw.slice(raw.indexOf('{')));
})();

function inter(a, b) {
  const B = new Set(b);
  return a.filter((x) => B.has(x));
}
const rate = (a, b) => (a.length + b.length ? ((2 * inter(a, b).length) / (a.length + b.length) * 100).toFixed(1) + '%' : 'n/a');

console.log('=== 身份 ===');
console.log('  /nav:', JSON.stringify(json.nav));
console.log('  rcmd code:', json.rcmdCode, ' omit 版 code:', json.omitCode, ' omit版 login_mid:', json.omitIsLogin);

console.log('\n=== 三组 BV 序列 ===');
console.log('  DOM（用户看到的）  :', json.domBvs.length, '条');
console.log('  rcmd（带 Cookie）  :', json.rcmdBvs.length, '条');
console.log('  rcmd（无 Cookie）  :', json.omitBvs.length, '条');

console.log('\n=== 重合率 ===');
console.log('  DOM ∩ rcmd(带Cookie)  =', rate(json.domBvs, json.rcmdBvs));
console.log('  DOM ∩ rcmd(无Cookie)  =', rate(json.domBvs, json.omitBvs));
console.log('  rcmd(带) ∩ rcmd(无)   =', rate(json.rcmdBvs, json.omitBvs));

console.log('\n  DOM 前 8:', json.domBvs.slice(0, 8).join(', '));
console.log('  带Cookie 前 8:', json.rcmdBvs.slice(0, 8).join(', '));
console.log('  无Cookie 前 8:', json.omitBvs.slice(0, 8).join(', '));

fs.writeFileSync('D:/Temp/m1-evidence.json', JSON.stringify(json, null, 2), 'utf8');
