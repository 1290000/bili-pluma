/**
 * 番剧（PGC）取流候选侦察 —— 最小冒烟。
 *
 * 只做一件事：在番剧页里用**页面内 fetch** 打一次
 * `/pgc/player/web/playurl?cid=…&avid=0&qn=80&fnval=4048&fnver=0&fourk=1`，
 * 把这集的 `dash` 候选（host / os / path）与 `durl` / `durls` 的有无打出来。
 *
 * ## 为什么这个 fetch 拿得到「服务端原文」
 *
 * 主世界的 `window.fetch` hooks 只对 `/x/player/playurl`、`/x/player/wbi/playurl`
 * 做响应改写（`PROGRESS_PATCH_PATHS`），`/pgc/player/web/playurl` **不在里面** ——
 * 所以这条 fetch 走的是原生 fetch，拿到的就是服务端返回，**没有被扩展过滤过**。
 * 这正是本轮要的「PGC 响应体原始形态」。
 *
 * DNR 仍会在网络层把 Cookie 换成取流账号（`/pgc/player/web/playurl` 在白名单里），
 * 所以我们拿到的是**完整集 dash**，不是试看。
 *
 * 用法：
 *   npx tsx poc/probe/pcdn-diag/pgc-recon.mjs             # 默认最新 3 集
 *   PL_EPS=3854824 npx tsx poc/probe/pcdn-diag/pgc-recon.mjs
 */

import { execFileSync } from 'node:child_process';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

/** 凡人修仙传 season 28747 最新 3 集（ep 198 / 199 / 200），2026-11-18 取自
 *  `/pgc/view/web/season?season_id=28747`；ep201 是预告（48s），不进样本。 */
const DEFAULT_EPS = ['3854822', '3854823', '3854824'];

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

const sleep = (ms) => bsk(['wait-ms', String(ms)]);

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
      try {
        sleep(1500);
      } catch {
        /* ignore */
      }
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
          return { host: y.hostname, os: y.searchParams.get('os') || '', path: y.pathname, search: y.search }; }
          catch (e) { return { host: 'bad', os: '', path: '', search: '' }; } });
    const dash = res.dash || null;
    const vids = dash && Array.isArray(dash.video) ? dash.video : [];
    const auds = dash && Array.isArray(dash.audio) ? dash.audio : [];
    const flac = dash && dash.flac && dash.flac.audio ? pack(dash.flac.audio) : null;
    const dolby = dash && dash.dolby && Array.isArray(dash.dolby.audio) ? dash.dolby.audio.map(pack) : null;
    const durl = Array.isArray(res.durl) ? res.durl : null;
    const durls = Array.isArray(res.durls) ? res.durls : null;
    return {
      code: j.code, status: r.status, ttfb,
      playVideoType: res.play_video_type || null,
      isPreview: res.video_info ? res.video_info.is_preview : res.is_preview,
      timelength: res.timelength, quality: res.quality, format: res.format,
      hasDash: !!dash, dashDuration: dash ? dash.duration : null,
      dashKeys: dash ? Object.keys(dash) : [],
      video: vids.map((s) => ({ id: s.id, codecid: s.codecid, w: s.width, h: s.height,
        bw: s.bandwidth || 0, cands: pack(s) })),
      audio: auds.map((s) => ({ id: s.id, bw: s.bandwidth || 0, cands: pack(s) })),
      flac, dolby,
      hasDurl: !!(durl && durl.length), durlCount: durl ? durl.length : 0,
      durlFirstLength: durl && durl[0] ? durl[0].length : null,
      hasDurls: !!durls, durlsGroups: durls ? durls.length : 0,
      durlsSegments: durls ? durls.reduce((a, g) => a + ((g && g.durl) || []).length, 0) : 0,
      // 顶层 result 有哪些键 —— 用来确认形状（dash 版 vs durl 版）
      resultKeys: Object.keys(res),
    };
  })()`;
}

function summarizeOne(ep, cid, raw) {
  const lines = [];
  if (!raw || raw.err) {
    lines.push(`ep${ep} cid=${cid} 取流失败：${(raw && raw.err) || 'null'}`);
    return { lines, classified: null };
  }
  const tally = { official: 0, pcdn: 0, 'third-party': 0, unknown: 0 };
  const pcdnHosts = new Set();
  const perTrack = [];
  for (const t of raw.video || []) {
    let off = 0;
    let p2p = 0;
    for (const c of t.cands) {
      const cls = classifyCdn(c.host, c.search).cls;
      tally[cls] += 1;
      if (cls === 'pcdn') {
        p2p += 1;
        pcdnHosts.add(`${c.host}|${c.os}`);
      } else off += 1;
    }
    perTrack.push({ h: t.h, codecid: t.codecid, n: t.cands.length, off, p2p });
  }
  const maxH = (raw.video || []).reduce((a, t) => Math.max(a, t.h || 0), 0);
  lines.push(
    `ep${ep} cid=${cid} code=${raw.code} ttfb=${raw.ttfb}ms` +
      ` | play_video_type=${raw.playVideoType} is_preview=${raw.isPreview}` +
      ` timelength=${raw.timelength} quality=${raw.quality}`,
  );
  lines.push(
    `  dash=${raw.hasDash} dur=${raw.dashDuration} keys=[${(raw.dashKeys || []).join(',')}]` +
      ` video=${(raw.video || []).length} audio=${(raw.audio || []).length}` +
      ` flac=${raw.flac ? raw.flac.length : 'null'} dolby=${raw.dolby ? raw.dolby.length : 'null'}`,
  );
  lines.push(
    `  ⚠️ durl: has=${raw.hasDurl} n=${raw.durlCount}` +
      ` | durls: has=${raw.hasDurls} groups=${raw.durlsGroups} segs=${raw.durlsSegments}`,
  );
  lines.push(
    `  候选分类 ${JSON.stringify(tally)} · maxHeight=${maxH}` +
      ` · PCDN host: ${pcdnHosts.size ? [...pcdnHosts].join(' , ') : '无'}`,
  );
  const p2pTrack = perTrack.filter((t) => t.p2p > 0 && t.off === 0).length;
  lines.push(
    `  全 PCDN 轨（ADR 0038 兜底会触发的形状）：${p2pTrack} 条 / 共 ${perTrack.length} 条视频轨`,
  );
  return { lines, classified: { tally, pcdnHosts: [...pcdnHosts], perTrack, maxH } };
}

function main() {
  try {
    current();
  } catch {
    bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '60']);
    cached = null;
    current();
  }

  const out = [];
  for (const ep of EPS) {
    process.stdout.write(`\n打开 ep${ep} …\n`);
    openPage(`https://www.bilibili.com/bangumi/play/ep${ep}`);
    sleep(3500);
    // playinfo 里的 cid 是权威的（与本集一致）
    const meta = ev(`(() => {
      const p = window.__playinfo__;
      const inner = p && p.result ? p : (p && p.data && p.data.result ? p.data : null);
      const r = inner && inner.result ? inner.result : null;
      if (!r) return { err: 'no playinfo' };
      const vi = r.video_info || {};
      return { cid: r.arc && r.arc.cid, title: String((r.epInfo && r.epInfo.title) || '').slice(0, 40),
        playVideoType: r.play_video_type, timelength: vi.timelength,
        hasDurl: Array.isArray(vi.durl) && vi.durl.length > 0,
        durlsGroups: Array.isArray(vi.durls) ? vi.durls.length : 0 };
    })()`);
    process.stdout.write(`  playinfo: ${JSON.stringify(meta)}\n`);
    const cid = meta && meta.cid ? String(meta.cid) : null;
    if (!cid) {
      out.push({ ep, cid: null, err: 'no cid' });
      continue;
    }
    const raw = ev(exprRaw(cid));
    const s = summarizeOne(ep, cid, raw);
    for (const l of s.lines) process.stdout.write(`${l}\n`);
    out.push({ ep, cid, meta, raw, summary: s.classified });
  }

  process.stdout.write('\n── 汇总 ──\n');
  for (const r of out) {
    if (!r.summary) continue;
    process.stdout.write(
      `ep${r.ep}: PCDN 候选 ${r.summary.tally.pcdn} / 共 ${Object.values(r.summary.tally).reduce((a, b) => a + b, 0)}` +
        ` · PCDN host ${r.summary.pcdnHosts.length} 个 · 全 PCDN 轨 ${r.summary.perTrack.filter((t) => t.p2p > 0 && t.off === 0).length}\n`,
    );
  }
}

main();