/**
 * P2P 分片绕过「屏蔽 PCDN」开关的只读诊断（2026-11-18）。
 *
 * ## 要回答的三个问题（主理人给的）
 *
 * ### Q1：playurl 候选里到底有没有 PCDN host？
 *
 * 方法：页面内 `fetch('/x/player/wbi/playurl?…')` 拿**完整响应体**，对
 * `dash.video[*]` 的 `base_url/backup_url` 逐条跑 `classifyCdn(host, search)`。
 *
 * ⚠️ 这个 fetch 会被扩展自己的主世界钩子改写（`patchPlayurlBody`）—— 这**不是**
 * 叠加钩子，而是恰好等于"播放器视角"。为了确认这一点，脚本在开关 ON 与 OFF
 * 两种状态下各取一次候选做对照：两组候选**不同** ⇒ 改写确实作用于本次 fetch；
 * **相同** ⇒ 本次 fetch 没被改写，"候选干净"的结论不可用，必须在报告里写明。
 *
 * ### Q2：mountaintoys 分片与官方候选是什么关系
 *
 * 对比 PCDN 分片的 `pathname + search` 与官方候选（或同刻 bilivideo 分片）是否
 * **逐字相同只换 host**。是 ⇒ p2p loader 在候选基础上换 authority 拉边缘；
 * 否 ⇒ loader 自己生成地址，"阻断域名"可能让播放器无路可退。
 *
 * ### Q3：播放器 P2P 模块的入口
 *
 * - `<script src>` 含 `p2p`/`peer` 的清单；
 * - `window` 上的 `biliP2P` / `webp2p` / `P2P` 类全局；
 * - **hook `RTCPeerConnection` 构造器计数**（只计数，不禁用）——探针装在
 *   document_start 之后，所以只能抓到"装载之后"创建的连接，这一点在报告里写明；
 * - p2p 初始化时机相对播放器的先后。
 *
 * ## 附带（主理人点名）
 *
 * SPA 换片后的第二次 playurl 是否也执行 wantFilter 改写 —— 对比两次响应体。
 *
 * 用法：
 *
 * ```bash
 * npx tsx poc/probe/pcdn-diag/p2p-bypass.mjs --scan          # 找哪条热门视频出现 mountaintoys 分片
 * npx tsx poc/probe/pcdn-diag/p2p-bypass.mjs --diag BV1xxxx  # 对该视频做三问诊断
 * ```
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

const OUT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  'p2p-bypass.json',
);

const POPULAR = process.env.PL_VIDEOS
  ? process.env.PL_VIDEOS.split(',')
  : []; // 空则运行时现取热门

const SAMPLE_SECONDS = Number(process.env.PL_SAMPLE ?? 45);

// ───────────────────────── bsk 封装 ─────────────────────────

function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, {
      encoding: 'utf8',
      env: { ...process.env, BSK_AUTO_START: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`bsk ${args[0]} 失败：${(e.stderr || e.stdout || e.message).slice(0, 260)}`);
  }
  if (!json) return out.trim();
  return JSON.parse(out.slice(out.indexOf('{')));
}

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
      sleep(1200);   // `Document changed during observation` 等瞬时态，等一拍再 sync
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
      // bsk evaluate 的返回可能是 `{value:...}` 包装，也可能直接是表达式结果本身
      // （数组开头是 `[`，从第一个 `{` 截会撞上后续数据 —— 上一版就在这里崩过）。
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        const i = Math.min(...['{', '['].map((c) => {
          const idx = out.indexOf(c);
          return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
        }));
        parsed = JSON.parse(out.slice(i));
      }
      return parsed && parsed.value !== undefined ? parsed.value : parsed;
    } catch (e) {
      last = e;
      cached = null;
      try {
        bsk(['wait-ms', '1500']);
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

const sleep = (ms) => bsk(['wait-ms', String(ms)]);

function agentTabsCount() {
  try {
    const lines = bsk(['tab', 'list']).split(/\r?\n/);
    return lines.filter((l) => l.trim().split(/\s+/)[1] === 'agent').length;
  } catch {
    return 1; // 读不到就按"还有"处理，避免误关
  }
}

function openPage(url) {
  const cur = current();
  try {
    bsk([
      'tab', 'create', '--url', url, '--session', cur.session, '--context', cur.ctx,
      '--expect', '[{"target":"body","field":"exists","equals":true}]', '--json',
    ]);
  } catch {
    // 控制页可能死了：整段重开
    try {
      bsk(['close']);
    } catch {
      /* ignore */
    }
    cached = null;
    bsk(['open', '--no-focus', url, '--json', '--max-tokens', '60']);
    cached = null;
    return current();
  }
  cached = null;
  return current();
}

function closeTab(tabId) {
  try {
    bsk(['tab', 'close', String(tabId), '--json']);
  } catch {
    /* ignore */
  }
  cached = null;
}

// ───────────────────── 页面侧探针 ─────────────────────

/**
 * 装探针（装得越早越好；SPA 换片后本页探针仍在）。
 *
 * - `PerformanceObserver({buffered:true})`：**装载前**的 resource 条目也会吐出来，
 *   `startTime` 精确 —— 后台标签页节流不影响它（事件驱动）；
 * - 只按「host 命中取流域 && pathname 以分片后缀结尾」收条目：
 *   `data.bilibili.com/log/web?...` 的 query 里嵌着 bilivideo 的完整 URL，
 *   按整个 name 匹配正则会把埋点当成分片（上一轮 25/47 条假分片的教训）；
 * - **hook `RTCPeerConnection` 构造器**：只计数与记录创建时刻，不禁用。
 */
const exprInstall = `(() => {
  const KEY = '__p2pDiag';
  if (window[KEY] && window[KEY].installed) return { reused: true };
  const P = (window[KEY] = { installed: true, media: [], rtc: [], playurlFetches: [] });
  const MEDIA_RE = /bilivideo|mcdn|mountaintoys|akamaized|szbdyd|zhenidc|qrstuvwxyzab/;
  const SEG_RE = /\.(m4s|mp4|flv|ts)$/;

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        let u = null;
        try { u = new URL(e.name); } catch (x) { continue; }
        if (!MEDIA_RE.test(u.host)) continue;
        if (!SEG_RE.test(u.pathname)) continue;
        P.media.push({ host: u.host, pathname: u.pathname, search: u.search,
          os: u.searchParams.get('os') || '', t: Math.round(e.startTime) });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { P.observerError = String(e); }

  // hook RTCPeerConnection：只记录，不禁用。initiatorType 不可得，但创建栈里通常有播放器
  try {
    const OrigRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (OrigRTC) {
      window.RTCPeerConnection = function (...args) {
        try {
          const st = (new Error().stack || '').split('\\n').slice(1, 5).join(' | ').slice(0, 300);
          P.rtc.push({ t: Math.round(performance.now()), stack: st });
        } catch (e) {}
        return new OrigRTC(...args);
      };
      window.RTCPeerConnection.prototype = OrigRTC.prototype;
      Object.defineProperty(window.RTCPeerConnection, 'name', { value: 'RTCPeerConnection' });
    }
  } catch (e) { P.rtcHookError = String(e); }
  return { installed: true, rtcHookable: !!window.RTCPeerConnection };
})()`;

/**
 * 页面内 fetch 一次 playurl 并把候选摘出来。
 *
 * ⚠️ 这个 fetch 会被扩展的主世界钩子改写 —— 这正是"播放器视角"。
 * 想要"服务端原始响应"得走 CDP（bsk 录不到），本探针用 ON/OFF 对照来证明改写生效。
 *
 * @param bvid 视频号
 */
function exprFetchCandidates(bvid) {
  return `(async () => {
    const P = window.__p2pDiag;
    const j = (u) => fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } }).then((r) => r.json());
    const v = await j('https://api.bilibili.com/x/web-interface/view?bvid=${bvid}');
    const aid = v && v.data && v.data.aid;
    const cid = v && v.data && v.data.cid;
    const dashDur = v && v.data && v.data.duration;
    if (!aid || !cid) return { err: 'no aid/cid' };
    const p = await j('https://api.bilibili.com/x/player/wbi/playurl?avid=' + aid + '&cid=' + cid
      + '&qn=120&fnval=4048&fourk=1&platform=pc');
    const dash = p && p.data && p.data.dash;
    if (!dash) return { err: 'no dash', code: p && p.code, msg: p && p.message };
    const pack = (s) =>
      [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean)
        .map((u) => { try { const x = new URL(u);
          return { host: x.hostname, os: x.searchParams.get('os') || '', path: x.pathname, search: x.search }; }
          catch (e) { return { host: 'bad', path: '', search: '' }; } });
    const video = (dash.video || []).map((s) => ({ id: s.id, codecid: s.codecid, w: s.width, h: s.height, cands: pack(s) }));
    // p2p 相关全局
    const p2pGlobals = ['biliP2P', 'webp2p', 'P2P', 'BILIP2P'].filter((k) => typeof window[k] !== 'undefined');
    const scripts = Array.from(document.querySelectorAll('script[src]'))
      .map((e) => e.src.split('?')[0]).filter((s) => /p2p|peer/i.test(s));
    return { video, viewDuration: dashDur, p2pGlobals, scripts,
      fetchedAt: Math.round(performance.now()), note: P.playurlFetches.length };
  })()`;
}

/** 读累计数据 */
const exprRead = `(() => {
  const P = window.__p2pDiag;
  if (!P) return { missing: true };
  const v = document.querySelector('video');
  const byHost = {};
  for (const m of P.media) {
    const h = (byHost[m.host] ||= { host: m.host, n: 0 });
    h.n += 1;
    if (!h.firstPath) h.firstPath = m.pathname;
    if (!h.firstSearch) h.firstSearch = m.search.slice(0, 48);
  }
  return { n: P.media.length, byHost: Object.values(byHost).sort((a, b) => b.n - a.n),
    media: P.media.slice(), rtc: P.rtc.slice(), video: v ? { t: +v.currentTime.toFixed(2),
    paused: v.paused, h: v.videoHeight, dur: +v.duration.toFixed(1) } : null };
})()`;

// ───────────────────────── 主流程 ─────────────────────────

/** 确保有活动会话（bsk close 之后 sync 会报 no_active_session） */
function ensureSession() {
  try {
    current();
    return;
  } catch {
    /* 落下去重建 */
  }
  for (let i = 0; i < 3; i += 1) {
    try {
      bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '60']);
      cached = null;
      current();
      return;
    } catch {
      cached = null;
      sleep(1500);
    }
  }
  throw new Error('无法建立 bsk 会话');
}

const argvBvid = (() => {
  const i = process.argv.indexOf('--diag');
  return i >= 0 ? String(process.argv[i + 1]) : null;
})();

/** 找出哪条热门视频的分片来自 mountaintoys（PCDN）——先抓现象 */
async function scan() {
  ensureSession();
  const got = ev(`(async () => {
    const j = (u) => fetch(u, { credentials: 'include' }).then((r) => r.json());
    const pop = await j('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1');
    return ((pop && pop.data && pop.data.list) || []).map((v) => ({ bvid: v.bvid, title: String(v.title || '').slice(0, 24) })).slice(0, 10);
  })()`);
  const findings = [];
  for (const item of got) {
    process.stdout.write(`扫 ${item.bvid} ${item.title}
`);
    openPage(`https://www.bilibili.com/video/${item.bvid}/`);
    ev(exprInstall);
    sleep(20000);   // P2P 常在起播后接管
    const r = ev(exprRead);
    const pcdnHosts = (r.byHost || []).filter((h) => classifyCdn(h.host, undefined).cls === 'pcdn');
    findings.push({ bvid: item.bvid, title: item.title, n: r.n, byHost: r.byHost, pcdnHosts, video: r.video });
    process.stdout.write(`  → ${r.n} 条分片 · ${(r.byHost || []).map((h) => h.host).join(', ')}${pcdnHosts.length ? '  ★ 有 PCDN' : ''}
`);
    // ⚠️ 留一个活页：关掉最后一个 agent 标签页后 `sync` 报
    // `No observable document in this tab`，连新标签页都开不出来
    if (agentTabsCount() > 1) closeTab(current().tab);
    sleep(800);
  }
  const withPcdn = findings.filter((f) => f.pcdnHosts.length > 0);
  process.stdout.write(`
出现 PCDN 分片的视频：${withPcdn.map((f) => f.bvid).join(', ') || '无'}
`);
  writeFileSync(OUT, JSON.stringify({ mode: 'scan', findings }, null, 2), 'utf8');
  process.stdout.write(`已写出 ${OUT}
`);
}

/**
 * 对指定视频做三问诊断（开关保持 ON）。
 *
 * @param bvid 视频号
 */
async function diag(bvid) {
  ensureSession();
  openPage(`https://www.bilibili.com/video/${bvid}/`);
  ev(exprInstall);
  sleep(2500);

  // ── ON 状态候选（会走扩展的改写路径 = 播放器视角）──
  const on = ev(exprFetchCandidates(bvid));
  process.stdout.write(`ON 候选：轨 ${on.video ? on.video.length : '?'} 条
`);

  // 等 40 秒看分片（含 P2P 接管）
  sleep(40000);
  const r1 = ev(exprRead);
  process.stdout.write(`ON 采样①：${r1.n} 条分片
`);
  for (const h of r1.byHost || []) process.stdout.write(`  ${h.host} ×${h.n}
`);

  // 二次 fetch（模拟 SPA 换片后的第二次 playurl）—— 对比两次候选
  const on2 = ev(exprFetchCandidates(bvid));

  try { await ev(`(() => { const v = document.querySelector('video'); if (v && v.paused) v.play().catch(() => {}); return 1; })()`); } catch (e) {}
  sleep(20000);
  const r2 = ev(exprRead);
  process.stdout.write(`ON 采样②：${r2.n} 条分片
`);
  for (const h of r2.byHost || []) process.stdout.write(`  ${h.host} ×${h.n}
`);

  const result = { mode: 'diag', bvid, on, on2, r1: { ...r1, media: undefined }, r2: { ...r2, media: undefined }, media: r1.media };
  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`已写出 ${OUT}
`);
}

if (process.argv.includes('--scan')) {
  scan();
} else if (argvBvid) {
  diag(argvBvid);
} else {
  process.stdout.write('用法：--scan 或 --diag <bvid>\n');
}
