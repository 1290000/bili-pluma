/**
 * 单视频 4K A/B（`BV17osu6pEP9`，3 次交错取中位数）—— 2026-11-17 最后一轮。
 *
 * ## 为什么重做（上一轮三个致命缺陷，全部已定位）
 *
 * 1. **两 r 画质不同**：A 组 `realQ=112`(1080p)、B 组 `realQ=120`(4K) → 内容不同，不可比；
 * 2. **B 组开关其实没开**：两组 `stats` 全空 → 测的是"两次都关着"；
 * 3. **样本没有 PCDN 流量**：A 组 102 条全在 `cn-cq-gd-bcache-19`。
 *
 * 用户截图给的真实基线（4K、PCDN、起播 9.69s，其中 **6.86s 是无分片请求的空档**）说明：
 * 开关的收益可能不只是"少占上行"，而是**缩短起播** —— 那个空档很可能是 PCDN 重试/等超时。
 *
 * ## 设计（严格照主理人的口径）
 *
 * | 项 | 做法 |
 * | --- | --- |
 * | 样本 | 只 `BV17osu6pEP9`，画质**锁死 4K**（`qn=120`） |
 * | 次数 | `A1 B1 A2 B2 A3 B3` 六次交错 |
 * | 时长 | 每次 **60 秒**（看起播，不看长时稳定性） |
 * | 每次 | 新页面 → 强制 4K 并**校验 3840×2160** → 拨开关并**读回** → 采 60s |
 *
 * ## 四条闸门（不过就作废并重跑该组）
 *
 * 1. 分辨率不是 4K（`videoWidth×videoHeight` 不 ≈3840×2160）→ 作废；
 * 2. 开关读回值 ≠ 目标 → 作废（并且这里直接抛错，不许硬跑）；
 * 3. **A 组 `pcdn` 条数 = 0 → 作废**（没 PCDN 就测不出差别，这是上一轮的死因）；
 * 4. B 组 `pcdn` 条数 > 0 → **记录为"过滤失败"**（重要发现，不是作废）。
 *
 * ## 两个精度上的关键决定
 *
 * - **分片时刻用 `PerformanceObserver({buffered:true})`**：它会把**装载前**已经发生的
 *   resource 条目一并吐出来，`startTime` 是精确的，不受后台标签页定时器节流影响；
 * - **"可以播放"时刻用事件监听**（`canplay` / `playing` / `loadeddata`）：事件不受节流，
 *   比 `setInterval` 采样精确（上一轮 `实播=null` 就是定时器被节流到 ~1 次/分钟）。
 *
 * ## 指标定义（与截图对账用）
 *
 * - `ready4kAt`：**首次同时满足 `readyState>=3` 且 `videoHeight>=2160`** 的时刻（相对导航），
 *   对齐截图里的"可以播放 9.67s"。设画质要重缓冲，那段也算进去 —— 两组同样算法，可比。
 * - `firstSegT`：第一条分片请求的 `startTime`（截图 1.50s）。
 * - `gapS` = `ready4kAt` − 「ready 之前最后一条分片请求的时刻」（截图的 6.86s）。
 *
 * 用法：
 *
 * ```bash
 * npx tsx poc/probe/pcdn-diag/pcdn-4k-ab.mjs
 * npx tsx poc/probe/pcdn-diag/pcdn-4k-ab.mjs --rounds 1      # 冒烟：每组件 1 次
 * ```
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

const BVID = 'BV17osu6pEP9';
const ROUNDS = (() => {
  const i = process.argv.indexOf('--rounds');
  return i >= 0 ? Number(process.argv[i + 1]) : 3;
})();
const RUN_SECONDS = 60;

const OUT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  'pcdn-4k-ab.json',
);

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
  for (let i = 0; i < 4; i += 1) {
    try {
      const s = bsk(['sync', '--json'], { json: true });
      cached = { session: s.session_id, tab: s.tab_id, ctx: s.ctx };
      return cached;
    } catch (e) {
      last = e;
      try {
        bsk(['wait-ms', '1800']);
      } catch {
        /* ignore */
      }
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
      const parsed = JSON.parse(out.slice(out.indexOf('{')));
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

function ensureSession() {
  try {
    if (agentTabs().length > 0) return current();
  } catch {
    /* 落下去重建 */
  }
  try {
    bsk(['close']);
  } catch {
    /* ignore */
  }
  cached = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '60']);
      cached = null;
      return current();
    } catch {
      /* retry */
    }
  }
  throw new Error('无法建立 bsk 会话');
}

/** 新标签页加载页面（run 页专用；控制页常驻，见 REPORT-ab-filter.md §5） */
function openPage(url) {
  ensureSession();
  const cur = current();
  const created = bsk(
    ['tab', 'create', '--url', url, '--session', cur.session, '--context', cur.ctx,
     '--expect', '[{"target":"body","field":"exists","equals":true}]', '--json'],
    { json: true },
  );
  const tabId = Number(created.tab_id);
  const s = bsk(['sync', '--json'], { json: true });
  cached = { session: s.session_id, tab: tabId, ctx: s.ctx };
  return cached;
}

function closeTab(tabId) {
  try {
    bsk(['tab', 'close', String(tabId), '--json']);
  } catch {
    /* ignore */
  }
  cached = null;
}

// ───────────────────── 开关（面板 VOM，closed shadow 只能 ref） ─────────────────────

/**
 * 按「角色 + 引号内文案」精确找控件。
 *
 * ⚠️ 不能只 `includes(label)`：VOM 每个控件的 `[ctx: …]` 会重复**整页文案**，
 * 于是「页内角标」那行也含「屏蔽 PCDN 线路」—— 上一轮因此点错开关（误关了用户的角标）。
 */
function findByRole(role, label) {
  /**
   * ⚠️ `snapshot` 在**持续变化**的页面上会失败：
   * `observation ref was not found for this tab / Document changed during observation`。
   * 实测 B站 视频页几乎每次都会撞上（弹幕、推荐位、播放器都在动），所以必须重试。
   */
  let text = '';
  for (let i = 0; i < 4; i += 1) {
    try {
      text = bsk(['snapshot']);
      break;
    } catch (e) {
      if (i === 3) throw new Error(`snapshot 连续 4 次失败：${String(e.message || e).slice(0, 100)}`);
      sleep(600);
    }
  }
  const pat = new RegExp(`(@e\\d+)\\s+${role}\\s+"${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  for (const line of text.split('\n')) {
    const m = pat.exec(line);
    if (m) return { ref: m[1], checked: role === 'checkbox' ? /\[checked\]/.test(line) : null };
  }
  return null;
}

function clickRef(ref) {
  cached = null; // 每次点击都重新 sync：面板一开控制状态就变，缓存 ctx 必失败
  const cur = current();
  try {
    bsk([
      'click', '--context', cur.ctx,
      '--expect', JSON.stringify([{ target: ref, field: 'exists', equals: true }]),
      ref, '--json',
    ]);
    return { code: 'ok' };
  } catch (e) {
    const msg = String(e.message || e);
    return { code: (msg.match(/"code": "([^"]+)"/) || [])[1] || 'error' };
  } finally {
    cached = null;
  }
}

/**
 * 拨「屏蔽 PCDN 线路」到目标状态，**并读回确认**。
 *
 * 读回 ≠ 目标 ⇒ 抛错（主理人口径：不许继续）。开关在「显示」页，不在「画质」页。
 *
 * @param want true = 开（B 组），false = 关（A 组）
 */
function setSwitch(want) {
  for (let i = 0; i < 10; i += 1) {
    let ctl = findByRole('checkbox', '屏蔽 PCDN');
    if (!ctl) {
      const entry = findByRole('button', '打开 Pluma 面板');
      if (entry) {
        clickRef(entry.ref);
        sleep(900);
      }
      ctl = findByRole('checkbox', '屏蔽 PCDN');
    }
    if (!ctl) {
      const tab = findByRole('tab', '显示');
      if (tab) {
        clickRef(tab.ref);
        sleep(700);
        ctl = findByRole('checkbox', '屏蔽 PCDN');
      }
    }
    if (!ctl) continue;
    if (ctl.checked === want) return { ok: true, read: ctl.checked };
    clickRef(ctl.ref);
    sleep(900);
    const after = findByRole('checkbox', '屏蔽 PCDN');
    if (after && after.checked === want) return { ok: true, read: after.checked };
  }
  const last = findByRole('checkbox', '屏蔽 PCDN');
  return { ok: false, read: last ? last.checked : null };
}

// ───────────────────── 页面侧探针 ─────────────────────

/**
 * 装探针：分片 resource（`buffered:true` ⇒ 装载前的也算）+ 媒体事件 + 过滤统计。
 *
 * 装得越早越好：`tab create` 之后第一件事就是它。漏掉的事件用"读取时补一次"
 * （`exprPoll` 会不断刷新 `readyState`/`videoHeight` 的快照）。
 */
const exprInstall = `(() => {
  const KEY = '__ab4k';
  if (window[KEY] && window[KEY].installed) return { reused: true };
  const P = (window[KEY] = { installed: true, media: [], events: [], stats: [],
    ready4kAt: null, pollAt: Math.round(performance.now()) });
  const MEDIA_RE = /bilivideo|mcdn|mountaintoys|akamaized|szbdyd|zhenidc/;
  const SEG_RE = /\\.(m4s|mp4|flv|ts)$/;

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        let u = null;
        try { u = new URL(e.name); } catch (x) { continue; }
        if (!MEDIA_RE.test(u.host)) continue;
        if (!SEG_RE.test(u.pathname)) continue;   // 只认分片，挡掉埋点的 query 里嵌 CDN
        P.media.push({ host: u.host, search: u.search, t: Math.round(e.startTime) });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { P.observerError = String(e); }

  const v0 = document.querySelector('video');
  if (v0) {
    for (const type of ['canplay', 'playing', 'loadeddata', 'waiting', 'stalled', 'error']) {
      v0.addEventListener(type, () => {
        const v = document.querySelector('video');
        P.events.push({ type, t: Math.round(performance.now()),
          rs: v ? v.readyState : null, h: v ? v.videoHeight : null });
      });
    }
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__ns !== '__PLUMA__' || d.type !== 'pcdn-filter-stats') return;
    P.stats.push({ applied: d.applied === true, removed: d.removed || 0,
      keptIntact: d.keptIntact || 0, where: d.where || null, reason: d.reason || null });
  });
  return { installed: true, hadVideo: !!v0 };
})()`;

/**
 * 轮询：把"首次 4K 可播"记成相对导航的毫秒数，并顺带挂上 video 事件（video 元素可能后建）。
 *
 * 由 Node 侧每隔 ~1.5 秒调一次 —— 单次很轻，不会饿死扩展心跳。
 */
const exprPoll = `(() => {
  const P = window.__ab4k;
  const v = document.querySelector('video');
  if (!v) return { noVideo: true };
  if (P.video !== v) {
    P.video = v;
    for (const type of ['canplay', 'playing', 'loadeddata', 'waiting', 'stalled', 'error']) {
      v.addEventListener(type, () => {
        P.events.push({ type, t: Math.round(performance.now()), rs: v.readyState, h: v.videoHeight });
      });
    }
  }
  if (P.ready4kAt === null && v.readyState >= 3 && v.videoHeight >= 2160) {
    P.ready4kAt = Math.round(performance.now());
  }
  return { ready4kAt: P.ready4kAt, w: v.videoWidth, h: v.videoHeight,
    rs: v.readyState, paused: v.paused, t: +v.currentTime.toFixed(2),
    dur: Number.isFinite(v.duration) ? +v.duration.toFixed(1) : null };
})()`;

/** 强制 4K（画质菜单在 DOM 里，JS 派发 click 比 bsk click 稳） */
const exprForce4k = `(() => {
  const v = document.querySelector('video');
  if (v && v.videoHeight >= 2160) return { already4k: true, h: v.videoHeight };
  const q = window.player && window.player.getQuality ? window.player.getQuality() : null;
  const items = Array.from(document.querySelectorAll('.bpx-player-ctrl-quality-menu-item'));
  const hit = items.find((e) => (e.textContent || '').trim().startsWith('4K'));
  if (!hit) return { clicked: false, q, menu: items.map((e) => (e.textContent || '').trim().slice(0, 10)) };
  hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return { clicked: true, text: (hit.textContent || '').trim().slice(0, 12), q };
})()`;

/** 播放（保活：后台标签页会暂停；**不静音**，静音会让媒体管线被挂起） */
const exprPlay = `(async () => {
  const v = document.querySelector('video');
  if (!v) return { noVideo: true };
  try { await v.play(); } catch (e) { return { playError: String(e).slice(0, 60) }; }
  return { t: +v.currentTime.toFixed(2), paused: v.paused, h: v.videoHeight };
})()`;

/** 读累计数据 */
const exprRead = `(() => {
  const P = window.__ab4k;
  if (!P) return { missing: true };
  const v = document.querySelector('video');
  const byHost = {};
  for (const m of P.media) {
    const h = (byHost[m.host] ||= { host: m.host, n: 0, search: m.search || '' });
    h.n += 1;
  }
  const ready = P.ready4kAt;
  const before = ready === null ? [] : P.media.filter((m) => m.t <= ready);
  const lastSegT = before.length ? Math.max(...before.map((m) => m.t)) : null;
  return {
    ready4kAt: ready,
    firstSegT: P.media.length ? Math.min(...P.media.map((m) => m.t)) : null,
    lastSegBeforeReadyT: lastSegT,
    media: P.media.slice(),
    hostsDetail: Object.values(byHost).sort((a, b) => b.n - a.n),
    events: P.events.slice(),
    stats: P.stats.slice(),
    stalls: P.events.filter((e) => e.type === 'waiting' || e.type === 'stalled').length,
    w: v ? v.videoWidth : null, h: v ? v.videoHeight : null,
    rs: v ? v.readyState : null, paused: v ? v.paused : null,
    ct: v ? +v.currentTime.toFixed(2) : null,
    dur: v ? (Number.isFinite(v.duration) ? +v.duration.toFixed(1) : null) : null,
  };
})()`;

// ───────────────────────── 单次 run ─────────────────────────

/**
 * 一次 run：新页面 → 强制 4K → 拨开关并读回 → 播 60 秒 → 收数据。
 *
 * @param group 'A'（开关关）| 'B'（开关开）
 * @param round 第几次（1..ROUNDS）
 */
function runOne(group, round) {
  /**
   * ⚠️ **开关必须在"控制页"上拨好，再开视频页**。
   *
   * 视频页的 VOM 一直在变（弹幕/推荐位/播放器），`bsk snapshot` 在那种页面上
   * 频繁报 `Document changed during observation`；而拨开关完全依赖 `snapshot`
   * 拿 ref。所以顺序是：控制页拨开关 + 读回确认 → **再** `tab create` 视频页。
   * 这也符合产品语义：开关是全局 storage，新页面加载时读到的就是新值。
   */
  const want = group === 'B';
  const sw = setSwitch(want);
  if (!sw.ok || sw.read !== want) {
    throw new Error(`开关读回 ${sw.read} ≠ 目标 ${want}（拨开关在控制页执行，可能面板没停在「显示」页）`);
  }
  const switchRead = sw.read;

  const tab = openPage(`https://www.bilibili.com/video/${BVID}/`);
  const startedAt = new Date().toISOString();
  ev(exprInstall);

  /** 轮询到出现 video，并把 ready4kAt 交给页面自己记 */
  let poll = null;
  for (let i = 0; i < 25; i += 1) {
    try {
      poll = ev(exprPoll);
    } catch {
      poll = null;
    }
    if (poll && !poll.noVideo) break;
    sleep(1200);
  }

  // 强制 4K（可能已经在 4K）
  const force = ev(exprForce4k);

  // 等 4K 真的可播（最多 40 秒）
  let ready = null;
  for (let i = 0; i < 30; i += 1) {
    ready = ev(exprPoll);
    if (ready && ready.ready4kAt !== null && ready.h >= 2160) break;
    // 还没到 4K 就补点一次菜单
    if (i === 6 || i === 14) ev(exprForce4k);
    sleep(1300);
  }

  // 播（保活 60 秒窗口）
  const deadline = Date.now() + RUN_SECONDS * 1000;
  let n = 0;
  while (Date.now() < deadline) {
    const p = ev(exprPoll);
    if (p && p.paused) {
      try {
        ev(exprPlay);
      } catch {
        /* ignore */
      }
    }
    if (n % 8 === 0) process.stdout.write(`    · ${group}${round} 采样 ${Math.round((deadline - Date.now()) / 1000)}s 剩余 · h=${p && p.h} rs=${p && p.rs} t=${p && p.t}\n`);
    n += 1;
    sleep(2500);
  }

  const snap = ev(exprRead);
  closeTab(tab.tab);
  return { bvid: BVID, group, round, startedAt, seconds: RUN_SECONDS, force, switchRead, ...snap };
}

// ───────────────────────── 汇总 ─────────────────────────

/**
 * 判一 r 的观测量与闸门。
 *
 * | 闸门 | 判据 |
 * | --- | --- |
 * | 分辨率 | `w/h` 必须 ≈3840×2160 |
 * | 开关 | A 组读到 false、B 组读到 true |
 * | A 组有 PCDN | A 组 pcdn 条数必须 > 0，否则"测不出差别"→ 作废 |
 * | B 组无 PCDN | B 组 pcdn > 0 → 记录为**过滤失败**（不算作废，是发现） |
 */
function judge(run) {
  const per = { pcdn: 0, official: 0, 'third-party': 0, unknown: 0 };
  for (const h of run.hostsDetail || []) {
    per[classifyCdn(h.host, h.search || undefined).cls] += h.n;
  }
  const total = Object.values(per).reduce((a, b) => a + b, 0);
  const is4k = run.w >= 3800 && run.h >= 2100;
  const switchOk = run.group === 'A' ? run.switchRead === false : run.switchRead === true;
  const stats = run.stats || [];
  const applied = stats.some((s) => s.applied === true);
  const removed = stats.reduce((a, s) => a + (s.removed || 0), 0);
  const gapS =
    run.ready4kAt !== null && run.lastSegBeforeReadyT !== null
      ? +((run.ready4kAt - run.lastSegBeforeReadyT) / 1000).toFixed(2)
      : null;

  const voidReasons = [];
  if (!is4k) voidReasons.push(`分辨率 ${run.w}x${run.h} 不是 4K`);
  if (!switchOk) voidReasons.push(`开关读回 ${run.switchRead} ≠ 目标`);
  if (run.group === 'A' && per.pcdn === 0) voidReasons.push('A 组 PCDN 条数 = 0（测不出差别）');
  if (run.group === 'B' && applied !== true) voidReasons.push('B 组 stats 无 applied:true');

  return {
    group: run.group,
    round: run.round,
    res: `${run.w}x${run.h}`,
    firstSegHost: run.media && run.media.length ? run.media[0].host : null,
    pcdn: per.pcdn,
    official: per.official,
    unknown: per.unknown,
    pcdnPct: total ? +((per.pcdn / total) * 100).toFixed(1) : null,
    readyS: run.ready4kAt === null ? null : +(run.ready4kAt / 1000).toFixed(2),
    firstSegS: run.firstSegT === null ? null : +(run.firstSegT / 1000).toFixed(2),
    gapS,
    stalls: run.stalls || 0,
    applied,
    removed,
    ok: voidReasons.length === 0,
    voidReasons,
    /** B 组还有 PCDN ⇒ 过滤失败（不是作废） */
    filterFailed: run.group === 'B' && per.pcdn > 0,
    requests: total,
  };
}

function median(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? +v[m].toFixed(2) : +((v[m - 1] + v[m]) / 2).toFixed(2);
}

function printTable(rows) {
  const line = (s) => process.stdout.write(`${s}\n`);
  line('');
  line('组 次 分辨率      首分片host                         PCDN条 官方条 起播s 首片s 空档s stall applied removed 判定');
  for (const r of rows) {
    line(
      `${r.group}  ${r.round}  ${String(r.res).padEnd(11)} ${String(r.firstSegHost || '—').padEnd(33)} ` +
        `${String(r.pcdn).padStart(5)} ${String(r.official).padStart(5)} ` +
        `${String(r.readyS).padStart(5)} ${String(r.firstSegS).padStart(5)} ${String(r.gapS).padStart(5)} ` +
        `${String(r.stalls).padStart(4)} ${String(r.applied).padStart(6)} ${String(r.removed).padStart(6)} ` +
        `${r.ok ? 'OK' : '作废：' + r.voidReasons.join('；')}${r.filterFailed ? '（过滤失败）' : ''}`,
    );
  }
  const A = rows.filter((r) => r.group === 'A' && r.ok);
  const B = rows.filter((r) => r.group === 'B' && r.ok);
  line('');
  line(`中位数（A 有效 ${A.length} / B 有效 ${B.length}）`);
  line(`  起播秒   A=${median(A.map((r) => r.readyS))}  B=${median(B.map((r) => r.readyS))}`);
  line(`  空档秒   A=${median(A.map((r) => r.gapS))}  B=${median(B.map((r) => r.gapS))}`);
  line(`  PCDN条   A=${median(A.map((r) => r.pcdn))}  B=${median(B.map((r) => r.pcdn))}`);
  line(`  PCDN%    A=${median(A.map((r) => r.pcdnPct))}  B=${median(B.map((r) => r.pcdnPct))}`);
  line(`  stall    A=${median(A.map((r) => r.stalls))}  B=${median(B.map((r) => r.stalls))}`);
}

// ───────────────────────── 主流程 ─────────────────────────

ensureSession();

const result = { at: new Date().toISOString(), bvid: BVID, rounds: ROUNDS, seconds: RUN_SECONDS, runs: [], rows: [] };
ensureSession();
// 先确认开关能读到（读不到就别白跑 6 次）
const probe = setSwitch(false);
process.stdout.write(`开关初始化为「关」：${JSON.stringify(probe)}\n`);
if (!probe.ok || probe.read !== false) {
  throw new Error(`开关读回 ${probe.read}，无法置为「关」—— 停止（面板可能不在「显示」页）`);
}

for (let round = 1; round <= ROUNDS; round += 1) {
  for (const group of ['A', 'B']) {
    process.stdout.write(`\n[${group}${round}] ${BVID} · ${RUN_SECONDS}s\n`);
    try {
      const run = runOne(group, round);
      result.runs.push(run);
      const row = judge(run);
      result.rows.push(row);
      process.stdout.write(
        `  → ${row.res} 首片=${row.firstSegHost} PCDN=${row.pcdn}/${row.requests} ` +
          `起播=${row.readyS}s 空档=${row.gapS}s applied=${row.applied} removed=${row.removed} ` +
          `${row.ok ? 'OK' : '**作废：' + row.voidReasons.join('；') + '**'}\n`,
      );
    } catch (e) {
      process.stdout.write(`  ✗ run 失败：${String(e.message || e).slice(0, 200)}\n`);
      result.rows.push({ group, round, ok: false, voidReasons: ['run 失败：' + String(e.message || e).slice(0, 120)] });
      cached = null;
    }
    writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8'); // 每 r 落盘
    sleep(1200);
  }
}

printTable(result.rows);
writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
process.stdout.write(`\n已写出 ${OUT}\n`);