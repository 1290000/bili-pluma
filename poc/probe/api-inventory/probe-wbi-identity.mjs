/**
 * 取证脚本：wbi 签名与身份的关系。
 *
 * 回答两个问题（都**不碰**凭据值）：
 *   1. `nav` 返回的 `wbi_img` 两个 key 是否随账号变化？
 *      —— 若不变，说明 wbi 密钥是**全局的**，换 Cookie 不影响签名有效性。
 *   2. 用 **A 的签名** + **A 的 Cookie** 调 playurl 能否成功；
 *      再用同一签名配不同身份看服务端认谁（此步只能证明签名本身有效）。
 *
 * ⚠️ 本脚本**不读取、不打印**任何 cookie / SESSDATA / bili_jct 的值。
 * 所有请求都用 `credentials: 'include'`，让浏览器自己带当前身份。
 *
 * 运行：node poc/probe/api-inventory/probe-wbi-identity.mjs --session <sid> --tab <id>
 */

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};

const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-wbi-identity.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

function evaluate(expr) {
  const out = execFileSync(
    'bsk',
    ['evaluate', '--session', session, '--tab-id', tab, expr],
    { encoding: 'utf8', env: process.env, shell: false },
  );
  return out.trim();
}

// ── 1. 取 wbi keys（只取文件名部分，不是凭据） ──
const keysJson = evaluate(
  "(async()=>{const n=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'}).then(r=>r.json());return JSON.stringify({img:n.data.wbi_img.img_url,sub:n.data.wbi_img.sub_url,mid:n.data.mid})})()",
);
const keys = JSON.parse(keysJson);

const ek = (u) => {
  const f = u.slice(u.lastIndexOf('/') + 1);
  const i = f.indexOf('.');
  return i === -1 ? f : f.slice(0, i);
};

console.log(
  JSON.stringify(
    {
      mid: keys.mid,
      imgKeyPrefix: ek(keys.img).slice(0, 4) + '…',
      subKeyPrefix: ek(keys.sub).slice(0, 4) + '…',
      imgKeyLen: ek(keys.img).length,
      subKeyLen: ek(keys.sub).length,
    },
    null,
    2,
  ),
);
