// M1 前置：确认有两个账号 + 读当前取流身份
//
// ## 只读原则
// - 只读键名与"存在性"，**绝不打印凭据值**
// - 不写任何 storage
//
// ## 为什么读 chrome.storage.local 需要扩展上下文
// 页面（content script / main world）没有 chrome.storage 权限。
// 所以这里只能：
//   ① 从页面读面板的辅助功能树（bsk snapshot，可穿透 closed shadow）
//   ② 从页面读 __pluma* 全局（如果有）
//
// 真要读 chrome.storage 需要扩展页上下文，bsk 打不开 chrome-extension://（ADR：读不到）。

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

const EXPR = `(() => {
  const out = {};
  // ① Pluma 注入的全局
  out.globals = Object.keys(window).filter((k) => /pluma/i.test(k));
  // ② localization / storage 暴露在页面的痕迹
  try {
    out.lsKeys = Object.keys(localStorage).filter((k) => /pluma/i.test(k));
  } catch (e) { out.lsErr = String(e); }
  try {
    out.ssKeys = Object.keys(sessionStorage).filter((k) => /pluma/i.test(k));
  } catch (e) {}
  // ③ 面板 host 当前尺寸（面板是否展开）
  const h = document.getElementById('pluma-panel-host');
  if (h) {
    const r = h.getBoundingClientRect();
    out.panel = { w: Math.round(r.width), h: Math.round(r.height) };
  }
  // ④ 首页 Vue store 里有没有推荐 mid（engineer-a 的第 2 项）
  try {
    const app = document.querySelector('#app');
    out.hasVueApp = !!(app && app.__vue_app__);
    out.hasPinia = typeof window.__pinia;
    out.hasInitialState = typeof window.__INITIAL_STATE__;
  } catch (e) {}
  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR).trim());
