// 诊断3：从 pinia 读推荐 store 的初始数据
import { execFileSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SESSION = arg('session');
const TAB = arg('tab');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const EXPR = `(() => {
  const out = {};
  const st = window.__pinia && window.__pinia.state && window.__pinia.state.value;
  out.stores = st ? Object.keys(st) : null;
  if (st) {
    const found = [];
    for (const [k, v] of Object.entries(st)) {
      let s = '';
      try { s = JSON.stringify(v); } catch (e) { continue; }
      if (!s) continue;
      const bvs = (s.match(/BV[0-9A-Za-z]{10}/g) || []);
      if (bvs.length) found.push({ store: k, len: s.length, bvCount: new Set(bvs).size, keys: Object.keys(v || {}).slice(0, 12) });
    }
    out.storesWithBV = found;
  }
  return JSON.stringify(out);
})()`;

const o = execFileSync('bsk', ['evaluate', '--session', SESSION, '--tab-id', String(TAB), EXPR], {
  env: ENV, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024,
});
console.log(JSON.stringify(JSON.parse(o.slice(o.indexOf('{'))), null, 1));
