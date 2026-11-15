/**
 * 取证脚本 E2：**csrf 是否与 Cookie 身份绑定**（不只是"必须存在"）。
 *
 * ## 为什么要这一条
 * E 组已证明：csrf 缺失/空/全 0 → 一律 `-111 CSRF 校验失败`。
 * 但这只证明"必须带 csrf"，**没证明"必须和 Cookie 里的 bili_jct 一致"**。
 * 而这恰恰是决定"换 Cookie 不改 body 可不可行"的那一条。
 *
 * ## 判据设计
 * 构造「同一请求体、两种 Cookie 身份」的对照：
 *   - 组 X：**当前登录 Cookie** + 当前账号的真 csrf        → 已知走到业务层（`-400`）
 *   - 组 Y：**当前登录 Cookie** + 一个**格式合法但值不同**的 csrf（随机 32 hex）
 *            若服务端比对 csrf↔Cookie → 返回 `-111`
 *            若服务端只校验"格式/存在" → 返回 `-400`（和 X 一样）
 *
 * 若 Y 返回 `-111` → **csrf 与 Cookie 绑定**成立 → DNR 换 Cookie 不改 body 的方案不可行。
 *
 * ## 零副作用
 * aid 用 2e9（不存在）；不碰 relation/modify；不碰任何真实资源 id。
 * 遇 `-412` 立刻停。
 */
import { evaluate } from './bsk-eval.mjs';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-e2-csrf-binding.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const ENDPOINT = 'https://api.bilibili.com/x/web-interface/archive/like';
const FAKE_AID = '2000000000';

// 随机 32 位小写 hex —— 与真实 bili_jct 同格式，但值必然不同
const FORGED = randomBytes(16).toString('hex');

const expr = `(async()=>{
  const rd=(n)=>{const m=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(n+'='));return m?decodeURIComponent(m.slice(n.length+1)):null};
  const REAL=rd('bili_jct');
  const FORGED='${FORGED}';

  const post=async(csrf)=>{
    const body='aid=${FAKE_AID}&like=1&csrf='+encodeURIComponent(csrf);
    try{
      const r=await fetch('${ENDPOINT}',{method:'POST',credentials:'include',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
      const j=await r.json().catch(()=>({}));
      return {status:r.status,code:j.code,msg:j.message};
    }catch(e){return {err:String(e)}}
  };

  const X=[]; const Y=[];
  let blown=false;
  // 组 X：真 csrf（对照，已知走业务层）
  for(let i=0;i<2;i++){const r=await post(REAL);X.push(r);if(r.code===-412){blown=true;break}}
  // 组 Y：格式合法但不同值
  if(!blown){for(let i=0;i<2;i++){const r=await post(FORGED);Y.push(r);if(r.code===-412){blown=true;break}}}

  return JSON.stringify({
    endpoint:'${ENDPOINT}',
    forgedSameFormat:FORGED.length===32,
    realLen:REAL?REAL.length:null,
    forgedDiffersFromReal:REAL?REAL!==FORGED:null,
    riskControlTriggered:blown,
    X_realCsrf:X,
    Y_forgedCsrf:Y
  });
})()`;

const r = evaluate(session, tab, expr);
console.log('### E2 组：csrf 是否与 Cookie 身份绑定');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 600));
  process.exit(1);
}
console.log(r.out);
