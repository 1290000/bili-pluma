/**
 * 「`/v1/resource/upgcxcode/` 路径能否在官方 host 上直连」探针 · 阶段 A：取数（含失效降级）。
 *
 * ## 这一版为什么要保存**全部** 2160p 轨
 *
 * 本探针的核心问题是"**同一个对象、同一份签名，只把 path 前缀从 `/upgcxcode/` 换成
 * `/v1/resource/upgcxcode/`，官方 host 还认不认**"。回答它**不一定要**遇到真实的 PCDN
 * `/v1` 候选 —— 只要有一条**签名还有效**的官方 2160p 候选，就能就地构造出两种 path
 * 形态做对照（见 `verify-v1-path.mjs` 的 W1/W2/W3 组）。
 *
 * 而 2026-11-18 本机的实测是：**连续 42 次 playurl 全部只分到官方 host，一次 PCDN 都没有**
 * （`v1-path-candidates.json` 的 `sweepLog.hostHistogram` 里 0 个 mcdn/供应商域）。
 * 这与 task #14「本机当前无 PCDN 分配」的记录一致。所以脚本必须能在"拿不到 PCDN"时
 * **仍然产出可用样本**，否则整个探针会因外部条件卡死。
 *
 * ## 三条取数路径（依次尝试，任一成功即够用）
 *
 * 1. **API 直取**：`/x/player/playurl?qn=120&fnval=4048&fourk=1`，多轮 —— 候选分配每次变（计划 F3）；
 * 2. **播放器真实请求**：`tab create` 打开视频页，钩住 XHR 抓播放器自己那次 playurl 的
 *    完整 URL 再重放一次 —— 播放器的参数集（`w_rid` / `wts` / `gaia_source` …）比裸 API 多，
 *    有可能分到不同线路；
 * 3. **降级**：都没有 `/v1` 时，照样保存官方候选（`hasV1: false`），供第二阶段构造测试。
 *
 * 只读：不改 `src/`、不写页面 DOM、不点登录登出。
 *
 * 跑法：
 *   node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/collect-v1-path-candidates.mjs
 *
 * 环境变量：
 * - `V1_ROUNDS`（API 轮数，默认 4）
 * - `V1_TARGET`（目标轨数，默认 8）
 * - `V1_OUT`（输出文件名，默认 `v1-path-candidates.json`）—— 第二轮 proxy 吞吐探针
 *   需要一批**从未经 proxy 请求过**的冷对象，落另一个文件，别覆盖第一轮的输入
 * - `V1_EXCLUDE`（逗号分隔的 bvid，发现阶段直接跳过）—— 上一轮 proxy 请求过的对象
 *   在 proxy 边缘已是热的，必须排除，否则"冷对象是否必慢"这一问题会被污染
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, process.env.V1_OUT || 'v1-path-candidates.json');

/** 发现阶段要跳过的 bvid（上一轮已对它们发过 proxy 请求，边缘已热） */
const EXCLUDE = (process.env.V1_EXCLUDE || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

/** bsk 需要的本机环境（见 AGENTS-TOOLS.md §4） */
const ENV = {
  ...process.env,
  BSK_HOME: process.env.BSK_HOME || 'C:/Users/i1290/.bsk',
  BSK_AUTO_START: '0',
  PATH: `/c/Users/i1290/.local/bin:${process.env.PATH || ''}`,
};

/** 跑一条 bsk 命令，返回 stdout */
function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, {
      encoding: 'utf8',
      env: ENV,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`bsk ${args[0]} 失败：${error.stderr || error.stdout || error.message}`);
  }
  if (!json) return out.trim();
  const index = out.indexOf('{');
  if (index < 0) throw new Error(`bsk ${args[0]} 没有返回 JSON：${out.slice(0, 200)}`);
  return JSON.parse(out.slice(index));
}

/** 当前 bsk 会话 / 标签页 / context（多次重试：B站页面 VOM 常在变） */
function current(attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const sync = bsk(['sync', '--json'], { json: true });
      if (sync.session_id && sync.ctx) {
        return { session: sync.session_id, tab: sync.tab_id, ctx: sync.ctx };
      }
      last = new Error(`sync 无 session/ctx：${JSON.stringify(sync).slice(0, 160)}`);
    } catch (error) {
      last = error;
    }
  }
  throw last || new Error('bsk sync 失败');
}

/** 在页面里跑一段表达式，返回 JS 值 */
function evaluate(expression) {
  const cur = current();
  const raw = bsk([
    'evaluate',
    '--session', cur.session,
    '--tab-id', String(cur.tab),
    '--context', cur.ctx,
    '--expect', '[{"target":"body","field":"exists","equals":true}]',
    expression,
  ]);
  const index = raw.indexOf('{');
  if (index < 0) throw new Error(`evaluate 没有返回 JSON：${raw.slice(0, 200)}`);
  const parsed = JSON.parse(raw.slice(index));
  return parsed && parsed.value !== undefined ? parsed.value : parsed;
}

/** 页面侧公共前缀 */
const PRELUDE = `
  const j = (u) => fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } }).then((r) => r.json());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

/**
 * 发现阶段：热门榜 → 只看**确有 2160p 轨**的稿件。
 *
 * B站热门榜里 4K 稿件占少数（实测 24 条里 6 条），先筛掉没有 4K 的，
 * 才能把有限的请求额度花在"对同一条 4K 稿件多打几次"上（候选分配每次变，计划 F3）。
 */
function exprDiscover() {
  return `(async () => {${PRELUDE}
    const EXCLUDE = new Set(${JSON.stringify(EXCLUDE)});
    const nav = await j('https://api.bilibili.com/x/web-interface/nav');
    const pop = await j('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1');
    const list = (pop && pop.data && pop.data.list) || [];
    const out = [];
    for (const v of list) {
      if (EXCLUDE.has(v.bvid)) continue;
      try {
        const view = await j('https://api.bilibili.com/x/web-interface/view?bvid=' + v.bvid);
        const cid = view && view.data && view.data.cid;
        if (!cid) continue;
        const p = await j('https://api.bilibili.com/x/player/playurl?avid=' + v.aid + '&cid=' + cid
          + '&qn=120&fnval=4048&fourk=1');
        const vids = (p && p.data && p.data.dash && p.data.dash.video) || [];
        const n2160 = vids.filter((t) => t.height === 2160).length;
        if (n2160 > 0) {
          out.push({ bvid: v.bvid, aid: v.aid, cid,
            title: String(v.title || '').slice(0, 44), n2160 });
        }
      } catch (e) { /* 单条失败不影响整体 */ }
      await sleep(150);
    }
    return { nav: { isLogin: !!(nav && nav.data && nav.data.isLogin),
        vipType: (nav && nav.data && nav.data.vipType) || 0 },
      videos: out };
  })()`;
}

/**
 * 单视频取数：**保存全部 2160p 轨及其全部候选**。
 *
 * `hasV1` / `nV1Candidates` 用来标记"这一轨里有没有真实的 `/v1/resource` 候选"；
 * `hostHistogram` 是"本轮有没有分到 PCDN"的唯一可观测证据 —— 没有它，
 * "没命中"与"没分到 PCDN"在数据里长得一模一样，结论就会失真。
 */
function exprOne(bvid, aid, cid, extraQuery = '') {
  return `(async () => {${PRELUDE}
    const q = 'avid=${aid}&cid=${cid}&qn=120&fnval=4048&fourk=1${extraQuery}';
    const p = await j('https://api.bilibili.com/x/player/playurl?' + q);
    const dash = p && p.data && p.data.dash;
    const urlsOf = (s) => [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean);
    const all2160 = ((dash && dash.video) || []).filter((t) => t.height === 2160);
    const hostHistogram = {};
    let nV1 = 0;
    for (const t of all2160) {
      for (const u of urlsOf(t)) {
        let host = 'INVALID';
        try { host = new URL(u).hostname; } catch (e) { /* 记 INVALID */ }
        hostHistogram[host] = (hostHistogram[host] || 0) + 1;
        if (u.indexOf('/v1/resource/upgcxcode/') >= 0) nV1 += 1;
      }
    }
    const tracks = all2160.map((t, ti) => {
      const cands = urlsOf(t);
      return {
        trackIndex: ti, id: t.id, codecid: t.codecid,
        width: t.width, height: t.height, bandwidth: t.bandwidth,
        frameRate: t.frameRate || null, mimeType: t.mimeType || null,
        hasV1: cands.some((u) => u.indexOf('/v1/resource/upgcxcode/') >= 0),
        candidates: cands.map((u, ci) => ({ index: ci, url: u })),
      };
    });
    return { bvid: '${bvid}', aid: ${aid}, cid: ${cid}, code: p && p.code,
      message: p && p.message,
      accept: (p && p.data && p.data.accept_quality) || null,
      ua: navigator.userAgent,
      nTracks2160: all2160.length, nV1Candidates: nV1, hostHistogram,
      tracks };
  })()`;
}

/**
 * 播放器真实请求：打开视频页 → 钩住 XHR 抓播放器自己那次 playurl → 原样重放一次。
 *
 * 播放器的参数集比裸 API 多（`w_rid` / `wts` / `gaia_source` …），而且它带的是
 * 真实播放上下文；裸 API 连续 42 次都只拿到官方线路，所以这条路值得单试一次。
 */
function exprPlayerPlayurl(bvid) {
  return `(async () => {${PRELUDE}
    const KEY = '__v1probe';
    if (!window[KEY] || !window[KEY].hooked) {
      const H = (window[KEY] = window[KEY] || { hits: [] });
      H.hooked = true;
      const isP = (u) => /\\/playurl/.test(String(u));
      const openOrig = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) {
        try { this.__pu = isP(u) ? String(u) : null; } catch (e) {}
        return openOrig.apply(this, arguments);
      };
      const sendOrig = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        const self = this, u = self.__pu;
        self.__pu = null;
        if (u) {
          self.addEventListener('loadend', () => {
            try { H.hits.push({ url: u, status: self.status, body: self.responseText || '' }); }
            catch (e) { H.hits.push({ url: u, status: self.status, body: '' }); }
          });
        }
        return sendOrig.apply(this, arguments);
      };
    }
    let waited = 0;
    while (!(window.player && typeof window.player.connect === 'function') && waited < 15000) {
      await sleep(500); waited += 500;
    }
    const H = window[KEY];
    H.hits = [];
    if (window.player) {
      try { window.player.disconnect(); } catch (e) {}
      await sleep(600);
      try { window.player.connect(); } catch (e) {}
      await sleep(3500);
    }
    const hit = (H.hits || []).find((h) => h.body && h.body.indexOf('"dash"') >= 0);
    if (!hit) return { bvid: '${bvid}', found: false, nHits: (H.hits || []).length };
    let d = null;
    try { d = JSON.parse(hit.body); } catch (e) { return { bvid: '${bvid}', found: false, parseError: true }; }
    const dash = d && d.data && d.data.dash;
    const urlsOf = (s) => [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean);
    const all2160 = ((dash && dash.video) || []).filter((t) => t.height === 2160);
    const hostHistogram = {};
    let nV1 = 0;
    for (const t of all2160) for (const u of urlsOf(t)) {
      let host = 'INVALID';
      try { host = new URL(u).hostname; } catch (e) {}
      hostHistogram[host] = (hostHistogram[host] || 0) + 1;
      if (u.indexOf('/v1/resource/upgcxcode/') >= 0) nV1 += 1;
    }
    return { bvid: '${bvid}', found: true, code: d && d.code, requestUrl: hit.url,
      nTracks2160: all2160.length, nV1Candidates: nV1, hostHistogram,
      ua: navigator.userAgent,
      tracks: all2160.map((t, ti) => {
        const cands = urlsOf(t);
        return { trackIndex: ti, id: t.id, codecid: t.codecid,
          width: t.width, height: t.height, bandwidth: t.bandwidth,
          frameRate: t.frameRate || null, mimeType: t.mimeType || null,
          hasV1: cands.some((u) => u.indexOf('/v1/resource/upgcxcode/') >= 0),
          candidates: cands.map((u, ci) => ({ index: ci, url: u })) };
      }) };
  })()`;
}

// ─────────────────────────── 主流程 ───────────────────────────

/** 确保有一个 bsk 会话；idle timeout 后重新 open */
function ensureSession() {
  try {
    current(1);
    return;
  } catch {
    bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '80'],
      { json: true });
    current(3);
  }
}

/** 开一个新标签页（`tab create` 不需要严格观测，视频页 VOM 一直在变） */
function openPage(url) {
  const cur = current();
  bsk([
    'tab', 'create', '--url', url,
    '--session', cur.session, '--context', cur.ctx,
    '--expect', '[{"target":"body","field":"exists","equals":true}]',
    '--json',
  ]);
  return current();
}

const MAX_ROUNDS = Number(process.env.V1_ROUNDS || 4);
const TARGET = Number(process.env.V1_TARGET || 8);

ensureSession();
const discovery = evaluate(exprDiscover());
process.stdout.write(
  `有 2160p 的稿件 ${discovery.videos.length} 条；nav login=${discovery.nav.isLogin} ` +
    `vipType=${discovery.nav.vipType}\n`,
);

const videos = [];
const sweepLog = [];

/** 记录一轮取数结果（含 host 直方图，用于区分"没命中"与"没分到 PCDN"） */
function absorb(result, video, round, via) {
  sweepLog.push({
    round, via, bvid: video.bvid,
    nTracks2160: result.nTracks2160, nV1Candidates: result.nV1Candidates || 0,
    hostHistogram: result.hostHistogram || {},
  });
  if (!result.tracks || result.tracks.length === 0) return false;
  if (videos.some((existing) => existing.bvid === video.bvid)) return false;
  result.title = video.title;
  result.via = via;
  videos.push(result);
  return true;
}

let round = 0;
while (videos.length < TARGET && round < MAX_ROUNDS) {
  round += 1;
  process.stdout.write(`\n── 第 ${round} 轮（API 直取）──\n`);
  for (const video of discovery.videos) {
    if (videos.length >= TARGET) break;
    if (videos.some((existing) => existing.bvid === video.bvid)) continue;
    try {
      const result = evaluate(exprOne(video.bvid, video.aid, video.cid));
      const took = absorb(result, video, round, 'api');
      if (took) {
        process.stdout.write(
          `  ✓ ${video.bvid} 轨 ${result.tracks.length}，/v1 候选 ${result.nV1Candidates}\n`,
        );
      }
    } catch (error) {
      process.stdout.write(`  ${video.bvid} 取数失败：${String(error).slice(0, 80)}\n`);
    }
  }
}

/** 若一次 `/v1` 都没拿到，再试一次"播放器真实请求"这条路 */
const anyV1 = videos.some((video) => video.tracks.some((track) => track.hasV1));
if (!anyV1 && discovery.videos.length > 0) {
  const target = discovery.videos[0];
  process.stdout.write(`\n── 播放器真实请求：${target.bvid} ──\n`);
  try {
    openPage(`https://www.bilibili.com/video/${target.bvid}/`);
    const playerResult = evaluate(exprPlayerPlayurl(target.bvid));
    process.stdout.write(
      `  播放器取流 found=${playerResult.found} 2160p 轨=${playerResult.nTracks2160 ?? '-'} ` +
        `/v1=${playerResult.nV1Candidates ?? '-'}\n`,
    );
    if (playerResult.found) {
      absorb({ ...playerResult, nV1Candidates: playerResult.nV1Candidates },
        target, 0, 'player');
    }
  } catch (error) {
    process.stdout.write(`  播放器路径失败：${String(error).slice(0, 120)}\n`);
  }
}

const totalV1 = videos.reduce(
  (sum, video) => sum + video.tracks.reduce(
    (inner, track) => inner + track.candidates.filter(
      (candidate) => candidate.url.indexOf('/v1/resource/upgcxcode/') >= 0).length, 0), 0);
const pcdnHosts = new Set();
for (const entry of sweepLog) {
  for (const host of Object.keys(entry.hostHistogram)) {
    const labels = host.toLowerCase().split('.');
    if (labels.includes('mcdn') || labels.includes('pcdn') || labels.includes('gotcha')
      || /(?:^|\.)(?:szbdyd\.com|mountaintoys\.cn|qrstuvwxyzab\.com|zhenidc\.cn)$/.test(host.toLowerCase())) {
      pcdnHosts.add(host);
    }
  }
}

process.stdout.write(
  `\n汇总：取数 ${sweepLog.length} 次；有 2160p 轨的样本 ${videos.length} 条；` +
    `真实 /v1 候选 ${totalV1} 条；出现过的 PCDN host ${pcdnHosts.size} 个\n`,
);
if (pcdnHosts.size === 0) {
  process.stdout.write('⚠️ 本轮全程零 PCDN 分配 —— Q2 无法直接用真实候选测，改用构造式对照（见报告）\n');
}

const payload = {
  at: new Date().toISOString(),
  note: '「/v1 路径能否在官方 host 直连」探针输入；含签名 URL，gitignored',
  discovery: { nav: discovery.nav, nVideos: discovery.videos.length },
  rounds: round,
  sweepLog,
  pcdnHostsSeen: Array.from(pcdnHosts),
  videos,
};
writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
process.stdout.write(`已写出 ${OUT}\n`);