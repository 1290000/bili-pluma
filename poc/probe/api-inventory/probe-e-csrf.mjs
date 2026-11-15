/**
 * 取证脚本 E：**CSRF 一致性**实测 —— 把「推理，未验证」变成 L1。
 *
 * ## 问题
 * DNR 换 Cookie 后 body 里的 `csrf` 仍是原账号的 → 会不会被拒？
 *
 * ## 方法（零副作用设计）
 * - 资源 id 用一个**明显不存在**的 aid（`2^30` 级别，远大于 B站真实 aid 量级）
 * - 每个接口每组连发最多 3 次；一旦见到 `-412`（风控）**立刻停止整轮**，不重试
 * - **绝不**碰 relation/modify（关注状态即使假 mid 也可能产生副作用，跳过并写明）
 *
 * ## 判据（写死，防"恒真"）
 * 1. **反向对照**：①（正确 csrf）必须走到**业务层**（code 表示"资源不存在"或类似），
 *    而 ④（无 csrf）或 ③ 必须返回 **-111**（csrf 校验失败）。
 *    两者 code 不同 = 判据有区分力，不是恒真。
 * 2. 若 ④ 与 ① 返回**同一个**业务错误 → csrf 校验对这条接口不生效，**原结论推翻**。
 *
 * ⚠️ 凭据值（bili_jct）只在页面 JS 变量里流转，**不打印、不回传**。
 */
import { evaluate } from './bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-e-csrf.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const ENDPOINT = get('--endpoint') || 'https://api.bilibili.com/x/web-interface/archive/like';
// 不存在的 aid：真实 B站 aid 目前约 1e9 量级，用 2e9 确保不存在
const FAKE_AID = get('--aid') || '2000000000';

const expr = `(async()=>{
  // ── 从 document.cookie 取 bili_jct（可读，已实测），只留在局部变量里 ──
  const rd=(n)=>{const m=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(n+'='));return m?decodeURIComponent(m.slice(n.length+1)):null};
  const REAL=rd('bili_jct');
  const hasReal=!!REAL;
  const ZERO='0'.repeat(32);

  const post=async(csrf,label)=>{
    // csrf===null 表示"不带这个字段"
    let body='aid=${FAKE_AID}&like=1';
    if(csrf!==null) body+='&csrf='+encodeURIComponent(csrf);
    try{
      const r=await fetch('${ENDPOINT}',{
        method:'POST',
        credentials:'include',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body
      });
      const j=await r.json().catch(()=>({}));
      return {label,status:r.status,code:j.code,msg:j.message};
    }catch(e){ return {label,err:String(e)}; }
  };

  const out=[];
  const forms=[
    ['correct',  hasReal?REAL:null],
    ['empty',    ''],
    ['zeros',    ZERO],
    ['absent',   null]
  ];

  // 每组连发，遇 -412 立刻停
  let blown=false;
  for(const [name,val] of forms){
    for(let i=1;i<=3;i++){
      const r=await post(val,name);
      out.push(r);
      if(r.code===-412){ blown=true; break; }
      // 同一形态重复 3 次，结果相同就提前结束该形态（省请求）
      if(i>=2 && out[out.length-1].code===out[out.length-2].code) break;
    }
    if(blown) break;
  }

  // 汇总：每个形态取**第一次**结果（代表该形态的稳定行为）
  const first={};
  for(const r of out){ if(!first[r.label]) first[r.label]=r; }

  return JSON.stringify({
    endpoint:'${ENDPOINT}',
    fakeAid:'${FAKE_AID}',
    hasRealCsrf:hasReal,
    csrfLen:hasReal?REAL.length:null,
    riskControlTriggered:blown,
    samples:out.map(x=>({label:x.label,status:x.status,code:x.code,msg:x.msg})),
    byForm:first
  });
})()`;

const r = evaluate(session, tab, expr);
console.log('### E 组：CSRF 一致性实测');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 600));
  process.exit(1);
}
console.log(r.out);
