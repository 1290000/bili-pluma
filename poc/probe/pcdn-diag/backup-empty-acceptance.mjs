/**
 * 「过滤后 `backup_url: []`，B站播放器还认这条轨吗？」（2026-11-17，批次 `pcdn-diag`）
 *
 * ## 为什么必须实测
 *
 * 候选过滤把 PCDN 剔掉之后，实测 **24 条 2160p 轨里有 15 条只剩 1 条官方候选**
 * ⇒ 那 15 条轨的 `backup_url` 会变成 `[]`。若播放器内部直取 `backupUrl[0]`，
 * 这条轨可能直接不播；更隐蔽的是**静默换到别的画质**（用户莫名掉到 1080p）。
 * ADR 0038 把这条列在「未定」第 2 项，本脚本就是还这笔账。
 *
 * ## 怎么把"改造后的响应"喂给真播放器
 *
 * `bsk` 0.5.0 没有 `Page.addScriptToEvaluateOnNewDocument`，装不上 document_start 钩子，
 * 而首屏 playurl 在页面加载 1.4 秒内就发了 —— 钩子赶不上。所以走第二条路：
 *
 * 1. 等页面正常播起来（**基线**）；
 * 2. 在页面上下文包一层 `XMLHttpRequest` —— 给 playurl 的**实例**装
 *    `responseText` / `response` 访问器，JSON 改完再吐出去
 *    （实测播放器那次请求 `responseType` 是空串，读的就是 `responseText`）；
 * 3. `player.disconnect()` → `player.connect()` 逼播放器**自己**再要一次 playurl，
 *    它拿到的就是改过的响应。
 *
 * ⚠️ 这套做法隐含一个前提：**重连后播放器用的是新响应**。不证明这一点，
 * 整个实验就是空的 ⇒ 所以有 **Run C（毒化对照）**：把目标轨的 `base_url` 换成
 * 必然解析不了的 host。若毒化后播放出问题，说明新响应确实被采用；若毒化后照样
 * 流畅播 2160p，说明播放器用的是旧 dash，本次结论只能标"说不清"。
 *
 * ## 三次运行（同一标签页、同一 document）
 *
 * | Run | 改造 | 看什么 |
 * | --- | --- | --- |
 * | A 基线 | 不改造 | `readyState` / `videoHeight` / 起播耗时（没有基线，"改完能播"说明不了任何事） |
 * | B 空备份 | 目标 2160p 轨 `backup_url = []` | 同上 + 该轨 base host 有没有真的发请求 + 有没有掉画质 |
 * | C 毒化 | 目标 2160p 轨 `base_url` → 不存在的 host | 证明"新响应被采用"，否则 B 无从解释 |
 *
 * ## ⚠️ 为什么采样要放在页面里、每次 evaluate 都很短
 *
 * 第一版把 `waitEnv + force4k + sample` 全塞进**一个** `evaluate`（阻塞 30–50 秒），
 * 结果 bsk daemon 报 `reaping unresponsive browser (no heartbeat within liveness window)`：
 * 长阻塞的 evaluate 把扩展的心跳饿死了，浏览器被判定失联、会话直接没了。
 * 所以现在：**页面里跑 `setInterval` 采样，Node 侧每 ~1.5 秒读一次**，单次 evaluate 都短。
 *
 * 用法：
 *
 * ```bash
 * npx tsx poc/probe/pcdn-diag/backup-empty-acceptance.mjs
 * ```
 *
 * 产出：stdout 六行报告 + `backup-empty-acceptance.json`（gitignored）。
 *
 * @see poc/probe/pcdn-diag/REPORT-backup-empty.md
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** 实测样本里挑一个：三条 2160p 轨的 base 全是官方域 */
const BVID = 'BV1oFsW6oEs5';

/** 页面里可复用的公共件（采样器 + 强制 4K），装一次即可 */
const PAGE_LIB = `
  window.__probe = window.__probe || {
    samples: [], media: [], t0: 0, t3: null, t4: null, firstMediaAt: null, timer: null, installed: false,
  };
  const P = window.__probe;
  const MEDIA_RE = /bilivideo|mcdn|mountaintoys|akamaized|szbdyd|zhenidc|qrstuvwxyzab/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__probeReset = () => {
    P.samples = []; P.media = []; P.t3 = null; P.t4 = null; P.firstMediaAt = null;
    P.t0 = Math.round(performance.now());
  };
  window.__probeStart = () => {
    window.__probeReset();
    if (!P.installed) {
      P.installed = true;
      P.timer = setInterval(() => {
        const v = document.querySelector('video');
        if (!v) return;
        const t = Math.round(performance.now());
        P.samples.push({ t, readyState: v.readyState, height: v.videoHeight, width: v.videoWidth,
          err: v.error ? v.error.code : null, paused: v.paused, currentTime: Math.round(v.currentTime) });
        if (v.readyState >= 3 && P.t3 === null) P.t3 = t;
        if (v.readyState === 4 && P.t4 === null) P.t4 = t;
      }, 100);
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            if (!MEDIA_RE.test(e.name)) continue;
            const t = Math.round(e.startTime);
            P.media.push({ name: e.name.split('?')[0], t });
            if (P.firstMediaAt === null || t < P.firstMediaAt) P.firstMediaAt = t;
          }
        }).observe({ type: 'resource', buffered: true });
      } catch (e) { P.observerError = String(e); }
    }
    return { t0: P.t0 };
  };
  window.__probeRead = () => {
    const v = document.querySelector('video');
    const last = P.samples[P.samples.length - 1] || null;
    const hosts = Array.from(new Set(P.media.map((m) => {
      try { return new URL('https://x/' + m.name.replace(/^https?:\\/\\//, '')).host; } catch (e) { return null; }
    }).filter(Boolean)));
    return {
      now: Math.round(performance.now()), t0: P.t0, t3: P.t3, t4: P.t4,
      firstMediaAt: P.firstMediaAt, samples: P.samples.length, last,
      mediaCount: P.media.length,
      mediaHosts: hosts.slice(0, 8),
      mediaAfterT0: P.media.filter((m) => m.t >= P.t0).length,
      hostsAfterT0: Array.from(new Set(P.media.filter((m) => m.t >= P.t0).map((m) => {
        try { return new URL('https://x/' + m.name.replace(/^https?:\\/\\//, '')).host; } catch (e) { return null; }
      }).filter(Boolean))),
      readyState: v ? v.readyState : null, height: v ? v.videoHeight : null,
      error: v && v.error ? { code: v.error.code, message: v.error.message } : null,
      quality: window.player && window.player.getQuality ? window.player.getQuality() : null,
      playUrlTail: (() => { try { return window.player.getMediaInfo().playUrl.split('?')[0].split('/').pop(); } catch (e) { return null; } })(),
      playUrlHost: (() => { try { return new URL(window.player.getMediaInfo().playUrl).host; } catch (e) { return null; } })(),
    };
  };
  /** 把播放器拉到 4K（画质菜单项在 DOM 里，JS 直接点比 bsk click 稳） */
  window.__probeForce4k = () => {
    const cur = window.player && window.player.getQuality ? window.player.getQuality() : null;
    if (cur && cur.nowQ === 120) return { already4k: true, cur };
    const item = Array.from(document.querySelectorAll('.bpx-player-ctrl-quality-menu-item'))
      .find((e) => (e.textContent || '').includes('4K'));
    if (!item) return { clicked: false, reason: 'no 4K menu item', cur };
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, cur };
  };
`;

// ─────────────────────────── 页面表达式（都很短） ───────────────────────────

const exprInstallLib = `(() => {${PAGE_LIB}
  return { ok: true };
})()`;

/** 等 `<video>` + `window.player` 都在（分多次轮询，单次 ≤6 秒） */
const exprEnv = `(() => {
  const v = !!document.querySelector('video');
  const p = !!(window.player && window.player.getMediaInfo);
  return { video: v, player: p, ready: v && p, url: location.href.split('?')[0] };
})()`;

const exprForce4k = `(() => {${PAGE_LIB}
  return window.__probeForce4k();
})()`;

const exprStart = `(() => {${PAGE_LIB}
  return window.__probeStart();
})()`;

const exprRead = `(() => {${PAGE_LIB}
  return window.__probeRead();
})()`;

/**
 * 认轨：playurl 里每条候选的 path 带 `<cid>-1-<轨号>.m4s`，同一轨的多条候选只有
 * host 不同 ⇒ 用播放器正在用的分片文件名反查唯一一条轨。
 *
 * @param aid av 号
 * @param cid 分 P
 */
function exprIdentify(aid, cid) {
  return `(async () => {
    const p = await fetch('https://api.bilibili.com/x/player/playurl?avid=${aid}&cid=${cid}&qn=120&fnval=4048&fourk=1',
      { credentials: 'include', headers: { Accept: 'application/json' } }).then((r) => r.json());
    const mi = window.player.getMediaInfo();
    const seg = mi.playUrl.split('?')[0].split('/').pop();
    let chosen = null;
    for (const t of ((p && p.data && p.data.dash && p.data.dash.video) || [])) {
      const cands = [t.baseUrl || t.base_url, ...((t.backupUrl || t.backup_url) || [])].filter(Boolean);
      if (cands.some((u) => u.split('?')[0].endsWith(seg))) {
        chosen = { id: t.id, codecid: t.codecid, w: t.width, h: t.height,
          hosts: cands.map((u) => { try { return new URL(u).host; } catch (e) { return 'bad'; } }) };
      }
    }
    return { seg, chosen, playUrlHost: (() => { try { return new URL(mi.playUrl).host; } catch (e) { return null; } })() };
  })()`;
}

/**
 * 在**当前文档**上装钩子：只给 playurl 的 XHR 实例装 `responseText` / `response`
 * 访问器，把 JSON 改完再吐给播放器；页面其它 XHR 一律不碰。
 *
 * 改写目标放在 `window.__plumaRewritePlan` 里**可变** —— 这样同一页面上可以先跑
 * 「空备份」再跑「毒化对照」，不必反复开新标签页（新标签页都要重新起播）。
 */
function exprInstallHook() {
  return `(() => {
    const KEY = '__plumaRewriteProbe';
    if (window[KEY] && window[KEY].installed) return { reused: true };
    const H = (window[KEY] = { installed: true, rewrites: [], requests: [] });
    if (!window.__plumaRewritePlan) window.__plumaRewritePlan = null;

    const isPlayurl = (u) => /\\/playurl/.test(String(u));
    const rewrite = (text) => {
      const PLAN = window.__plumaRewritePlan;
      if (!PLAN) return text;
      let d;
      try { d = JSON.parse(text); } catch (e) { return text; }
      const dash = d && d.data && d.data.dash;
      if (!dash || !dash.video) return text;
      let touched = null;
      for (const t of dash.video) {
        if (t.id !== PLAN.id || t.codecid !== PLAN.codecid) continue;
        const before = (t.backup_url || t.backupUrl || []).length;
        if (PLAN.mode === 'empty-backup') {
          t.backup_url = [];
          t.backupUrl = [];
        } else if (PLAN.mode === 'poison-base') {
          const key = t.base_url ? 'base_url' : 'baseUrl';
          const u = new URL(t[key]);
          u.host = 'pluma-probe-nx.bilivideo.com';
          t[key] = u.toString();
        }
        touched = { mode: PLAN.mode, id: t.id, codecid: t.codecid,
          backupBefore: before, backupAfter: (t.backup_url || t.backupUrl || []).length,
          baseUrl: (t.base_url || t.baseUrl || '').split('?')[0] };
      }
      H.rewrites.push(touched);
      return touched ? JSON.stringify(d) : text;
    };

    const protoText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    const protoResp = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    const openOrig = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { this.__pr = isPlayurl(u) ? String(u) : null; } catch (e) {}
      return openOrig.apply(this, arguments);
    };
    const sendOrig = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      const self = this, u = self.__pr;
      self.__pr = null;   // 立刻消费：XHR 实例会被复用，留着会串味
      if (u) {
        H.requests.push({ url: u.split('?')[0], at: Math.round(performance.now()) });
        let done = false, cached = null;
        const getRewritten = (raw) => { if (!done) { cached = rewrite(raw); done = true; } return cached; };
        try {
          Object.defineProperty(self, 'responseText', {
            configurable: true, get() { return getRewritten(protoText.get.call(self)); },
          });
          Object.defineProperty(self, 'response', {
            configurable: true, get() {
              const raw = protoResp.get.call(self);
              return typeof raw === 'string' ? getRewritten(raw) : raw;
            },
          });
        } catch (e) { H.installError = String(e); }
      }
      return sendOrig.apply(this, arguments);
    };
    return { reused: false };
  })()`;
}

/**
 * 设改造目标 → `disconnect()` → `connect()` → 起采样。
 *
 * ⚠️ 只 `connect()` 不会重发 playurl（已实测，见 REPORT-remaining.md §4）
 * ⇒ 必须先 `disconnect()`。
 *
 * @param plan `{mode:'empty-backup'|'poison-base', id, codecid}`
 */
function exprRestart(plan) {
  return `(async () => {${PAGE_LIB}
    const H = window.__plumaRewriteProbe;
    window.__plumaRewritePlan = ${JSON.stringify(plan)};
    H.rewrites.length = 0;
    H.requests.length = 0;
    const v0 = document.querySelector('video');
    const before = { readyState: v0 && v0.readyState, height: v0 && v0.videoHeight,
      currentTime: v0 ? Math.round(v0.currentTime) : null };
    try { window.player.disconnect(); } catch (e) { H.disconnectError = String(e); }
    await sleep(1200);
    const v1 = document.querySelector('video');
    const down = { readyState: v1 && v1.readyState, height: v1 && v1.videoHeight,
      currentTime: v1 ? Math.round(v1.currentTime) : null };
    window.__probeStart();
    try { window.player.connect(); } catch (e) { H.connectError = String(e); }
    return { before, down, startedAt: window.__probe.t0, appliedPlan: window.__plumaRewritePlan };
  })()`;
}

const exprHookState = `(() => {
  const H = window.__plumaRewriteProbe;
  return { rewrites: H.rewrites.slice(), requests: H.requests.slice(),
    installError: H.installError || null, disconnectError: H.disconnectError || null,
    connectError: H.connectError || null };
})()`;

// ─────────────────────────── bsk 调用 ───────────────────────────

function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, {
      encoding: 'utf8',
      env: { ...process.env, BSK_AUTO_START: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`bsk ${args[0]} 失败：\n${e.stderr || e.stdout || e.message}`);
  }
  if (!json) return out.trim();
  return JSON.parse(out.slice(out.indexOf('{')));
}

/**
 * 取当前会话 / 标签页 / ctx。
 *
 * 视频页上 `sync` 偶发三种失败：`observation_changed`（弹幕/推荐位在变）、
 * `renderer_read_timeout`（读门卡住）、`browser_disconnected`（心跳饿死被 reap）。
 * 前两种重试即好；第三种要等浏览器重连，所以多等一会。
 */
function current() {
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      const s = bsk(['sync', '--json'], { json: true });
      return { session: s.session_id, tab: s.tab_id, ctx: s.ctx };
    } catch (e) {
      last = e;
      const msg = String(e.message || e);
      const wait = /browser_disconnected|renderer_read_timeout|not responding/.test(msg) ? 3000 : 800;
      try {
        bsk(['wait-ms', String(wait)]);
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

/**
 * 跑一段很短的页面表达式（单元素 argv，绝不过 shell）。
 *
 * ⚠️ **缓存 ctx，不每次 `sync`**：`sync` 每次都做整页观测，在**正在播放**的视频页上
 * 又慢又重，实测会把扩展的心跳饿死 → daemon 把浏览器判为失联（`browser_disconnected`）。
 * 只 `evaluate` 不动 DOM 时 ctx 是能复用的，只在报上下文错误时才重新 `sync`。
 */
let cachedCtx = null;

function evaluate(expression) {
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      const cur = cachedCtx ? currentCached(cachedCtx) : current();
      cachedCtx = cur;
      const out = bsk([
        'evaluate', '--session', cur.session, '--tab-id', String(cur.tab), '--context', cur.ctx,
        '--expect', '[{"target":"body","field":"exists","equals":true}]', expression,
      ]);
      const parsed = JSON.parse(out.slice(out.indexOf('{')));
      return parsed && parsed.value !== undefined ? parsed.value : parsed;
    } catch (e) {
      last = e;
      cachedCtx = null; // 上下文失效 → 下次重新 sync
      try {
        bsk(['wait-ms', '1500']);
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

/** 复用已缓存的会话/标签页信息（不再 sync） */
function currentCached(c) {
  return c;
}

/** 建立会话（`bsk close` 之后没有 session，`sync` 直接报 no_active_session） */
function ensureSession() {
  try {
    return current();
  } catch {
    for (let i = 0; i < 3; i += 1) {
      try {
        bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '80']);
        return current();
      } catch {
        /* 再试 */
      }
    }
    throw new Error('无法建立 bsk 会话');
  }
}

/** 新建标签页加载页面（`tab create` 不需要严格观测，见 REPORT-remaining.md §4） */
function openPage(url) {
  const cur = ensureSession();
  bsk([
    'tab', 'create', '--url', url, '--session', cur.session, '--context', cur.ctx,
    '--expect', '[{"target":"body","field":"exists","equals":true}]', '--json',
  ]);
  return current();
}

/**
 * 轮询页面采样器直到 `readyState === 4` 或超时。
 *
 * 每次只读一次、单次 evaluate 都很短 —— 这是长阻塞 evaluate 饿死扩展心跳
 * （daemon 日志 `reaping unresponsive browser`）之后改的写法。
 *
 * @param timeoutMs 上限
 */
function pollUntilPlayable(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = evaluate(exprRead);
    if (last && last.t4 !== null && last.readyState === 4) return last;
    if (last && last.error) return last;
    bsk(['wait-ms', '1200']);
  }
  return last;
}

/** 等 `<video>` + `window.player` 就绪（最多 30 秒，分多次短查询） */
function waitEnv(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = evaluate(exprEnv);
    if (last && last.ready) return last;
    bsk(['wait-ms', '1500']);
  }
  return last;
}

/** 拿 aid/cid（在当前 bilibili 页面里同源请求） */
function exprIds(bvid) {
  return `(async () => {
    const v = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=${bvid}',
      { credentials: 'include', headers: { Accept: 'application/json' } }).then((r) => r.json());
    return { aid: v && v.data && v.data.aid, cid: v && v.data && v.data.cid, title: v && v.data && v.data.title };
  })()`;
}

// ─────────────────────────── 主流程 ───────────────────────────

const OUT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  'backup-empty-acceptance.json',
);

const result = { at: new Date().toISOString(), bvid: BVID, baseline: null, emptyBackup: null, poison: null };

openPage(`https://www.bilibili.com/video/${BVID}/`);
const env = waitEnv(30000);
result.env = env;
process.stdout.write(`环境：video=${env && env.video} player=${env && env.player}\n`);

const ids = evaluate(exprIds(BVID));
result.ids = ids;

// ── Run A：基线（不改造） ──
evaluate(exprInstallLib);
const q4k = evaluate(exprForce4k);
evaluate(exprStart);
const A = pollUntilPlayable(35000);
const identified = evaluate(exprIdentify(ids.aid, ids.cid));
result.baseline = { ...A, force4k: q4k, identified };
process.stdout.write(
  `A 基线：readyState=${A.readyState} height=${A.height} t4=${A.t4}ms err=${JSON.stringify(A.error)} ` +
    `在用轨=${JSON.stringify(identified.chosen)} 4K点击=${JSON.stringify(q4k)}\n`,
);

// ── 装钩子（只包裹 playurl 的 XHR） ──
result.hook = evaluate(exprInstallHook());

/** 目标是 **4K 那条轨**，编码跟随播放器实际在用的那条 */
const target = { id: 120, codecid: identified.chosen && identified.chosen.id === 120 ? identified.chosen.codecid : 7 };
result.target = target;

// ── Run B：backup_url = [] ──
result.restartB = evaluate(exprRestart({ mode: 'empty-backup', ...target }));
const B = pollUntilPlayable(35000);
result.hookStateB = evaluate(exprHookState);
result.emptyBackup = B;
process.stdout.write(
  `B 空备份：readyState=${B.readyState} height=${B.height} t4=${B.t4}ms err=${JSON.stringify(B.error)} ` +
    `改写=${JSON.stringify(result.hookStateB.rewrites)} 重连后请求host=${JSON.stringify(B.hostsAfterT0)}\n`,
);

// ── Run C：毒化对照（证明"改过的响应"确实是播放器采用的那份） ──
result.restartC = evaluate(exprRestart({ mode: 'poison-base', ...target }));
const C = pollUntilPlayable(35000);
result.hookStateC = evaluate(exprHookState);
result.poison = C;
process.stdout.write(
  `C 毒化：readyState=${C.readyState} height=${C.height} t4=${C.t4}ms err=${JSON.stringify(C.error)} ` +
    `改写=${JSON.stringify(result.hookStateC.rewrites)} 重连后请求host=${JSON.stringify(C.hostsAfterT0)}\n`,
);

writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
process.stdout.write(`\n已写出 ${OUT}\n`);
