// 10 次冷启动：记录首波 playurl 时刻/类型/身份，以及首次观测时 gate 是否已完成。
// 只读：不改产品代码；每轮独立 open/close。
//   node poc/probe/festival/gate-cold-starts.mjs
// 产出：poc/probe/festival/result-gate-cold-starts.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'result-gate-cold-starts.json');
const EXPR = readFileSync(path.join(__dirname, 'expr/identity-compare.js'), 'utf8').trim();
const SCOPE = process.env.GATE_SCOPE || 'probe-gate2';
const N = Number(process.env.GATE_RUNS || 10);
const BASE = 'https://www.bilibili.com/festival/bnj2026?bvid=BV1eoZ7BnEGy';

const bsk = (args) =>
  execFileSync('bsk', ['--scope', SCOPE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BSK_AUTO_START: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });

const parse = (s) => {
  try { return JSON.parse(s); } catch (e) { return null; }
};

const runs = [];
for (let i = 0; i < N; i++) {
  const url = BASE + '&probe=' + Date.now() + '-' + i;
  const rec = { i, urlHasNonce: true, at: new Date().toISOString() };
  let sid = '';
  try {
    const opened = parse(bsk(['open', '--no-focus', url, '--json']));
    if (!opened || !opened.session_id) throw new Error('open failed: ' + JSON.stringify(opened).slice(0, 300));
    sid = opened.session_id;
    rec.session = sid;
    rec.tab = opened.tab_id;
    rec.ctx = opened.ctx;

    // 页面缓冲网络（从导航开始记录）：找首条 playurl
    let net = null;
    for (let k = 0; k < 5; k++) {
      try { net = parse(bsk(['network', '--session', sid, '--limit', '200', '--json'])); } catch (e) { net = null; }
      const rows = ((net && net.entries) || []).filter((e) => /\/x\/player\/wbi\/playurl/.test(e.url || ''));
      if (rows.length) break;
      // 没有就再等一小会儿（用 bsk wait-ms，避免本地 sleep）
      try { bsk(['wait-ms', '500', '--json']); } catch (e) {}
    }
    const rows = ((net && net.entries) || []).filter((e) => /\/x\/player\/wbi\/playurl/.test(e.url || ''));
    const first = rows[0] || null;
    rec.firstPlayurl = first
      ? { ts: first.timestamp, type: first.resource_type, status: first.status, seq: first.sequence }
      : null;

    const snap = parse(
      execFileSync('bsk', ['evaluate', '--session', sid, '--tab-id', String(opened.tab_id), '--context', opened.ctx, '--expect', '[{"target":"body","field":"exists","equals":true}]', EXPR], {
        encoding: 'utf8',
        env: { ...process.env, BSK_AUTO_START: '0' },
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    rec.snap = snap;
    if (first && snap && typeof snap.now === 'number') rec.observeMinusFirst = snap.now - first.timestamp;
    runs.push(rec);
    console.log(JSON.stringify({ i, first: rec.firstPlayurl, observeMinusFirst: rec.observeMinusFirst, trace: snap && snap.trace, identity: snap && { main: snap.anyM4sMatchMain, count: snap.m4sMidCount }, quality: snap && snap.quality, video: snap && snap.video }, null, 2));
  } catch (e) {
    rec.error = e.message.slice(0, 600);
    runs.push(rec);
    console.log('run ' + i + ' error: ' + rec.error);
  } finally {
    if (sid) { try { bsk(['close', '--session', sid]); } catch (e) {} }
  }
}

const nums = (arr) => {
  const xs = arr.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const q = (p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))] : null);
  return { n: xs.length, p50: q(0.5), p90: q(0.9), max: xs.length ? xs[xs.length - 1] : null };
};

const firstTs = runs.map((r) => r.firstPlayurl && r.firstPlayurl.ts);
const gap = runs.map((r) => r.observeMinusFirst);
const types = runs.reduce((m, r) => { const t = r.firstPlayurl && r.firstPlayurl.type; if (t) m[t] = (m[t] || 0) + 1; return m; }, {});
const idMain = runs.filter((r) => r.snap && r.snap.anyM4sMatchMain).length;
const idExt = runs.filter((r) => r.snap && r.snap.m4sMidCount > 0 && !r.snap.anyM4sMatchMain).length;
const gateOpenAtObserve = runs.filter((r) => r.snap && r.snap.trace && r.snap.trace.hookInstalled).length;

writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  base: BASE,
  runs,
  summary: {
    firstPlayurlTs: nums(firstTs),
    observeMinusFirst: nums(gap),
    firstWaveTypes: types,
    firstWaveMainAccountIdentity: idMain,
    firstWaveExtensionIdentity: idExt,
    gateOpenAtFirstObservation: gateOpenAtObserve,
    note: 'observeMinusFirst 是“首次观测 - 首波 playurl”的上界：首次观测时 hookInstalled 已为 true，故 tGate 落在 (tFirstPlayurl, tObserve] 内。',
  },
}, null, 2), 'utf8');
console.log('\nSUMMARY');
console.log(JSON.stringify({ summary: { firstPlayurlTs: nums(firstTs), observeMinusFirst: nums(gap), types, idMain, idExt, gateOpenAtObserve } }, null, 2));
