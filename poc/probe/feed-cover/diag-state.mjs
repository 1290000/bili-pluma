// 诊断：当前页面自己的 SSR 数据在哪
// 目标：找到"服务端下发给这次加载"的推荐列表，而不是重新 fetch 一份新的
import { execFileSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SESSION = arg('session');
const TAB = arg('tab');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const EXPR = `(() => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const out = {};
  // 1) 常见 SSR 全局变量
  out.globals = {
    __INITIAL_STATE__: typeof window.__INITIAL_STATE__,
    __pinia: typeof window.__pinia,
    __NUXT__: typeof window.__NUXT__,
    __vue_app__: typeof document.querySelector('#app')?.__vue_app__,
  };
  // 2) pinia state 里找 rcmd / recommend 相关
  try {
    const st = window.__pinia && window.__pinia.state && window.__pinia.state.value;
    if (st) {
      out.piniaStores = Object.keys(st);
      const hits = [];
      for (const [k, v] of Object.entries(st)) {
        const s = JSON.stringify(v);
        if (s && s.indexOf('rcmd') >= 0) hits.push({ store: k, len: s.length, sample: s.slice(0, 200) });
      }
      out.piniaRcmdmStores = hits.slice(0, 5);
    }
  } catch (e) { out.piniaErr = String(e); }
  // 3) Vue app 的根组件 props/state
  try {
    const app = document.querySelector('#app')?.__vue_app__;
    if (app) {
      out.appKeys = Object.keys(app).slice(0, 20);
      const gs = app.config?.globalProperties;
      out.globalProps = gs ? Object.keys(gs).slice(0, 20) : null;
    }
  } catch (e) { out.appErr = String(e); }
  // 4) 性能条目：这次加载发出了哪些 feed/rcmd 请求
  const res = performance.getEntriesByType('resource').filter((r) => r.name.indexOf('feed/rcmd') >= 0);
  out.perfRcmd = res.map((r) => ({ name: r.name.slice(0, 150), startTime: Math.round(r.startTime), duration: Math.round(r.duration) })).slice(0, 10);
  out.perfRcmdCount = res.length;
  // 5) 所有 api.bilibili.com 的请求（看首屏到底打了哪些）
  const apiReqs = performance.getEntriesByType('resource')
    .filter((r) => r.name.indexOf('api.bilibili.com') >= 0)
    .map((r) => ({ path: r.name.replace('https://api.bilibili.com', '').split('?')[0], start: Math.round(r.startTime) }));
  out.apiRequests = apiReqs.slice(0, 40);
  out.apiCount = apiReqs.length;
  return JSON.stringify(out);
})()`;

const out = execFileSync('bsk', ['evaluate', '--session', SESSION, '--tab-id', String(TAB), EXPR], {
  env: ENV, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024,
});
console.log(JSON.stringify(JSON.parse(out.slice(out.indexOf('{'))), null, 1));
