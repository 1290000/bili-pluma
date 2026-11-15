// M1 前置检查：Pluma 是否配置了「取流账号」（第二个账号）
//
// 只读。不读凭据值，只读"配置了没有 / 取流身份是什么"。
// 通过扩展的面板 DOM 文本探测（面板是 closed shadow，但 host 元素本身可读属性）。
import { execFileSync } from 'node:child_process';

const SI = process.env.SESSION_ID || 'khya';
const TAB = process.env.TAB_ID || '1673235541';
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const EXPR = `(() => {
  const host = document.getElementById('pluma-panel-host');
  const out = {
    panelExists: !!host,
    // closed shadow 读不到 shadowRoot，但能读 host 上的自定义属性 / dataset / 子元素
    hostAttrNames: host ? [...host.attributes].map((a) => a.name) : [],
    hostDataset: host ? Object.assign({}, host.dataset) : null,
    hostChildCount: host ? host.childElementCount : null,
    hostTag: host ? host.tagName : null,
    bodyCls: document.body.className,
  };
  return JSON.stringify(out);
})()`;

const out = execFileSync('bsk', ['evaluate', '--session', SI, '--tab-id', TAB, EXPR], {
  env: ENV, encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024,
});
console.log(out.trim());
