// 确认：DNR 是否在首页接管了 feed/rcmd
//
// 判据（不依赖面板 UI）：
//   ① routes.ts 里 rcmd 在白名单 ✅（已静态确认 ROUTES_REVISION=4）
//   ② 但 DNR 规则只在 `enabled=true` 且有凭据时装
//   ③ 面板显示「未生效」→ 说明 enabled=false 或没装规则
//
// ## 为什么面板在首页显示「未生效」
//   `proxy/status` 的 `enabled` 来自 `storage.local`，与页面类型无关。
//   所以「未生效」= 总开关没开 / 或 lastActivateReason 不是 ok。
//
// ## 本探针只读：读页面能拿到的所有状态线索
import { execFileSync } from 'node:child_process';

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

// 关键：直接调一次 rcmd，看它带的 Cookie 是谁。
// 若 DNR 把 Cookie 换成了取流账号 → 返回的 data.mid 是取流账号的 mid
// 若没换 → data.mid 是页面账号的 mid
const EXPR = `(async () => {
  const out = {};
  // ① 页面身份
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav?_t=' + Date.now(), { credentials: 'include', cache: 'no-store' });
    const j = await r.json();
    out.nav = { code: j.code, mid: j.data && j.data.mid, uname: j.data && j.data.uname, vip: j.data && j.data.vipStatus };
  } catch (e) { out.nav = { err: String(e) }; }

  // ② rcmd 的 data.mid（★ 核心判据）
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&ps=12&fresh_type=4&fresh_idx=1&fresh_idx_1h=1&_t=' + Date.now(), { credentials: 'include', cache: 'no-store' });
    const j = await r.json();
    out.rcmd = {
      code: j.code,
      dataMid: j.data && j.data.mid,
      n: j.data && j.data.item ? j.data.item.length : 0,
      keys: j.data ? Object.keys(j.data).slice(0, 10) : null,
    };
  } catch (e) { out.rcmd = { err: String(e) }; }

  // ③ 页面里能看到的 Pluma 状态痕迹
  out.lsPlumaKeys = Object.keys(localStorage).filter((k) => /pluma/i.test(k));

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR).trim());
