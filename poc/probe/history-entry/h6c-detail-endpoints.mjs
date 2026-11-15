/**
 * H6c：历史详情页首屏 / 滚动加载时打哪些接口（判定数据来源）。
 * 只记录 host+path，不记录响应体与 cookie。
 */
import { spawnSync } from 'node:child_process';

const BSK = process.env.BSK_BIN || 'bsk';
const SESSION = process.env.BSK_SESSION;
const TAB = process.env.BSK_TAB;

function evaluate(expr) {
  const r = spawnSync(
    BSK,
    ['evaluate', '--session', SESSION, '--tab-id', TAB, '--json', expr],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false },
  );
  if (r.error) throw r.error;
  const out = (r.stdout || '').trim();
  if (r.status !== 0) throw new Error(`evaluate failed (${r.status}): ${(r.stderr || out).slice(0, 800)}`);
  const parsed = JSON.parse(out);
  const v = parsed.value ?? parsed.result ?? parsed;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const EXPR = String.raw`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};

  // 用 PerformanceResourceTiming 读**已发生的**请求（本页加载时），不需要提前挂钩子
  const entries = performance.getEntriesByType('resource')
    .map(e => { try { const u = new URL(e.name); return { host: u.hostname, path: u.pathname, m: null }; } catch (x) { return null; } })
    .filter(Boolean)
    .filter(e => /bilibili|hdslb/.test(e.host))
    .filter(e => !/\.(m4s|mp4|js|css|png|jpg|jpeg|webp|svg|woff2?|wasm|ico|gif)$/.test(e.path));

  const uniq = [];
  const seen = new Set();
  for (const e of entries) {
    const k = e.host + e.path;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(e);
  }

  out.totalResourceEntries = entries.length;
  out.uniqueEndpoints = uniq.slice(0, 40);
  out.historyEndpoints = uniq.filter(e => /history/i.test(e.path));
  out.apiBilibiliEndpoints = uniq.filter(e => e.host === 'api.bilibili.com');

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR));
