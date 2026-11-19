/**
 * 番剧（PGC）PCDN 巡检 —— 扫一批集，只取 playurl 原文，不播放。
 *
 * 目的：`pgc-recon.mjs` 已证实「某一时刻三集 0 PCDN」，但用户的现场经验是
 * 「新出的近 20 集很容易有 pcdn」。PCDN 是服务端按时段/负载动态分配的，
 * 所以要扫**整批近 20 集**才能判断"此刻到底分不分配"，而不是拿 3 集下结论。
 *
 * 本脚本只做一件事：逐集在页面内原生 fetch `/pgc/player/web/playurl`，
 * 用 `classifyCdn(host, search)` 统计候选里的 PCDN 条数，扫完即关 tab。
 *
 * 用法：
 *   npx tsx poc/probe/pcdn-diag/pgc-sweep.mjs                    # 默认 ep196..ep200
 *   PL_EPS=3854819,3854820 npx tsx poc/probe/pcdn-diag/pgc-sweep.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'pgc-sweep.json');

const DEFAULT_EPS = [
  '3854816', '3854817', '3854818', '3854819', '3854820',
  '3854821', '3854822', '3854823', '3854824',
];

const EPS = (() => {
  const v = process.env.PL_EPS;
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_EPS;
})();

const ENV = { ...process.env, BSK_AUTO_START: '0' };

function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`bsk ${args[0]} 失败：${(e.stderr || e.stdout || e.message).slice(0, 300)}`);
  }
  if (!json) return out.trim();
  return JSON.parse(out.slice(out.indexOf('{')));
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => {
  Atomics.wait(sleepBuf, 0, 0, Math.max(0, Math.round(ms)));
};

let cached = null;

function current() {
  if (cached) return cached;
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      const s = bsk(['sync', '--json'], { json: true });
      cached = { session: s.session_id, tab: s.tab_id, ctx: s.ctx };
      return cached;
    } catch (e) {
      last = e;
      sleep(1200);
    }
  }
  throw last;
}

function ev(expression) {
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      const cur = current();
      const out = bsk([
        'evaluate', '--session', cur.session, '--tab-id', String(cur.tab), '--context', cur.ctx,
        '--expect', '[{"target":"body","field":"exists","equals":true}]', expression,
      ]);
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        const idx = Math.min(
          ...['{', '['].map((c) => {
            const k = out.indexOf(c);
            return k === -1 ? Number.MAX_SAFE_INTEGER : k;
          }),
        );
        parsed = JSON.parse(out.slice(idx));
      }
      return parsed && parsed.value !== undefined ? parsed.value : parsed;
    } catch (e) {
      last = e;
      cached = null;
      sleep(1500);
    }
  }
  throw last;
}

function openPage(url) {
  const cur = current();
  const created = bsk(
    [
      'tab', 'create', '--url', url, '--session', cur.session, '--context', cur.ctx,
      '--expect', '[{"target":"body","field":"exists","equals":true}]', '--json',
    ],
    { json: true },
  );
  cached = null;
  const s = bsk(['sync', '--json'], { json: true });
  cached = { session: s.session_id, tab: Number(created.tab_id), ctx: s.ctx };
  return cached;
}

function closeTab(tabId) {
  try {
    bsk(['tab', 'close', String(tabId)]);
  } catch {
    /* ignore */
  }
  cached = null;
}

/** 页面内取一集的原始 playurl（原生 fetch，不经扩展改写） */
function exprRaw(cid) {
  return `(async () => {
    const u = 'https://api.bilibili.com/pgc/player/web/playurl?cid=' + ${JSON.stringify(cid)} +
      '&avid=0&qn=80&fnval=4048&fnver=0&fourk=1';
    const t0 = performance.now();
    const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
    const j = await r.json();
    const ttfb = Math.round(performance.now() - t0);
    const res = j && (j.result || (j.data && j.data.result));
    if (!res) return { err: 'no result', code: j && j.code, status: r.status, ttfb };
    const pack = (s) =>
      [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean)
        .map((x) => { try { const y = new URL(x);
          return { host: y.hostname, os: y.searchParams.get('os') || '', path: y.pathname }; }
          catch (e) { return { host: 'bad', os: '', path: '' }; } });
    const dash = res.dash || null;
    const vids = dash && Array.isArray(dash.video) ? dash.video : [];
    const auds = dash && Array.isArray(dash.audio) ? dash.audio : [];
    const flac = dash && dash.flac && dash.flac.audio ? pack(dash.flac.audio) : null;
    const dolby = dash && dash.dolby && Array.isArray(dash.dolby.audio) ? dash.dolby.audio.map(pack) : [];
    const durl = Array.isArray(res.durl) ? res.durl : null;
    const durls = Array.isArray(res.durls) ? res.durls : null;
    const all = [];
    for (const v of vids) for (const c of pack(v)) all.push({ ...c, kind: 'video', h: v.height });
    for (const a of auds) for (const c of pack(a)) all.push({ ...c, kind: 'audio', h: null });
    if (flac) for (const c of flac) all.push({ ...c, kind: 'flac', h: null });
    for (const d of dolby) for (const c of d) all.push({ ...c, kind: 'dolby', h: null });
    return {
      code: j.code, status: r.status, ttfb,
      timelength: res.timelength, quality: res.quality,
      hasDash: !!dash, dashDuration: dash ? dash.duration : null,
      nVideo: vids.length, nAudio: auds.length,
      nFlac: flac ? flac.length : 0, nDolby: dolby.length,
      maxH: vids.reduce((a, v) => Math.max(a, v.height || 0), 0),
      hasDurl: !!(durl && durl.length), durlCount: durl ? durl.length : 0,
      hasDurls: !!durls, durlsGroups: durls ? durls.length : 0,
      durlsSegs: durls ? durls.reduce((a, g) => a + ((g && g.durl) || []).length, 0) : 0,
      all,
    };
  })()`;
}

function main() {
  try {
    current();
  } catch {
    bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '60']);
    cached = null;
    current();
  }

  const out = { at: new Date().toISOString(), episodes: [] };
  let pcdnTotal = 0;
  let candTotal = 0;

  for (const ep of EPS) {
    process.stdout.write(`ep${ep} … `);
    let tabId = null;
    try {
      const tab = openPage(`https://www.bilibili.com/bangumi/play/ep${ep}`);
      tabId = tab.tab;
      sleep(2600);
      const meta = ev(`(() => {
        const p = window.__playinfo__;
        const inner = p && p.result ? p : (p && p.data && p.data.result ? p.data : null);
        const r = inner && inner.result ? inner.result : null;
        if (!r) return { err: 'no playinfo' };
        const vi = r.video_info || {};
        return { cid: r.arc && r.arc.cid,
          hasDurl: Array.isArray(vi.durl) && vi.durl.length > 0,
          durlsGroups: Array.isArray(vi.durls) ? vi.durls.length : 0 };
      })()`);
      const cid = meta && meta.cid ? String(meta.cid) : null;
      if (!cid) throw new Error(`no cid (${JSON.stringify(meta)})`);
      const raw = ev(exprRaw(cid));
      if (!raw || raw.err) throw new Error(`raw: ${(raw && raw.err) || 'null'}`);
      const tally = { official: 0, pcdn: 0, 'third-party': 0, unknown: 0 };
      const pcdnHosts = new Map();
      for (const c of raw.all || []) {
        const r = classifyCdn(c.host, c.os ? `os=${c.os}` : '');
        const cls = r.cls;
        tally[cls] = (tally[cls] || 0) + 1;
        if (cls === 'pcdn') {
          const k = `${c.host}|${c.os}`;
          pcdnHosts.set(k, (pcdnHosts.get(k) || 0) + 1);
        }
      }
      const n = raw.all.length;
      pcdnTotal += tally.pcdn;
      candTotal += n;
      out.episodes.push({ ep, cid, raw, tally, pcdnHosts: [...pcdnHosts], playinfo: meta });
      process.stdout.write(
        `cid=${cid} dash=${raw.hasDash} v${raw.nVideo}/a${raw.nAudio}/f${raw.nFlac}/d${raw.nDolby}` +
          ` maxH=${raw.maxH} durls=${raw.durlsGroups}g/${raw.durlsSegs}s` +
          ` | 候选 ${n} PCDN ${tally.pcdn}` +
          (pcdnHosts.size ? ` [${[...pcdnHosts].map(([k, v]) => `${k}×${v}`).join(' , ')}]` : '') +
          '\n',
      );
    } catch (e) {
      process.stdout.write(`✗ ${String(e.message).slice(0, 160)}\n`);
      out.episodes.push({ ep, err: String(e.message).slice(0, 300) });
    } finally {
      if (tabId) closeTab(tabId);
      sleep(600);
    }
  }

  out.pcdnTotal = pcdnTotal;
  out.candTotal = candTotal;
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  process.stdout.write(
    `\n合计：${EPS.length} 集，候选 ${candTotal} 条，PCDN ${pcdnTotal} 条` +
      ` (${candTotal ? ((pcdnTotal / candTotal) * 100).toFixed(1) : '0'}%)\n`,
  );
  process.stdout.write(`落盘：${OUT}\n`);
}

main();