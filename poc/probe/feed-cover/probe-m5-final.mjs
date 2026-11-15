// M5 最终版：关代理 → 刷新 → 读 lastStage + primaryReason 的可靠替代物
//
// ## 判据重构
//   `primaryReason` 不在 page/snapshot 里（snapshot.primary 是裁剪后的 5 字段）。
//   但有两个**直接可读**的等价物：
//     A. `window.__PLUMA_PGC__.lastStage`（主世界，bsk evaluate 直读）
//        - `skip-proxy-off` = 代理关着 → PGC 注入被跳过（正确行为）
//     B. `window.__playinfo__` 存在性
//        - 存在且 hasDash=false → 是 SSR 的简版数据
//        - 不存在 → 被 Pluma 隐藏了
//
// ## 本轮 M5 要点
//   关总开关 → 刷新 → 看：
//     - lastStage 是否变成 skip-proxy-off
//     - skipProxyOffCount 是否 +1
//     - 恢复后是否回到正常
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
    return { raw: out.slice(0, 400) };
  }
};
const sleep = (ms) => evaluate(`(async()=>{await new Promise(r=>setTimeout(r,${ms}));return JSON.stringify({ok:1})})()`);

const READ = `(() => JSON.stringify({
  pgc: window.__PLUMA_PGC__ ? { lastStage: window.__PLUMA_PGC__.lastStage, skipProxyOff: window.__PLUMA_PGC__.skipProxyOffCount, swapCount: window.__PLUMA_PGC__.swapCount, ssHit: window.__PLUMA_PGC__.ssHit, cfgCount: window.__PLUMA_PGC__.cfgCount } : null,
  playinfo: { exists: typeof window.__playinfo__ !== 'undefined', hasDash: !!(window.__playinfo__ && window.__playinfo__.data && window.__playinfo__.data.dash) },
}))()`;

const setProxy = (enabled) => `(async () => {
  const r = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'set-proxy-reply') {
        clearTimeout(t); window.removeEventListener('message', h); resolve(e.data);
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'set-proxy', enabled: ${enabled} }, '*');
  });
  return JSON.stringify(r);
})()`;

const out = [];
const rec = (k, v) => {
  console.log(`\n### ${k}\n${JSON.stringify(v, null, 1)}`);
  out.push({ step: k, ...v });
};

console.log('=== M5 最终 ===');
console.log('页面:', JSON.stringify(evaluate('JSON.stringify({h:location.href})')));

// 0. 代理开着
rec('0-代理开', evaluate(READ));

// 1. 关代理
console.log('\n--- 关总开关 ---');
console.log(JSON.stringify(evaluate(setProxy(false))));
sleep(1200);

// 2. 刷新
console.log('\n--- 刷新 ---');
try {
  runBs(['reload', '--session', SI, '--tab-id', TAB]);
} catch {}
sleep(11000);

// 3. 读
rec('1-代理关+刷新', evaluate(READ));

// 4. 恢复
console.log('\n--- 恢复总开关 ---');
console.log(JSON.stringify(evaluate(setProxy(true))));
sleep(1200);

// 5. 再刷新确认恢复
try {
  runBs(['reload', '--session', SI, '--tab-id', TAB]);
} catch {}
sleep(11000);
rec('2-恢复后刷新', evaluate(READ));

fs.writeFileSync('D:/Temp/m5-final.json', JSON.stringify(out, null, 2), 'utf8');
console.log('\n→ D:/Temp/m5-final.json');
