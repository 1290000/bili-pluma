// 8 次 PGC 冷加载：弹窗 + 父页面 Worker 5ms 轮询 __PLUMA_PGC__，测 tCreate / tCfg(gate proxy)。
//   BSK_SESSION=rqag BSK_TAB=<id> BSK_CTX=c1 node poc/probe/pgc/pgc-gate-runs.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'result-pgc-gate.json');
const INSTALL = readFileSync(path.join(__dirname, 'pgc-popup-install.js'), 'utf8').trim();
const READ = readFileSync(path.join(__dirname, 'pgc-popup-read.js'), 'utf8').trim();
const SCOPE = process.env.BSK_SCOPE || 'probe-pgcg';
const SID = process.env.BSK_SESSION;
const TAB = process.env.BSK_TAB;
const CTX = process.env.BSK_CTX || 'c1';
const N = Number(process.env.GATE_RUNS || 8);
if (!SID || !TAB) { console.error('need BSK_SESSION / BSK_TAB'); process.exit(2); }

const bsk = (args) => execFileSync('bsk', ['--scope', SCOPE, ...args], { encoding: 'utf8', env: { ...process.env, BSK_AUTO_START: '0' }, maxBuffer: 64 * 1024 * 1024 });
const evalExpr = (expr) => bsk(['evaluate', '--session', SID, '--tab-id', TAB, '--context', CTX, '--expect', '[{"target":"body","field":"exists","equals":true}]', expr]);
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

const runs = [];
for (let i = 0; i < N; i++) {
  const rec = { i, at: new Date().toISOString() };
  try {
    const inst = parse(evalExpr(INSTALL));
    rec.install = inst;
    if (!inst || !inst.ok) throw new Error('install failed: ' + JSON.stringify(inst).slice(0, 200));
    bsk(['wait-ms', '10000', '--context', CTX, '--json']);
    const out = parse(evalExpr(READ));
    rec.probe = out && out.probe;
    rec.child = out && out.child;
    const p = rec.probe || {};
    const c = rec.child || {};
    rec.tCreate = p.tCreate ?? null;
    rec.tCfg = p.tCfg ?? null;
    rec.tPatched = p.tPatched ?? null;
    rec.firstPlayurl = p.firstPlayurl || null;
    rec.m4sCount = p.m4sCount ?? null;
    rec.gateMinusCreate = rec.tCfg != null && rec.tCreate != null ? rec.tCfg - rec.tCreate : null;
    rec.gateMinusCbEstimate = rec.gateMinusCreate != null ? rec.gateMinusCreate - 85 : null;
    rec.trace = c.trace;
    rec.video = c.video;
    rec.states = (p.states || []).slice(0, 10);
    rec.workerSamples = p.workerSamples;
    runs.push(rec);
    console.log(JSON.stringify({ i, tCreate: rec.tCreate, tCfg: rec.tCfg, gateMinusCreate: rec.gateMinusCreate, gateMinusCbEstimate: rec.gateMinusCbEstimate, tPatched: rec.tPatched, firstPlayurl: rec.firstPlayurl, trace: rec.trace && { cfgCount: rec.trace.cfgCount, lastCfgEnabled: rec.trace.lastCfgEnabled, lastStage: rec.trace.lastStage, ssHit: rec.trace.ssHit, cacheBytes: rec.trace.cacheBytes }, video: rec.video, samples: rec.workerSamples }));
  } catch (e) {
    rec.error = e.message.slice(0, 500);
    runs.push(rec);
    console.log('run ' + i + ' error: ' + rec.error);
  }
}

const stats = (arr) => {
  const xs = arr.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const q = (p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))] : null);
  return { n: xs.length, min: xs[0] ?? null, p50: q(0.5), p90: q(0.9), max: xs[xs.length - 1] ?? null };
};
const summary = {
  tCreate: stats(runs.map((r) => r.tCreate)),
  tCfg: stats(runs.map((r) => r.tCfg)),
  gateMinusCreate: stats(runs.map((r) => r.gateMinusCreate)),
  gateMinusCbEstimate: stats(runs.map((r) => r.gateMinusCbEstimate)),
  note: 'tGate 代理 = 第一次 cfgCount>0 且 lastCfgEnabled===true。gateMinusCbEstimate = gateMinusCreate - 85ms；85ms 取自 Q1 番剧 dash 实测 create→首个回调（704→789ms）。冷启动 sessionStorage 为空，不应有 cache cfg 抢跑。',
};
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), runs, summary }, null, 2), 'utf8');
console.log('\nSUMMARY');
console.log(JSON.stringify(summary, null, 2));
