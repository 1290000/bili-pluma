// 确认 pluma-* DOM 是不是扩展注入的
import { execFileSync } from 'node:child_process';

const SI = process.env.SESSION_ID || 'seee';
const TAB = process.env.TAB_ID || '1673235534';
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const EXPR = `(() => {
  const ids = [];
  ['pluma-badge-host','pluma-panel-host','pluma-ad-clean','pluma-home-clean'].forEach((k) => {
    if (document.getElementById(k)) ids.push(k);
  });
  // 这些元素由谁创建？看它们有没有 shadowRoot（我们扩展用 closed shadow）
  const host = document.getElementById('pluma-panel-host');
  const info = {
    presentIds: ids,
    panelHasShadow: host ? !!host.shadowRoot : null,
    bodyCls: document.body.className,
    // 页面上是否有指向扩展的 script
    extScripts: [...document.querySelectorAll('script[src]')].map((s) => s.src).filter((s) => s.indexOf('extension') >= 0).length,
  };
  return JSON.stringify(info);
})()`;

const out = execFileSync('bsk', ['evaluate', '--session', SI, '--tab-id', TAB, EXPR], {
  env: ENV, encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024,
});
console.log(out.trim());
