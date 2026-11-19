/**
 * 番剧（PGC）路径的 PCDN 实测 —— 同一集抓三样并对账。
 *
 * ## 为什么要重测（UGC 那轮的结论不能外推）
 *
 * 上一轮 `REPORT-p2p-bypass.md` 在 UGC（`/video/`）上得到「今夜 30 条视频 0 条
 * PCDN 候选」。用户随即指出样本选错了路径：他复现时用的是**凡人修仙传新出的近 20 集**
 * —— 番剧走 PGC，是完全不同的一套代码与响应形状：
 *
 * | | UGC（`/video/`） | PGC（`/bangumi/play/`） |
 * | --- | --- | --- |
 * | 取流接口 | `/x/player/wbi/playurl` | `/pgc/player/web/playurl`（`result` 本身就是 video_info） |
 * | 响应形状 | `{code, data:{dash,…}}` | `{code, result:{dash \| durl/durls,…}}` |
 * | 取流时机 | 播放器发 XHR | SSR 写进 `__playinfo__`，由扩展回调接管（ADR 0041） |
 * | 改写调用点 | `patchPlayurlBody` / `json` 分支 | `filterDashOf(outResult.video_info)`（标签 `playurl`）+ `playinfo` + `playview` |
 *
 * 所以「今夜没分配到 PCDN」这句话**只对 UGC 成立**，本轮单独验证 PGC。
 *
 * ## 三样（同一集、同一时刻）
 *
 * 1. **PGC playurl 响应体**：页面内**原生 fetch** 打
 *    `/pgc/player/web/playurl?cid=…&avid=0&qn=80&fnval=4048&fnver=0&fourk=1`。
 *    ⚠️ 这条 fetch **不会**被扩展改写：主世界的 `window.fetch` hook 只认
 *    `PROGRESS_PATCH_PATHS = ['/x/player/wbi/playurl', '/x/player/playurl']`，
 *    `/pgc/...` 不在里面。所以拿到的是**服务端原文**。
 *    同时**逐字检查 `durl` / `durls`** —— 本轮最关键的新增项：`filterDashOf()`
 *    对 durl 一个字节都不碰（ADR 0038），若某集只回 durl，屏蔽 PCDN 全程无效。
 * 2. **实际分片 host**：页面内 `PerformanceObserver({buffered:true})` 收 resource 条目，
 *    用 `classifyCdn(host, search)` —— **必须传 search**，否则 `os=mcdn` 那条判据
 *    （`classify.ts` 第 5 条）失效，代理到官方镜像的 mcdn 资源会被判成官方。
 * 3. **扩展判定状态**：页面内 `window.addEventListener('message')` 抓主世界的
 *    `pcdn-filter-stats`（`where` / `applied` / `rewritten` / `proxied` /
 *    `fallbackKept` / `reason`），加上 `__PLUMA_EXT_PATCH__` 计数与
 *    `window.__PLUMA_PGC__` 的接管轨迹。
 *
 * ## 开关
 *
 * 全程 ON（用户报障时的状态）。开关用面板 VOM 拨，**按 `role` + 引号内文案**精确匹配
 * —— VOM 每个控件的 `[ctx: …]` 会把整页文案重复一遍，`line.includes(label)` 会点错。
 *
 * 用法：
 *   npx tsx poc/probe/pcdn-diag/pgc-pcdn.mjs                 # 默认最新 3 集，每集 45s
 *   PL_EPS=3854824 PL_SECONDS=30 npx tsx poc/probe/pcdn-diag/pgc-pcdn.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'pgc-pcdn.json');

/** 凡人修仙传（season 28747）最新 3 集。ep201 是 48s 预告，不进样本 */
const EPS = (() => {
  const v = process.env.PL_EPS;
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : ['3854822', '3854823', '3854824'];
})();

const SECONDS = Number(process.env.PL_SECONDS ?? 45);
const SKIP_SWITCH = process.argv.includes('--no-switch');
const ENV = { ...process.env, BSK_AUTO_START: '0' };

// ───────────────────────── bsk 封装 ─────────────────────────

/**
 * 调 bsk。**瞬时态自动重试**。
 *
 * 实测（2026-11-18 20:38 本轮）：
 * ```
 * error: an earlier command on this session is still finishing in the browser
 * details: Previous operation is still settling; this action was not dispatched
 * ```
 * 点开面板 / 切 Tab / `evaluate` 之后紧接一次 `snapshot` 就会撞上它 ——
 * 报的是「上一条还没 settle」，**命令根本没发出去**，所以重试是安全的
 * （文档也这么写：`nothing was sent; wait about a second and run again`）。
 *
 * @param args bsk 参数
 * @param opts `json` = 解析成对象
 */
function bsk(args, { json = false } = {}) {
  let out = '';
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      out = execFileSync('bsk', args, { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024 });
      lastErr = null;
      break;
    } catch (e) {
      const msg = String(e.stderr || e.stdout || e.message);
      lastErr = e;
      // 只有「还没 settle」这类瞬时态才重试；真错误（权限 / 找不到）立刻抛
      if (
        !/still finishing in the browser|still settling|cooperate_sync_required|previous session command is still running|control context no longer belongs|control state/i.test(
          msg,
        )
      ) {
        throw new Error(`bsk ${args[0]} 失败：${msg.slice(0, 300)}`);
      }
      // 进程内等一拍（不调 `bsk wait-ms`：那会额外消耗一次 IPC，
      // 本轮实测单 run 20+ 次 IPC 会把 daemon 跑死）
      sleep(900 + attempt * 700);
      cached = null;
    }
  }
  if (lastErr) throw new Error(`bsk ${args[0]} 重试 5 次仍失败：${String(lastErr.message).slice(0, 300)}`);
  if (!json) return out.trim();
  // 结果以 `[` 开头时，从第一个 `{` 截会把数组前缀切掉 —— 先整体试，再取 `{`/`[` 更早的下标
  try {
    return JSON.parse(out);
  } catch {
    const idx = Math.min(
      ...['{', '['].map((c) => {
        const k = out.indexOf(c);
        return k === -1 ? Number.MAX_SAFE_INTEGER : k;
      }),
    );
    return JSON.parse(out.slice(idx));
  }
}

/**
 * 等待。**必须用进程内阻塞，不能调 `bsk wait-ms`**。
 *
 * 实测（2026-11-18 20:50 连续两轮）：每集 45 秒窗口里每 5 秒一次 `bsk wait-ms`，
 * 加上 `evaluate` / `snapshot`，单个 run 有 20+ 次 IPC。跑到第 60 秒左右 daemon
 * 就报 `decode IPC response: EOF while parsing a value`（进程没了），
 * 随后整轮实验在第 2、3 集全部失败 —— 数据白丢。
 *
 * `wait-ms` 不操作 DOM、不碰浏览器，**在进程内阻塞完全等价**，且省掉一次 IPC。
 * 改用 `Atomics.wait`（Node 主线程允许，浏览器不允许 —— 这正是能用的原因），
 * 保持 `sleep()` 的**同步签名**，所有调用点不用改成 async。
 *
 * 这么改之后单 run 的 IPC 次数从 20+ 降到 ~8 次。
 *
 * @param ms 毫秒
 */
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
      try {
        sleep(1500);
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

function agentTabs() {
  try {
    return bsk(['tab', 'list'])
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c[1] === 'agent')
      .map((c) => Number(c[0]));
  } catch {
    return [];
  }
}

/** 代理窗口里至少留一个标签页：一个不剩时 `tab create` 报 `No observable document` */
function ensureControlTab() {
  if (agentTabs().length > 0) return;
  try {
    bsk(['close']);
  } catch {
    /* ignore */
  }
  cached = null;
  bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '80']);
  cached = null;
}

function ensureSession() {
  try {
    return current();
  } catch {
    for (let i = 0; i < 3; i += 1) {
      try {
        bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '80']);
        cached = null;
        return current();
      } catch {
        /* retry */
      }
    }
    throw new Error('无法建立 bsk 会话');
  }
}

function openPage(url) {
  ensureSession();
  ensureControlTab();
  let created = null;
  for (let i = 0; i < 4; i += 1) {
    const cur = current();
    try {
      created = bsk(
        [
          'tab', 'create', '--url', url, '--session', cur.session, '--context', cur.ctx,
          '--expect', '[{"target":"body","field":"exists","equals":true}]', '--json',
        ],
        { json: true },
      );
      break;
    } catch (e) {
      process.stdout.write(`    · tab create 失败（第${i + 1}次）：${String(e.message).slice(0, 120)}\n`);
      cached = null;
      sleep(2500 + i * 1500);
      ensureControlTab();
    }
  }
  if (!created) throw new Error(`tab create 连续失败，无法加载 ${url}`);
  cached = null;
  const s = bsk(['sync', '--json'], { json: true });
  cached = { session: s.session_id, tab: Number(created.tab_id), ctx: s.ctx };
  return cached;
}

function closeTab(tabId) {
  try {
    bsk(['tab', 'close', String(tabId), '--json']);
  } catch {
    /* 关不掉不影响数据 */
  }
  cached = null;
  ensureControlTab();
}

// ───────────────────── 开关：面板 VOM ─────────────────────

/**
 * 按**角色 + 引号内文案**找控件。
 *
 * 必须带角色（`显示` 同时出现在 Tab / 分组 / 弹幕设置里），必须匹配引号内文案
 * （VOM 的 `[ctx: …]` 每行都重复整页文案）。这两条都是实测踩出来的。
 */
function findByRole(role, label) {
  const text = bsk(['snapshot']);
  const pat = new RegExp(`(@e\\d+)\\s+${role}\\s+"${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  for (const line of text.split('\n')) {
    const m = pat.exec(line);
    if (m) {
      return {
        ref: m[1],
        checked: role === 'checkbox' ? /\[checked\]/.test(line) : null,
        line: line.trim().slice(0, 140),
      };
    }
  }
  return null;
}

function clickRef(ref) {
  cached = null;
  const cur = current();
  let out = '';
  try {
    out = bsk([
      'click', '--context', cur.ctx,
      '--expect', JSON.stringify([{ target: ref, field: 'exists', equals: true }]),
      ref, '--json',
    ]);
  } catch (e) {
    const msg = String(e.message || e);
    return {
      code: (msg.match(/"code": "([^"]+)"/) || [])[1] || 'error',
      reason: (msg.match(/"reason": "([^"]+)"/) || [])[1] || '',
    };
  } finally {
    cached = null;
  }
  try {
    return JSON.parse(out.slice(out.indexOf('{')));
  } catch {
    return { code: 'ok' };
  }
}

/**
 * 把「屏蔽 PCDN 线路」拨到想要的状态。
 *
 * ⚠️ 拨不到位**必须抛**，不许当成"跳过" —— 上一轮的教训：跳过的组等于"基线不存在"。
 */
function setSwitch(want) {
  for (let i = 0; i < 8; i += 1) {
    let ctl = findByRole('checkbox', '屏蔽 PCDN');
    if (!ctl) {
      const entry = findByRole('button', '打开 Pluma 面板');
      if (entry) {
        const r = clickRef(entry.ref);
        process.stdout.write(`    · 点面板入口 → ${r.code || 'ok'}\n`);
        sleep(900);
        ctl = findByRole('checkbox', '屏蔽 PCDN');
      }
    }
    if (!ctl) {
      const tab = findByRole('tab', '显示');
      if (tab) {
        const r = clickRef(tab.ref);
        process.stdout.write(`    · 切「显示」Tab → ${r.code || 'ok'}\n`);
        sleep(700);
        ctl = findByRole('checkbox', '屏蔽 PCDN');
      }
    }
    if (!ctl) {
      process.stdout.write('    · 还找不到「屏蔽 PCDN 线路」\n');
      continue;
    }
    process.stdout.write(`    · 读到 checked=${ctl.checked}（目标 ${want}）\n`);
    if (ctl.checked === want) return { ok: true, read: ctl.checked, line: ctl.line };
    const r = clickRef(ctl.ref);
    process.stdout.write(`      click → ${r.code || 'ok'}\n`);
    sleep(900);
    const after = findByRole('checkbox', '屏蔽 PCDN');
    if (after && after.checked === want) return { ok: true, read: after.checked, line: after.line };
    process.stdout.write(`    · 拨后读到 ${after ? after.checked : 'null'}，重试\n`);
  }
  throw new Error(`「屏蔽 PCDN 线路」拨不到 ${want} —— 不跳过，直接失败`);
}

// ───────────────────── 页面侧探针 ─────────────────────

/**
 * 装探针：分片请求 + 主世界统计 + PGC 轨迹。
 *
 * 三个要紧的细节（都是前几轮踩出来的）：
 * 1. **必须按 pathname 后缀过滤**：`data.bilibili.com/log/web?...` 的 query 里嵌着
 *    完整 bilivideo URL，按整个 name 匹配会把埋点当分片（曾 25/47 条假分片）。
 * 2. `PerformanceObserver({buffered:true})` 能吐出**装载前**的条目，且 `startTime`
 *    精确；后台标签页节流不影响它（事件驱动）。
 * 3. 主世界 `pcdn-filter-stats` 走 `window.postMessage` → 页面能直接听。
 */
const exprInstall = `(() => {
  const KEY = '__pgcProbe';
  if (window[KEY] && window[KEY].installed) return { reused: true };
  const P = (window[KEY] = { installed: true, at: Math.round(performance.now()),
    media: [], stats: [], patches: [], pgcMsgs: [], video: null });
  const MEDIA_RE = /bilivideo|mcdn|mountaintoys|akamaized|szbdyd|zhenidc|qrstuvwxyzab/;
  const SEG_RE = /\\.(m4s|mp4|flv|ts)$/;

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        let u = null;
        try { u = new URL(e.name); } catch (x) { continue; }
        if (!MEDIA_RE.test(u.host)) continue;
        if (!SEG_RE.test(u.pathname)) continue;
        P.media.push({ host: u.host, path: u.pathname, search: u.search.slice(0, 400),
          os: u.searchParams.get('os') || '', t: Math.round(e.startTime) });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { P.observerError = String(e); }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__ns !== '__PLUMA__') return;
    if (d.__PLUMA_EXT_PATCH__) { P.patches.push({ t: Math.round(d.at || 0) }); return; }
    if (d.type === 'pcdn-filter-stats') {
      P.stats.push({ applied: d.applied === true, where: d.where || null,
        rewritten: d.rewritten || 0, proxied: d.proxied || 0,
        fallbackKept: d.fallbackKept || 0, reason: d.reason || null,
        at: Math.round(performance.now()) });
      return;
    }
    if (d.type === 'pgc') {
      P.pgcMsgs.push({ stage: d.stage || null, detail: String(d.detail || '').slice(0, 120),
        lastStage: d.lastStage || null, at: Math.round(performance.now()) });
    }
  });

  // 播放器在后台标签页会自己停：只在 paused 时续播，**不改静音状态**
  P.keep = setInterval(() => {
    const v = document.querySelector('video');
    if (!v) return;
    if (v.paused && v.readyState >= 2) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  }, 1000);
  return { installed: true };
})()`;

/** 读 SSR 的 `__playinfo__` 候选（页面自己那份，导入前） */
const exprSsr = `(() => {
  const p = window.__playinfo__;
  const inner = p && p.result ? p : (p && p.data && p.data.result ? p.data : null);
  const r = inner && inner.result ? inner.result : null;
  if (!r) return { err: 'no playinfo' };
  const vi = r.video_info && typeof r.video_info === 'object' ? r.video_info : {};
  const pack = (s) =>
    [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean)
      .map((x) => { try { const y = new URL(x);
        return { host: y.hostname, os: y.searchParams.get('os') || '', path: y.pathname, search: y.search }; }
        catch (e) { return { host: 'bad', os: '', path: '', search: '' }; } });
  const dash = vi.dash && typeof vi.dash === 'object' ? vi.dash : null;
  return {
    cid: r.arc && r.arc.cid,
    playVideoType: r.play_video_type || null,
    isPreview: vi.is_preview === true,
    timelength: vi.timelength,
    hasDash: !!(dash && Array.isArray(dash.video) && dash.video.length),
    dashDuration: dash ? dash.duration : null,
    videoN: dash && Array.isArray(dash.video) ? dash.video.length : 0,
    durlType: Array.isArray(vi.durl) ? ('array:' + vi.durl.length) : typeof vi.durl,
    durlsType: Array.isArray(vi.durls) ? ('array:' + vi.durls.length) : typeof vi.durls,
    video: dash && Array.isArray(dash.video)
      ? dash.video.map((s) => ({ id: s.id, h: s.height, w: s.width, codecid: s.codecid, cands: pack(s) }))
      : [],
    audio: dash && Array.isArray(dash.audio) ? dash.audio.map((s) => ({ id: s.id, cands: pack(s) })) : [],
  };
})()`;

/**
 * 页面内**原生 fetch** 打一次 PGC playurl。
 *
 * ⚠️ 这条**不会**被扩展改写（`/pgc/...` 不在 `PROGRESS_PATCH_PATHS`），
 * 所以拿到的是服务端原文 —— 正是"候选里有没有 PCDN"的权威答案。
 *
 * 同时逐字记录 `durl` / `durls` 的**类型与长度**（`null` / 空数组 / 有段），
 * 这是本轮最关键的新增项：纯 durl 响应下 `filterDashOf()` 全程不生效。
 */
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
    const dash = res.dash && typeof res.dash === 'object' ? res.dash : null;
    const durl = res.durl;
    const durls = res.durls;
    /** 精确形状：缺失 / null / 空数组 / 有内容 —— 四种情况的结论完全不同 */
    const shape = (v) => {
      if (v === undefined) return 'undefined';
      if (v === null) return 'null';
      if (Array.isArray(v)) return v.length === 0 ? 'array:0' : ('array:' + v.length);
      return typeof v;
    };
    const segOf = (arr) => {
      let segs = 0, totalMs = 0;
      if (!Array.isArray(arr)) return { segs: 0, totalMs: 0 };
      for (const g of arr) {
        const inner = g && Array.isArray(g.durl) ? g.durl : null;
        if (inner) { segs += inner.length;
          for (const s of inner) if (s && typeof s.length === 'number') totalMs += s.length; }
        else if (g && typeof g.length === 'number') { segs += 1; totalMs += g.length; }
      }
      return { segs, totalMs };
    };
    const durlSeg = segOf(durl);
    const durlsSeg = segOf(durls);
    return {
      code: j.code, status: r.status, ttfb,
      playVideoType: res.play_video_type || null,
      isPreview: res.is_preview === true,
      timelength: res.timelength, quality: res.quality, format: res.format,
      resultKeys: Object.keys(res),
      hasDash: !!(dash && Array.isArray(dash.video) && dash.video.length),
      dashKeys: dash ? Object.keys(dash) : [],
      dashDuration: dash ? dash.duration : null,
      video: dash && Array.isArray(dash.video)
        ? dash.video.map((s) => ({ id: s.id, codecid: s.codecid, w: s.width, h: s.height,
          bw: s.bandwidth || 0, cands: pack(s) }))
        : [],
      audio: dash && Array.isArray(dash.audio)
        ? dash.audio.map((s) => ({ id: s.id, bw: s.bandwidth || 0, cands: pack(s) })) : [],
      flac: dash && dash.flac && dash.flac.audio ? pack(dash.flac.audio) : null,
      flacKeys: dash && dash.flac ? Object.keys(dash.flac) : [],
      dolby: dash && dash.dolby && Array.isArray(dash.dolby.audio)
        ? dash.dolby.audio.map(pack) : null,
      dolbyKeys: dash && dash.dolby ? Object.keys(dash.dolby) : [],
      durlShape: shape(durl), durlsShape: shape(durls),
      durlSegs: durlSeg.segs, durlTotalMs: durlSeg.totalMs,
      durlsSegs: durlsSeg.segs, durlsTotalMs: durlsSeg.totalMs,
      /** 有 dash 又有 durl/durls 时，播放器**优先走 durl**（ADR 0020 实测）—— 这条最危险 */
      dashAndDurl: !!(dash && dash.video && dash.video.length) &&
        ((Array.isArray(durl) && durl.length) || (Array.isArray(durls) && durls.length)),
    };
  })()`;
}

/** 读当前累计（短，可反复调） */
const exprRead = `(() => {
  const P = window.__pgcProbe;
  if (!P) return { missing: true };
  const v = document.querySelector('video');
  const byHost = {};
  for (const m of P.media) {
    const key = m.host;
    const e = (byHost[key] ||= { host: key, n: 0, os: {} });
    e.n += 1;
    e.os[m.os || '(none)'] = (e.os[m.os || '(none)'] || 0) + 1;
  }
  const nav = (performance.getEntriesByType('navigation') || [])[0] || null;
  const pgc = window.__PLUMA_PGC__ ? {
    attached: window.__PLUMA_PGC__.attached === true,
    lastStage: window.__PLUMA_PGC__.lastStage || '',
    takeoverOk: window.__PLUMA_PGC__.takeoverOk || 0,
    cbHits: window.__PLUMA_PGC__.cbHits || 0,
    gateTimeouts: window.__PLUMA_PGC__.gateTimeouts || 0,
    injectedFrom: window.__PLUMA_PGC__.injectedFrom,
    injectedTo: window.__PLUMA_PGC__.injectedTo,
    ssAt: window.__PLUMA_PGC__.ssAt,
    patchedAt: window.__PLUMA_PGC__.patchedAt,
    createPlayerAt: window.__PLUMA_PGC__.createPlayerAt,
    patchedInSetter: window.__PLUMA_PGC__.patchedInSetter,
    ssHit: window.__PLUMA_PGC__.ssHit,
    cacheBytes: window.__PLUMA_PGC__.cacheBytes,
  } : null;
  return {
    at: Math.round(performance.now()),
    navResponseEnd: nav ? Math.round(nav.responseEnd) : null,
    n: P.media.length,
    byHost: Object.values(byHost).sort((a, b) => b.n - a.n),
    stats: P.stats.slice(),
    patches: P.patches.length,
    pgcMsgs: P.pgcMsgs.slice(-12),
    pgc,
    video: v ? { t: +v.currentTime.toFixed(2), paused: v.paused, rs: v.readyState,
      h: v.videoHeight, w: v.videoWidth, dur: Number.isFinite(v.duration) ? +v.duration.toFixed(1) : null,
      err: v.error ? v.error.code : null } : null,
    media: P.media.slice(),
  };
})()`;

/** 强制最高画质（PGC 的菜单项文案是「4K」/「1080P 高码率」等） */
const exprForceMax = `(() => {
  const cur = window.player && window.player.getQuality ? window.player.getQuality() : null;
  const items = Array.from(document.querySelectorAll('.bpx-player-ctrl-quality-menu-item'));
  const pick = items.find((e) => (e.textContent || '').trim() === '4K')
    || items[0];
  if (!pick) return { clicked: false, cur, items: items.map((e) => (e.textContent || '').trim()) };
  pick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return { clicked: true, before: cur, label: (pick.textContent || '').trim() };
})()`;

const exprPlay = `(() => {
  const v = document.querySelector('video');
  if (!v) return { noVideo: true };
  const p = v.play();
  if (p && p.catch) p.catch(() => {});
  return { t: +v.currentTime.toFixed(2), paused: v.paused };
})()`;

/** 逼播放器重发 playurl：只有 disconnect → connect 才会重发（换画质不会） */
const exprForcePlayurl = `(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  try { window.player.disconnect(); } catch (e) {}
  await s(800);
  try { window.player.connect(); } catch (e) {}
  await s(2500);
  const P = window.__pgcProbe;
  return { stats: P ? P.stats.slice() : [], forced: true };
})()`;

/**
 * 读**扩展自己的**加载快照 —— `filter` 状态的权威来源。
 *
 * ## 为什么不能用「页面听 `pcdn-filter-stats`」那一条代替
 *
 * 主世界的 `pcdn-filter-stats` 在**取流那一刻**发（`pgcFetch` 接管路径实测
 * 在 `createPlayerAt+…`，约页面 750ms~2s）。而探针是在 `tab create` 之后才注入的
 * —— 首波那条消息**必然错过**，于是 `stats: []`。上一轮 UGC 的 `applied=false`
 * 假阴性就是这个。
 *
 * `loading-trace.ts` 的采集器是 `document_start` 装的、把主世界每条上报**累加**
 * 进模块状态，再由 `content.ts` 在 `loading-snapshot` 消息里整份回包。
 * 所以问它拿到的是**累计值**，不受探针注入时间影响。
 *
 * ## 协议
 *
 * 发 `{__ns:'__PLUMA__', type:'loading-snapshot'}`，收回
 * `{__ns:'__PLUMA__', type:'loading-snapshot-reply', snapshot:{…}}`。
 * 两份实现必须同源：`panel-data.ts::fetchLoadingSnapshotViaPage()`。
 */
const exprExtSnapshot = `(() => new Promise((resolve) => {
  const NS = '__PLUMA__';
  let done = false;
  const finish = (v) => { if (done) return; done = true;
    window.removeEventListener('message', on); clearTimeout(timer); resolve(v); };
  const on = (ev) => {
    const d = ev.data;
    if (!d || d.__ns !== NS || d.type !== 'loading-snapshot-reply') return;
    finish({ ok: true, snapshot: d.snapshot || null });
  };
  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 3000);
  window.addEventListener('message', on);
  window.postMessage({ __ns: NS, type: 'loading-snapshot' }, '*');
}))()`;

/** 取扩展快照里与本轮相关的字段（原样回传太多，挑出来） */
function summarizeExtSnapshot(r) {
  if (!r || !r.ok || !r.snapshot) return { ok: false, reason: (r && r.reason) || 'no-snapshot' };
  const s = r.snapshot;
  const f = s.filter || {};
  return {
    ok: true,
    filter: {
      applied: f.applied === true,
      rewritten: f.rewritten || 0,
      proxied: f.proxied || 0,
      fallbackKept: f.fallbackKept || 0,
      reason: f.reason || null,
    },
    hosts: (s.hosts || []).map((h) => ({ host: h.host, cls: h.cls, flavor: h.flavor || null, n: h.count })),
    hostCount: s.hostCount ?? (s.hosts || []).length,
    hostsTruncated: s.hostsTruncated === true,
    eventsN: Array.isArray(s.events) ? s.events.length : 0,
    eventsLostBeforeWindow: s.eventsLostBeforeWindow === true,
    confidence: s.confidence || null,
    present: s.present === true,
    video: s.video || null,
    stages: Array.isArray(s.events)
      ? [...new Set(s.events.map((e) => e.stage))].sort()
      : [],
  };
}

/**
 * 点「下一集」触发 SPA 切集，走 `/ogv/player/playview`。
 *
 * ## 为什么需要这一步才能拿到 `pcdn-filter-stats`
 *
 * PGC 的三处 `filterDashOf()` 调用点**全部发生在探针装上之前**：
 * - `playinfo`（`__playinfo__` setter 注入，实测 ssAt ≈ 700–900ms）
 * - `playurl`（`pgcFetch` 回调接管，`createPlayerAt` ≈ 665–768ms）
 *
 * 而 `bsk evaluate` 只能 `tab create` 之后再注入 —— 那时首屏早已跑完
 * （实测三次都是 `stats: 0`）。`disconnect/connect` 也补不回来：
 * `pgcGateProxy` 只挂在 `createPlayer` 的 `requestConfig` 上，重连不会重调它。
 *
 * **SPA 切集是唯一在探针之后仍会触发过滤的路径**（`pgcSwapPlayviewBody`）。
 * 于是这一步同时回答两个问题：
 * ① 扩展此刻的 `filter` 状态到底是什么（`applied` / `rewritten` / `where`）；
 * ② 切集这条路上的候选也被改写了吗（此前只在 UGC 上验过 SPA，PGC 没验）。
 *
 * ⚠️ 切集会换 cid — 所以必须在本集的采样、读数**全部完成之后**才执行。
 */
const exprTriggerPlayview = `(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const before = window.__pgcProbe ? window.__pgcProbe.stats.length : 0;
  const beforeCid = (() => {
    try {
      const p = window.__playinfo__;
      const i = p && p.result ? p : (p && p.data && p.data.result ? p.data : null);
      const r = i && i.result ? i.result : null;
      return r && r.arc && r.arc.cid ? String(r.arc.cid) : null;
    } catch (e) { return null; }
  })();
  const btns = Array.from(document.querySelectorAll(
    '.bpx-player-ctrl-next, .squ-area-header .next, [aria-label="下一集"], .bilibili-player-video-btn-next',
  ));
  let clicked = false;
  if (btns.length) {
    try { btns[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); clicked = true; } catch (e) {}
  }
  if (!clicked) {
    const link = Array.from(document.querySelectorAll('a[href*="/bangumi/play/ep"]'))
      .find((a) => a.href && !a.href.endsWith(location.pathname));
    if (link) { try { link.click(); clicked = true; } catch (e) {} }
  }
  await s(6000);
  const afterCid = (() => {
    try {
      const p = window.__playinfo__;
      const i = p && p.result ? p : (p && p.data && p.data.result ? p.data : null);
      const r = i && i.result ? i.result : null;
      return r && r.arc && r.arc.cid ? String(r.arc.cid) : null;
    } catch (e) { return null; }
  })();
  const P = window.__pgcProbe;
  const stats = P ? P.stats.slice() : [];
  return {
    clicked, beforeCid, afterCid, cidChanged: beforeCid !== afterCid,
    newStats: stats.slice(before), allStats: stats,
    url: location.pathname,
  };
})()`;

/**
 * 从页面侧的 `__playviewProbe` 里读「切集后新出现的分片」——
 * 用来判断切集路上的候选有没有被改写（判据同首屏：host 换了、query 没换）。
 */
const exprPlayviewMedia = `(() => {
  const P = window.__pgcProbe;
  if (!P) return { missing: true };
  return { media: P.media.slice() };
})()`;

// ───────────────────── 汇总 ─────────────────────

function classifyCands(cands) {
  const tally = { official: 0, pcdn: 0, 'third-party': 0, unknown: 0 };
  const hosts = new Map();
  for (const c of cands) {
    const cls = classifyCdn(c.host, c.search).cls;
    tally[cls] += 1;
    if (cls === 'pcdn') {
      const k = `${c.host} | os=${c.os || '(none)'}`;
      hosts.set(k, (hosts.get(k) || 0) + 1);
    }
  }
  return { tally, hosts: [...hosts.entries()], n: cands.length };
}

function summarizeRaw(raw) {
  if (!raw || raw.err) return { err: (raw && raw.err) || 'null', code: raw && raw.code };
  const all = [...(raw.video || []).flatMap((t) => t.cands), ...(raw.audio || []).flatMap((t) => t.cands),
    ...(raw.flac || []), ...((raw.dolby || []).flat())];
  const c = classifyCands(all);
  const perTrack = (raw.video || []).map((t) => {
    const tt = classifyCands(t.cands);
    return { h: t.h, codecid: t.codecid, n: t.cands.length, pcdn: tt.tally.pcdn,
      official: tt.tally.official, allPcdn: tt.tally.pcdn > 0 && tt.tally.official === 0 };
  });
  return {
    code: raw.code, ttfb: raw.ttfb, playVideoType: raw.playVideoType, isPreview: raw.isPreview,
    timelength: raw.timelength, quality: raw.quality,
    hasDash: raw.hasDash, dashDuration: raw.dashDuration, dashKeys: raw.dashKeys,
    resultKeys: raw.resultKeys,
    videoN: (raw.video || []).length, audioN: (raw.audio || []).length,
    flacN: raw.flac ? raw.flac.length : 'null', dolbyN: raw.dolby ? raw.dolby.length : 'null',
    durlShape: raw.durlShape, durlsShape: raw.durlsShape,
    durlSegs: raw.durlSegs, durlsSegs: raw.durlsSegs,
    durlsTotalMs: raw.durlsTotalMs, durlTotalMs: raw.durlTotalMs,
    dashAndDurl: raw.dashAndDurl,
    tally: c.tally, pcdnHosts: c.hosts, candTotal: c.n,
    perTrack, allPcdnTracks: perTrack.filter((t) => t.allPcdn).length,
    maxHeight: (raw.video || []).reduce((a, t) => Math.max(a, t.h || 0), 0),
  };
}

function summarizeMedia(media) {
  const byHost = new Map();
  for (const m of media) {
    if (!byHost.has(m.host)) byHost.set(m.host, { host: m.host, n: 0, cls: null, os: {} });
    const e = byHost.get(m.host);
    e.n += 1;
    e.os[m.os || '(none)'] = (e.os[m.os || '(none)'] || 0) + 1;
    if (e.cls === null) e.cls = classifyCdn(m.host, m.search).cls;
  }
  const rows = [...byHost.values()].map((h) => ({
    host: h.host, n: h.n, cls: h.cls, os: h.os,
    flavor: classifyCdn(h.host, '').flavor,
  })).sort((a, b) => b.n - a.n);
  const total = rows.reduce((a, r) => a + r.n, 0);
  const pcdn = rows.filter((r) => r.cls === 'pcdn').reduce((a, r) => a + r.n, 0);
  return {
    total, rows, pcdnN: pcdn,
    pcdnPct: total > 0 ? Math.round((pcdn / total) * 100) : null,
    hosts: rows.length,
  };
}

// ───────────────────── 单集 ─────────────────────

/**
 * 跑一集：装探针 → 读 SSR → 原生 fetch 原文 → 播 N 秒采分片 → 补抓统计。
 *
 * @param ep 集号（URL 里的 ep id）
 * @param switchOn 开关目标状态（只用于记录）
 */
function runEpisode(ep, switchOn) {
  process.stdout.write(`\n═══ ep${ep} ═══\n`);
  const tab = openPage(`https://www.bilibili.com/bangumi/play/ep${ep}`);
  const installedAt = Date.now();
  ev(exprInstall);

  // 等 SSR / 播放器出现
  let ssr = null;
  for (let i = 0; i < 15; i += 1) {
    ssr = ev(exprSsr);
    if (ssr && !ssr.err && ssr.cid) break;
    sleep(1000);
  }
  process.stdout.write(`  SSR: cid=${ssr && ssr.cid} dash=${ssr && ssr.hasDash} dur=${ssr && ssr.dashDuration}` +
    ` durl=${ssr && ssr.durlType} durls=${ssr && ssr.durlsType}\n`);

  const cid = ssr && ssr.cid ? String(ssr.cid) : null;
  // 原生 fetch 原文（服务端视角）
  const raw = cid ? ev(exprRaw(cid)) : { err: 'no cid' };
  const rawSum = summarizeRaw(raw);
  process.stdout.write(
    `  原文: code=${rawSum.code} dash=${rawSum.hasDash} video=${rawSum.videoN}` +
      ` · 候选 ${rawSum.candTotal} 分类 ${JSON.stringify(rawSum.tally)}` +
      ` · PCDN host ${(rawSum.pcdnHosts || []).length}`,
  );
  process.stdout.write(
    `\n  durl/durls: durl=${rawSum.durlShape} durls=${rawSum.durlsShape}` +
      ` segs=${rawSum.durlSegs}/${rawSum.durlsSegs} dashAndDurl=${rawSum.dashAndDurl}` +
      ` | 全 PCDN 轨 ${rawSum.allPcdnTracks} / ${rawSum.videoN}\n`,
  );
  for (const [h, n] of rawSum.pcdnHosts || []) process.stdout.write(`    PCDN ← ${h} ×${n}\n`);

  // 强制最高画质 + 播
  sleep(1500);
  const q = ev(exprForceMax);
  process.stdout.write(`  画质: ${JSON.stringify(q)}\n`);
  ev(exprPlay);

  // 播放窗口
  const start = Date.now();
  let mid = null;
  while (Date.now() - start < SECONDS * 1000) {
    sleep(5000);
    if (!mid) {
      mid = ev(exprRead);
      if (mid && mid.video) {
        process.stdout.write(`    t=${mid.video.t}s rs=${mid.video.rs} h=${mid.video.h} 分片=${mid.n}\n`);
      }
    }
  }

  let r = ev(exprRead);
  /**
   * **权威读数**：问扩展采集器要累计的 `filter` 状态。
   *
   * 页面侧 `pcdn-filter-stats` 监听器装得太晚（`tab create` 之后），
   * 首波那条必然错过 —— `stats: []` 只是"没听到"，**不是**"没过滤"。
   * 上一轮 UGC 的 `applied=false` 假阴性就是这个。
   */
  let ext = null;
  try {
    ext = summarizeExtSnapshot(ev(exprExtSnapshot));
  } catch (e) {
    ext = { ok: false, reason: 'probe-error: ' + String(e.message).slice(0, 80) };
  }
  process.stdout.write(
    `  扩展快照: ${ext.ok
      ? `filter applied=${ext.filter.applied} rewritten=${ext.filter.rewritten} ` +
        `proxied=${ext.filter.proxied} fallbackKept=${ext.filter.fallbackKept}` +
        ` reason=${ext.filter.reason || '-'} · host ${ext.hostCount} · 事件 ${ext.eventsN}`
      : '未应答（' + ext.reason + '）'}\n`,
  );

  // 一条统计都没抓到 → 逼播放器重发一次 playurl 补抓闸门（否则 applied 会假阴性）
  let forced = null;
  let playview = null;
  /**
   * 补抓判据：**页面侧没听到** 且 **扩展快照也没记到 applied** 才算"真没有"。
   * 只看页面侧会把"探针装晚了"误判成"没过滤"。
   */
  const noEvidence = (!r || !r.stats || r.stats.length === 0) && !(ext && ext.ok && ext.filter.applied);
  if (noEvidence) {
    process.stdout.write('  两侧都没有过滤记录，逼播放器重发 playurl 再问一次 …\n');
    forced = ev(exprForcePlayurl);
    sleep(6000);
    r = ev(exprRead);
    try {
      ext = summarizeExtSnapshot(ev(exprExtSnapshot));
    } catch {
      /* 保持上一份 */
    }
  }
  /**
   * 仍然没有 → 走 **SPA 切集**（`/ogv/player/playview`）。
   *
   * 这是探针装上之后**唯一**还会触发 `filterDashOf()` 的路径：
   * 另外两处（`playinfo` 注入、`playurl` 回调接管）都在首屏 ~700–900ms 就跑完了，
   * 而 `bsk evaluate` 只能 `tab create` 之后再注入 —— 结构性赶不上。
   */
  if (noEvidence && !(ext && ext.ok && ext.filter.applied)) {
    process.stdout.write('  重连仍未触发。改走 SPA 切集（playview）补抓 …\n');
    playview = ev(exprTriggerPlayview);
    sleep(1000);
    r = ev(exprRead);
    try {
      ext = summarizeExtSnapshot(ev(exprExtSnapshot));
    } catch {
      /* 保持上一份 */
    }
  }

  const mediaSum = summarizeMedia((r && r.media) || []);
  process.stdout.write(
    `  实播分片 ${mediaSum.total} 条 · ${mediaSum.hosts} 个 host · PCDN ${mediaSum.pcdnN}` +
      ` (${mediaSum.pcdnPct === null ? 'n/a' : mediaSum.pcdnPct + '%'})\n`,
  );
  for (const row of mediaSum.rows) {
    process.stdout.write(`    ${row.host} ×${row.n} → ${row.cls}` +
      `${row.flavor ? '/' + row.flavor : ''} os=${JSON.stringify(row.os)}\n`);
  }
  const stats = (r && r.stats) || [];
  process.stdout.write(
    `  页面侧监听: ${stats.length} 条 pcdn-filter-stats` +
      `${stats.length ? ' · applied=' + stats.some((s) => s.applied) +
        ' · where=' + [...new Set(stats.map((s) => s.where))].join('/') +
        ' · rewritten=' + stats.reduce((a, s) => a + s.rewritten, 0) +
        ' · proxied=' + stats.reduce((a, s) => a + s.proxied, 0) +
        ' · fallbackKept=' + stats.reduce((a, s) => a + s.fallbackKept, 0) +
        ' · reason=' + ([...new Set(stats.map((s) => s.reason).filter(Boolean))].join('/') || '-') : ''}\n`,
  );
  if (r && r.pgc) {
    process.stdout.write(
      `  PGC 轨迹: attached=${r.pgc.attached} stage=${r.pgc.lastStage} cbHits=${r.pgc.cbHits}` +
        ` takeoverOk=${r.pgc.takeoverOk} injected ${r.pgc.injectedFrom}→${r.pgc.injectedTo}` +
        ` createPlayerAt=${r.pgc.createPlayerAt} ssHit=${r.pgc.ssHit}\n`,
    );
  }
  if (r && r.pgcMsgs && r.pgcMsgs.length) {
    for (const m of r.pgcMsgs.slice(-5)) {
      process.stdout.write(`    pgc ${m.stage}/${m.lastStage}: ${m.detail}\n`);
    }
  }

  const rec = {
    ep, cid, switchOn,
    installToNavEnd: null,
    ssr, rawSum, media: mediaSum,
    stats, ext, patches: r ? r.patches : null,
    pgc: r ? r.pgc : null, pgcMsgs: r ? r.pgcMsgs : [],
    video: r ? r.video : null,
    forcedStats: forced ? forced.stats : null,
    playview: playview || null,
    /**
     * 实际请求 ↔ playurl 候选的逐条对账（`reconcile()`，2026-11-18 本轮加）。
     *
     * 这是「扩展到底有没有改写」的**唯一硬证据**：`pcdn-filter-stats`
     * 在首屏 ~700ms 就发出去了，而 `bsk evaluate` 只能 `tab create` 之后注入 ——
     * 结构性赶不上（实测三次全是 `stats: 0`）。
     * 但「同 path+search、host 被换掉」这个形态**无法伪造**：
     * 签名 query 绑路径且带过期时间，播放器自己不可能凭空生成。
     */
    reconcile: reconcile(raw, (r && r.media) || []),
    /** 原始候选逐条留着（`mcdn-attribution.mjs` 要从这里取现场签名 URL） */
    rawCandidates: raw && !raw.err ? {
      video: raw.video, audio: raw.audio, flac: raw.flac, dolby: raw.dolby,
    } : null,
    /**
     * ⚠️ **必须保留 `path` + `search`**（2026-11-18 本轮补）。
     *
     * 只留 `host/os/t` 时无法回答最关键的那个问题：**
     * 「实际请求的 URL 与 playurl 候选是不是逐字相同、只换了 authority？」
     * —— 那正是 `rewriteOne()` 的唯一动作（ADR 0039 边界 1），
     * 也是判断「扩展到底有没有改写成功」的唯一硬证据
     * （`pcdn-filter-stats` 在首屏就发出去了，探针装得比它晚，抓不到）。
     */
    mediaSeq: ((r && r.media) || []).map((m) => ({
      host: m.host, os: m.os, t: m.t, path: m.path, search: m.search,
    })),
    runSeconds: Math.round((Date.now() - installedAt) / 1000),
  };
  process.stdout.write(`  本轮耗时 ${rec.runSeconds}s\n`);
  if (agentTabs().length > 1) closeTab(tab.tab);
  sleep(800);
  return rec;
}

// ───────────────────── 主流程 ─────────────────────

/**
 * 跨集对账：**实际请求的 URL 与 playurl 候选是不是逐字相同、只换了 authority？**
 *
 * 这是判断「扩展有没有真的改写」的唯一硬证据，比 `pcdn-filter-stats` 更可靠 ——
 * 后者在首屏 ~700ms 就发出去了，而探针只能 `tab create` 之后装，结构性赶不上
 * （实测三次都是 `stats: 0`）。
 *
 * 判据（与 `rewriteOne()` 的动作逐字对应）：
 * - `pathname + search` **逐字相同** ⇒ 同一个签名 URL；
 * - 只有 `host` 变了 ⇒ **就是改写**（签名 query 无法凭空重新生成）。
 *
 * 同时给出反向证据：若 observed 的 host 在 raw 候选里**从未出现**，
 * 那它不是改写产物，是播放器自己换了线路（PCDN 重新分配）。
 *
 * @param raw `exprRaw` 的原始返回（含 video/audio/flac/dolby 的逐条候选）
 * @param media 页面采到的分片（含 path/search）
 */
function reconcile(raw, media) {
  const cands = [];
  if (raw && !raw.err) {
    for (const t of raw.video || []) for (const c of t.cands || []) cands.push({ ...c, kind: 'video' });
    for (const t of raw.audio || []) for (const c of t.cands || []) cands.push({ ...c, kind: 'audio' });
    for (const c of raw.flac || []) cands.push({ ...c, kind: 'flac' });
    for (const arr of raw.dolby || []) for (const c of arr || []) cands.push({ ...c, kind: 'dolby' });
  }
  const byPath = new Map();
  for (const c of cands) {
    const key = (c.path || '') + (c.search || '');
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push({ host: c.host, os: c.os, kind: c.kind });
  }

  const rawHosts = new Set(cands.map((c) => c.host));
  const rows = [];
  let exactPathSameHost = 0;
  let exactPathHostChanged = 0;
  let notInRaw = 0;
  const rewriteSamples = [];
  const foreignHosts = new Map();

  for (const m of media || []) {
    const key = (m.path || '') + (m.search || '');
    const hits = byPath.get(key);
    if (!hits) {
      notInRaw += 1;
      foreignHosts.set(m.host, (foreignHosts.get(m.host) || 0) + 1);
      continue;
    }
    const sameHost = hits.some((h) => h.host === m.host);
    if (sameHost) {
      exactPathSameHost += 1;
    } else {
      exactPathHostChanged += 1;
      if (rewriteSamples.length < 6) {
        rewriteSamples.push({
          observedHost: m.host, observedOs: m.os,
          rawHosts: [...new Set(hits.map((h) => h.host))],
          rawOs: [...new Set(hits.map((h) => h.os))],
        });
      }
    }
    rows.push({ host: m.host, os: m.os, matched: true });
  }

  return {
    mediaTotal: (media || []).length,
    candTotal: cands.length,
    exactPathSameHost,
    exactPathHostChanged,
    notInRaw,
    /** `true` ⇒ **实锤改写过**：同 path+search、host 被换掉 */
    rewriteProven: exactPathHostChanged > 0,
    rewriteSamples,
    foreignHosts: [...foreignHosts.entries()].map(([host, n]) => ({
      host, n, inRawCandidates: rawHosts.has(host),
    })),
    rawHostSet: [...rawHosts],
  };
}

function main() {
  const result = {
    at: new Date().toISOString(),
    build: readBuildInfo(),
    episodes: [],
    switchState: null,
  };

  ensureSession();

  if (!SKIP_SWITCH) {
    ensureControlTab();
    process.stdout.write('拨开关到 ON …\n');
    const sw = setSwitch(true);
    result.switchState = sw;
    process.stdout.write(`  开关已确认：checked=${sw.read}\n    ${sw.line}\n`);
    sleep(1200);
  }

  for (const ep of EPS) {
    try {
      result.episodes.push(runEpisode(ep, true));
    } catch (e) {
      process.stdout.write(`  ✗ ep${ep} 失败：${String(e.message).slice(0, 200)}\n`);
      result.episodes.push({ ep, err: String(e.message).slice(0, 300) });
      cached = null;
      try {
        ensureControlTab();
      } catch {
        /* ignore */
      }
    }
  }

  // ── 汇总表 ──
  process.stdout.write('\n\n══════════ 汇总 ══════════\n');
  for (const r of result.episodes) {
    if (r.err) {
      process.stdout.write(`ep${r.ep}: 失败 ${r.err}\n`);
      continue;
    }
    const rawT = r.rawSum && r.rawSum.tally ? r.rawSum.tally : {};
    /**
     * `applied` 以**扩展快照**为准；页面侧监听只作旁证（它结构性地会错过首波）。
     * 两者都取不到时写 `null`（"没证据"），**不写 false** —— 那会被读成"确实没过滤"。
     */
    const pageApplied = (r.stats || []).some((s) => s.applied === true);
    const extApplied = r.ext && r.ext.ok ? r.ext.filter.applied === true : null;
    const applied = extApplied === null ? (pageApplied || null) : extApplied;
    const rewritten = (r.stats || []).reduce((a, s) => a + s.rewritten, 0) ||
      (r.ext && r.ext.ok ? r.ext.filter.rewritten : 0);
    process.stdout.write(
      `ep${r.ep}: 原文 PCDN ${rawT.pcdn || 0}/${r.rawSum.candTotal || 0} 候选` +
        ` | durls=${r.rawSum.durlsShape}` +
        ` | 实播 PCDN ${r.media.pcdnN}/${r.media.total} (${r.media.pcdnPct}%)` +
        ` | applied=${applied} rewritten=${rewritten}` +
        ` | 改写实锤=${r.reconcile ? r.reconcile.rewriteProven : 'n/a'}` +
        ` (同path换host ${r.reconcile ? r.reconcile.exactPathHostChanged : '?'}` +
        ` / 同path同host ${r.reconcile ? r.reconcile.exactPathSameHost : '?'}` +
        ` / 不在候选里 ${r.reconcile ? r.reconcile.notInRaw : '?'})\n`,
    );
  }

  /**
   * PCDN 分配是**服务端按时段/负载动态决策**，不是视频固有属性。
   *
   * 本轮实测到两次相反的结果（同 3 集、同版本构建）：
   * - 20:38 那轮：每集原文 16~19 条 PCDN 候选、实播 32~35% 走 PCDN
   * - 21:00 那轮：原文 **0** 条 PCDN 候选、实播 0%（全 bcache）
   * 所以"这一轮没测到"**不能**写成"番剧不走 PCDN"。
   */
  const totalPcdn = result.episodes.reduce(
    (a, r) => a + (r.rawSum && r.rawSum.tally ? r.rawSum.tally.pcdn || 0 : 0),
    0,
  );
  process.stdout.write(
    totalPcdn === 0
      ? '\n⚠️ 本轮三集原文候选里 **0 条 PCDN** —— 服务端此刻没分配。' +
          '这**不是**"番剧不走 PCDN"，是样本无效，结论只能写"该时段未分配"。\n'
      : `\n本轮 PCDN 候选合计 ${totalPcdn} 条 —— 样本有效。\n`,
  );

  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`\n已写出 ${OUT}\n`);
}

/** 记录本轮测的是哪一版构建（构建可能早于工作区 HEAD） */
function readBuildInfo() {
  const info = { builtAt: null, version: null, head: null, hasFlacDolbyFix: null };
  try {
    const mf = path.join(process.cwd(), '.output/chrome-mv3/manifest.json');
    if (existsSync(mf)) {
      const m = JSON.parse(readFileSync(mf, 'utf8'));
      info.version = m.version || null;
    }
    const mh = path.join(process.cwd(), '.output/chrome-mv3/content-scripts/main-hook.js');
    if (existsSync(mh)) {
      info.builtAt = execFileSync('stat', ['-c', '%y', mh], { encoding: 'utf8' }).trim();
      const src = readFileSync(mh, 'utf8');
      // f56f1e6 引入了 `dolbyHolder` / `nextDolby` 这类标识；压缩后仍在
      info.hasFlacDolbyFix = /dolbyHolder|nextDolby/.test(src) || /\bflacHolder\b/.test(src);
    }
  } catch {
    /* 读不到就留 null */
  }
  try {
    info.head = execFileSync('git', ['log', '-1', '--format=%h %ci %s'], { encoding: 'utf8' }).trim();
  } catch {
    /* ignore */
  }
  return info;
}

main();