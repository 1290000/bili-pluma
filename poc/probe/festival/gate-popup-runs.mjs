// 10 次活动页冷加载：用同名弹窗 + 父页面 Worker 轮询，精确拿 tCreate/tGate/tFirstPlayurl。
// 复用已打开的 B站首页 session/tab（由外部先建立），每轮只硬导航弹窗到新 URL（nonce 防缓存）。
//   BSK_SESSION=exnt BSK_TAB=<id> BSK_CTX=c1 node poc/probe/festival/gate-popup-runs.mjs
// 产出：poc/probe/festival/result-gate-popup.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'result-gate-popup.json');
const INSTALL = readFileSync(path.join(__dirname, 'expr/popup-probe-install2.js'), 'utf8').trim();
const READ = readFileSync(path.join(__dirname, 'expr/popup-probe-read.js'), 'utf8').trim();
const SCOPE = process.env.BSK_SCOPE || 'probe-gate2';
const SID = process.env.BSK_SESSION;
const TAB = process.env.BSK_TAB;
const CTX = process.env.BSK_CTX || 'c1';
const N = Number(process.env.GATE_RUNS || 10);
if (!SID || !TAB) {
  console.error('need BSK_SESSION and BSK_TAB');
  process.exit(2);
}

const bsk = (args) =>
  execFileSync('bsk', ['--scope', SCOPE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BSK_AUTO_START: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });

const evalExpr = (expr) =>
  bsk(['evaluate', '--session', SID, '--tab-id', TAB, '--context', CTX, '--expect', '[{"target":"body","field":"exists","equals":true}]', expr]);

const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

const runs = [];
for (let i = 0; i < N; i++) {
  const rec = { i, at: new Date().toISOString() };
  try {
    const inst = parse(evalExpr(INSTALL));
    rec.install = inst;
    if (!inst || !inst.ok) throw new Error('install failed: ' + JSON.stringify(inst).slice(0, 200));
    bsk(['wait-ms', '8000', '--context', CTX, '--json']);
    const out = parse(evalExpr(READ));
    rec.probe = out && out.probe;
    rec.child = out && out.child;
    const p = rec.probe || {};
    const c = rec.child || {};
    rec.tCreate = p.tCreate ?? null;
    rec.tHook = p.tHook ?? null;
    rec.tCb = p.tCb ?? null;
    rec.tFirstPlayurl = p.firstPlayurl ? p.firstPlayurl.start : null;
    rec.firstType = p.firstPlayurl ? p.firstPlayurl.init : null;
    rec.gateMinusCreate = rec.tHook != null && rec.tCreate != null ? rec.tHook - rec.tCreate : null;
    // 同步注入下回调大约在 createPlayer 后 50-70ms 被调（Playwright 实测 52/68ms）
    rec.gateMinusCbEstimate = rec.gateMinusCreate != null ? rec.gateMinusCreate - 65 : null;
    rec.firstPlayurlMinusCreate = rec.tFirstPlayurl != null && rec.tCreate != null ? rec.tFirstPlayurl - rec.tCreate : null;
    rec.trace = c.trace;
    rec.identity = c.identity;
    rec.video = c.video;
    rec.workerSamples = p.workerSamples;
    rec.states = (p.states || []).slice(0, 12);
    runs.push(rec);
    console.log(JSON.stringify({ i, tCreate: rec.tCreate, tHook: rec.tHook, tFirstPlayurl: rec.tFirstPlayurl, firstType: rec.firstType, gateMinusCreate: rec.gateMinusCreate, gateMinusCbEstimate: rec.gateMinusCbEstimate, trace: rec.trace && { cbHits: rec.trace.cbHits, remounts: rec.trace.remounts, lastStage: rec.trace.lastStage, lastQuery: rec.trace.lastQuery }, identity: rec.identity && { anyMatchMain: rec.identity.anyMatchMain, m4sMidCount: rec.identity.m4sMidCount }, video: rec.video, samples: rec.workerSamples }));
  } catch (e) {
    rec.error = e.message.slice(0, 600);
    runs.push(rec);
    console.log('run ' + i + ' error: ' + rec.error);
  }
}

const stats = (arr) => {
  const xs = arr.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const q = (p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))] : null);
  return { n: xs.length, min: xs[0] ?? null, p50: q(0.5), p90: q(0.9), max: xs[xs.length - 1] ?? null };
};
const types = runs.reduce((m, r) => { if (r.firstType) m[r.firstType] = (m[r.firstType] || 0) + 1; return m; }, {});
const idMain = runs.filter((r) => r.identity && r.identity.anyMatchMain).length;
const idExt = runs.filter((r) => r.identity && r.identity.m4sMidCount > 0 && !r.identity.anyMatchMain).length;
const summary = {
  tCreate: stats(runs.map((r) => r.tCreate)),
  tHook: stats(runs.map((r) => r.tHook)),
  gateMinusCreate: stats(runs.map((r) => r.gateMinusCreate)),
  gateMinusCbEstimate: stats(runs.map((r) => r.gateMinusCbEstimate)),
  firstPlayurl: stats(runs.map((r) => r.tFirstPlayurl)),
  firstPlayurlMinusCreate: stats(runs.map((r) => r.firstPlayurlMinusCreate)),
  firstWaveTypes: types,
  firstWaveMainAccountIdentity: idMain,
  firstWaveExtensionIdentity: idExt,
  note: 'gateMinusCbEstimate = (tHook - tCreate) - 65ms；65ms 取自 Playwright 同步注入实测（52/68ms）。tHook 是主世界 hookInstalled 变 true 的时刻（Worker 5ms 采样）。',
};
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), runs, summary }, null, 2), 'utf8');
console.log('\nSUMMARY');
console.log(JSON.stringify(summary, null, 2));
