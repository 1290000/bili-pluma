#!/usr/bin/env node
/**
 * 真机 trace：`pgcPatched` 在**第一轮页面加载**里是否可靠同步。
 *
 * ## 这个脚本回答什么
 *
 * ADR 0030 的方案 c 把刷新护栏的判据从「刷了几次」换成「刷之后成了没有」，
 * 它的**唯一技术风险点**是：
 *
 * > `pgcPatchedByUs`（= `d.pgcPatched`）必须同步可靠，否则 c 的判定点本身不成立。
 *
 * 静态链路：
 *
 * ```
 * main-world.js:1222        pgcPatched = true            ← 注入成功后同步置位
 * main-world.js:3621        pgcPatched: pgcPatched       ← 放进 ssr-playinfo 消息
 * main-world.js:3800-3802   postSsrPlayinfo(); setTimeout(1500); setTimeout(5000)   ← 三次上报
 * entrypoints/content.ts:680  orchestratePgc(cid, d.data, d.pgcPatched === true)
 * entrypoints/content.ts:998  pgcReloadTrace.ssrPatchedByUs = ssrWasPatchedByUs   ← ★ 生产埋点
 * entrypoints/content.ts:1003 canSkipPgcInjection({ pgcPatchedByUs, truncated })
 * ```
 *
 * ## 为什么这个脚本能拿到"真实值"而不是推演（核心设计）
 *
 * 首次 `postSsrPlayinfo()` 发生在 `document_start` 的 MAIN world IIFE 末尾，
 * 早于任何 `evaluate` 能插入的时刻 —— 而 `bsk 0.3.3` **没有**
 * `addInitScript` / `Page.addScriptToEvaluateOnNewDocument`（实测：evaluate 写进
 * `window` 的标记 reload 后 `GONE`），所以"在页面脚本之前装消息监听"这条路**走不通**。
 *
 * 但不需要那么麻烦：**产品自己就把答案记在 ISOLATED 侧了**。
 *
 * `entrypoints/content.ts:166-197` 定义了 `pgcReloadTrace` 并挂到 ISOLATED 的 `window`
 * 上；`:998` 把 `orchestratePgc` 收到的第 3 个参数原样写进
 * `pgcReloadTrace.ssrPatchedByUs`；`:454` 再通过 `page/snapshot:ok` 桥送出来。
 *
 * → 页面侧 `postMessage({type:'snapshot'})` 读到的 `pgcReload.ssrPatchedByUs`
 * 就是 **`orchestratePgc` 实际收到的 `d.pgcPatched === true`**。
 * 这是**读产品的真实运行值**，不是从命名或代码顺序推断的。
 *
 * ## 三条证据（互不依赖）
 *
 * | 证据 | 来源 | 读什么 |
 * | --- | --- | --- |
 * | **E1 消费值**（主证据） | `snapshot` 桥 → `pgcReload.ssrPatchedByUs` | `orchestratePgc` 第 3 参的真实值 |
 * | **E2 时序链** | `window.__PLUMA_PGC__`（MAIN world） | `bootAt`/`ssAt`/`patchedAt`/`patchedInSetter` |
 * | **E3 上报序列**（软证据） | 页面侧重放 `message` 监听 | 后续（1500/5000ms）上报的 `pgcPatched` |
 *
 * E3 的局限**必须写清楚**：监听器只能在页面加载完之后挂上，首次上报已经错过。
 * 它的价值是回答「第 2/3 次上报是不是已经变成 true」，用于判断晚到的**上界**。
 *
 * ## E1 为什么足以定论
 *
 * `content.ts:681` 处理完**第一条** `ssr-playinfo` 就 `return`，且
 * `gateSsrPlayinfo({ alreadyTried: pgcCacheTried })` 会挡掉后续所有上报
 * （`:653-663`）。所以 **`ssrPatchedByUs` 记录的就是首次上报的值**——
 * 如果它晚到，`orchestratePgc` 永远看不到 `true`。
 *
 * ⚠️ 前提：`orchestrateCalls` 必须 ≥ 1。若为 0，说明门控没让任何上报通过，
 * 这时 `ssrPatchedByUs: null` 是"没跑"，**不能**当成"值为 false"。脚本会分开报。
 *
 * ## 只读保证
 *
 * 不拨开关、不写 `chrome.storage`、不装/删 DNR 规则、不改产品代码。
 * 唯一的写入是场景准备的 `sessionStorage` / `localStorage` 清理（见 `RESET_EXPR`），
 * 且可用 `--keep-cache` 完全跳过。
 *
 * ## 三个场景
 *
 * | 场景 | 准备 | 预期 |
 * | --- | --- | --- |
 * | **A（有 `sessionStorage` 缓存）** | 同 tab 刷新 | setter 里**同步**注入，`patchedInSetter: true` |
 * | **A'（新标签页，无 `sessionStorage`）** | `tab create` 开新页 | 靠 `cfg` 补注入（**晚**）或其自身 reload |
 * | **B（真的无缓存）** | 清 `pluma:pgc-vi:*` + `storage.local` LRU | 首轮无缓存 → 取流 → 自己 reload → 二轮注入 |
 *
 * ### ⚠️ 场景 B 的正确做法：换一个**从没访问过**的集数 + 新标签页（实测有效）
 *
 * 两条失败尝试（2026-10-30 实测）：
 *
 * 1. **清 `sessionStorage` 不够**：清掉 `pluma:pgc-vi:<cid>` 后刷新，
 *    `ssAt` 变 61ms、`ssHit` 立刻为 `true` —— 因为 `storage.local` 的 LRU 缓存
 *    （100 分钟 TTL）跨标签页存活，ISOLATED 侧预读后通过 `cfg` 把
 *    `pgcVideoInfo` 推给主世界，主世界在 setter 里同步读了它（`main-world.js:3739`）。
 * 2. **只开新标签页也不够**：`tab create` 开全新 tab（`sessionStorage` 必空），
 *    访问**同一个 ep** 时仍然 `ssHit true / patchedInSetter true`。同一条 LRU 路径。
 *
 * **有效做法**：`--fresh-tab` + 一个**本会话从未加载过**的集数。实测 `ep341220`：
 *
 * ```
 * ssAt 455  ssHit false  cacheBytes 0  patchedAt -1  patchedInSetter null  lastStage boot
 * → pgcReload: { orchestrateCalls: 1, ssrPatchedByUs: **false**, ssrTruncated: false,
 *               orchestrateExit: 'not-truncated-early-return' }
 * ```
 *
 * 这一趟 `ssrPatchedByUs: false` 与 `patchedAt: -1` **完全一致** ——
 * 没注入，所以 false，**同步且正确**（不是晚到）。
 *
 * 用法：
 *
 * ```bash
 * # daemon 已在跑（不要起第二个）。先拿 session：
 * #   bsk session start --no-focus --json   → session_id
 * node poc/probe/probe-pgcpatched-timing.mjs <session-id> ep341217
 * node poc/probe/probe-pgcpatched-timing.mjs <session-id> ep341217 --json
 * node poc/probe/probe-pgcpatched-timing.mjs <session-id> ep341217 --keep-cache   # 只测场景 A
 * node poc/probe/probe-pgcpatched-timing.mjs <session-id> ep341220 --fresh-tab    # 真·无缓存
 * node poc/probe/probe-pgcpatched-timing.mjs <session-id> ep341217 --wait=12000   # 慢网络加等
 * ```
 *
 * 退出码：0 = 场景 A 的 `ssrPatchedByUs === true`（可靠）；
 *         1 = 场景 A 为 `false`（晚到 / 不可靠）；
 *         2 = 参数错误；3 = 未能实测（门控没跑 / 读不到）。
 */

import { spawnSync } from 'node:child_process';

const BSK = process.env.BSK_BIN || 'bsk';
const argv = process.argv.slice(2);
const SID = argv[0];
const EP = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'ep341217';
const AS_JSON = argv.includes('--json');
const KEEP_CACHE = argv.includes('--keep-cache');
/**
 * `--fresh-tab`：在**新标签页**里跑（`sessionStorage` 必空）。
 *
 * ⚠️ 只开新标签页**还不够** —— `storage.local` 的 LRU 缓存跨标签页存活，
 * 访问已缓存过的集数仍会命中。所以要配一个**本会话没访问过**的集数，
 * 才能拿到"首轮真的无缓存"（见文件头 §场景 B）。
 */
const FRESH_TAB = argv.includes('--fresh-tab');
const WAIT_MS = Number((argv.find((a) => a.startsWith('--wait=')) ?? '--wait=10000').slice(7));

if (!SID) {
  console.error(
    '用法: node poc/probe/probe-pgcpatched-timing.mjs <session-id> [ep号] [--json] [--keep-cache] [--wait=10000]',
  );
  process.exit(2);
}

/**
 * ⚠️ `shell: false`（默认值，**不要改成 true**）。
 *
 * 与 `reload-extension.mjs` 的坑 4 同源：`shell: true` 时表达式会被 cmd 再解析一遍，
 * `!` 触发历史展开、`"` 被剥掉。本脚本的表达式里有大量引号、箭头函数与 `!`。
 */
function bsk(args, { allowFail = false } = {}) {
  const r = spawnSync(BSK, args, {
    env: { ...process.env, BSK_AUTO_START: '0' },
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `bsk ${args[0]} 失败 (exit ${String(r.status)}): ${(r.stderr || r.stdout || '').slice(0, 600)}`,
    );
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function sleep(ms) {
  const r = bsk(['wait-ms', String(ms)], { allowFail: true });
  if (r.status === 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* wait-ms 不可用时本地自旋 */
  }
}

/**
 * 在指定 tab 上 evaluate 一个表达式并取回 JSON。
 *
 * ## async IIFE 约定（docs/guides/bsk-page-bridges.md §1）
 *
 * 需要等 `postMessage` 的表达式**必须**是 async IIFE、**内部 await 完再 stringify**。
 * 直接 `JSON.stringify(promise)` 得到 `{}`，而 `bsk evaluate` **exit 0** ——
 * 看起来完全"成功"。CLI 的 `--await-promise` 默认 true 只 await 表达式的最终值。
 */
function evaluate(tabId, expression, { allowFail = false } = {}) {
  const args = ['evaluate', '--session', SID];
  if (tabId) args.push('--tab-id', String(tabId));
  args.push(expression);
  const r = bsk(args, { allowFail });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) return { ok: false, err: (r.stderr || out).slice(0, 400) };
  try {
    const parsed = JSON.parse(out);
    // 表达式返回 JSON 字符串时再解一层
    return { ok: true, value: typeof parsed === 'string' ? tryJson(parsed) : parsed };
  } catch {
    return { ok: true, value: out };
  }
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** 当前 tab（navigate 打印 `tab=<id>`；也可以从 tab list 取 active 的那个） */
function tabIdFromNavigate(stdout) {
  const m = /tab=(\d+)/.exec(stdout ?? '');
  return m ? m[1] : null;
}

function activeTabId() {
  const r = bsk(['tab', 'list', '--session', SID, '--json'], { allowFail: true });
  try {
    const j = JSON.parse(r.stdout);
    const arr = j.tabs ?? [];
    const hit = arr.find((t) => t.active) ?? arr[0];
    return hit?.tab_id ? String(hit.tab_id) : null;
  } catch {
    return null;
  }
}

// ── 读侧表达式 ────────────────────────────────────────────────────────────────

/**
 * E1（主证据）：通过产品的 `snapshot` 桥读 ISOLATED 侧的 `pgcReloadTrace`。
 *
 * `pgcReload.ssrPatchedByUs` = `orchestratePgc` 第 3 个参数的真实值。
 * 这是**读产品运行值**，不是从代码顺序推断。
 *
 * ⚠️ 必须 async IIFE + 内部 await 再 stringify。
 */
const E1_EXPR = `(async () => {
  try {
    const snap = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('snapshot-reply timeout')), 6000);
      const h = (e) => {
        if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
          clearTimeout(t); window.removeEventListener('message', h); resolve(e.data);
        }
      };
      window.addEventListener('message', h);
      window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
    });
    const p = snap.pgcReload || null;
    const s = snap.snapshot || null;
    return JSON.stringify({
      phase: 'E1',
      pgcReload: p,
      proxyEnabled: s && s.proxy ? s.proxy.enabled : null,
      ruleCount: s && s.proxy ? s.proxy.ruleCount : null,
      hasCredential: s && s.proxy ? s.proxy.hasCredential : null,
      pageKind: s && s.page ? s.page.kind : null,
      pageKey: s && s.page ? s.page.pageKey : null,
      viewHeight: s && s.view && typeof s.view.height === 'number' ? s.view.height : null,
      at: Math.round(performance.now())
    });
  } catch (e) {
    return JSON.stringify({ phase: 'E1', error: String(e && e.message ? e.message : e) });
  }
})()`;

/**
 * E2：MAIN world 的时序链（`window.__PLUMA_PGC__`）。
 *
 * | 字段 | 代码位置 | 含义 |
 * | --- | --- | --- |
 * | `bootAt` | `:850` | 主世界 IIFE 起点（`ISOLATED` 脚本注入后立刻） |
 * | `ssAt` | `:609` | setter 里读 `sessionStorage` 的时刻 |
 * | `patchedAt` | `:1223` | 注入完成、`pgcPatched = true` 的时刻 |
 * | `patchedInSetter` | `:1235` | `true` = setter 同步路径 |
 * | `playinfoAt` | `:543` | `__playinfo__` 被赋值的时刻 |
 * | `createPlayerAt` | `:212` | 页面 `createPlayer` 被调用 |
 * | `lastStage` | 多处 | 最后到的分支名 |
 */
const E2_EXPR = `(() => {
  const t = window.__PLUMA_PGC__ || null;
  if (!t) return JSON.stringify({ phase: 'E2', error: 'no __PLUMA_PGC__ (not a PGC page or main-world not injected)' });
  const v = document.querySelector('video');
  return JSON.stringify({
    phase: 'E2',
    bootAt: t.bootAt, ssAt: t.ssAt, ssHit: t.ssHit, ssCid: t.ssCid, ssErr: t.ssErr,
    patchedAt: t.patchedAt, patchedInSetter: t.patchedInSetter,
    playinfoAt: t.playinfoAt, createPlayerAt: t.createPlayerAt, createPlayerCalls: t.createPlayerCalls,
    lastStage: t.lastStage, cfgCount: t.cfgCount, lastCfgEnabled: t.lastCfgEnabled,
    injectedFrom: t.injectedFrom, injectedTo: t.injectedTo, cacheBytes: t.cacheBytes,
    cacheRejectedTruncated: t.cacheRejectedTruncated,
    skipProxyOffCount: t.skipProxyOffCount, skipDisabledCount: t.skipDisabledCount,
    skipInactiveCount: t.skipInactiveCount,
    swapCount: t.swapCount, swapLastCid: t.swapLastCid,
    video_duration: v ? v.duration : null,
    video_wh: v ? [v.videoWidth, v.videoHeight] : null,
    has_playinfo: typeof window.__playinfo__ !== 'undefined',
    now: Math.round(performance.now()),
    href: location.href
  });
})()`;

/**
 * E3（软证据）：页面侧重放 `ssr-playinfo`。
 *
 * ⚠️ 局限：只能在**页面加载完之后**挂监听 —— 首次上报已经错过。
 * 它回答的是「第 2/3 次上报（1500ms / 5000ms）里 `pgcPatched` 是不是已经 true」。
 *
 * 同时把 `data.result.video_info` 的时长也带出来，用于交叉核对
 * 「这份 data 是不是注入后的完整流」（⚠️ 那不能代替 `pgcPatched` 本身，
 * 因为 `ssrPlayinfo` 是同一对象引用、注入是原地改 `video_info`）。
 */
const E3_EXPR = `(async () => {
  const seen = [];
  const t0 = performance.now();
  const h = (e) => {
    const d = e.data;
    if (!d || d.__ns !== '__PLUMA__' || d.type !== 'ssr-playinfo') return;
    let dashDur = null, timelength = null, playVideoType = null, isPreview = null;
    try {
      const r = d.data && (d.data.result || (d.data.data && d.data.data.result));
      const vi = r && r.video_info;
      if (vi) {
        if (vi.dash && typeof vi.dash.duration === 'number') dashDur = vi.dash.duration;
        if (typeof vi.timelength === 'number') timelength = vi.timelength;
        isPreview = vi.is_preview === undefined ? null : vi.is_preview;
      }
      if (r) playVideoType = r.play_video_type === undefined ? null : r.play_video_type;
    } catch (err) {}
    seen.push({
      at: Math.round(performance.now() - t0),
      pgcPatched: d.pgcPatched === true,
      pgcPatchedRaw: d.pgcPatched === undefined ? '<missing>' : String(d.pgcPatched),
      firstSeen: d.firstSeen,
      hasData: !!d.data,
      dashDur: dashDur, timelength: timelength,
      play_video_type: playVideoType, is_preview: isPreview
    });
  };
  window.addEventListener('message', h);
  await new Promise((r) => setTimeout(r, 6400));
  window.removeEventListener('message', h);
  return JSON.stringify({ phase: 'E3', collected: seen.length, samples: seen });
})()`;

/**
 * 场景准备：清 PGC 缓存 + 护栏，让下一轮走「无缓存」分支。
 *
 * 只碰这两类 key，其余 `pluma:*`（尤其 `pluma:proxy-off` 与开关相关）一律不动：
 *   - `sessionStorage`：`pluma:pgc-vi:*` / `pluma:pgc-cache*`（同步缓存）
 *   - `localStorage` ：`pluma:pgc-reload*` / `pluma:pgc-guard*`（刷新护栏）
 *
 * `:1354` 提到护栏写在 `sessionStorage`，两处都清以覆盖两个版本。
 */
const RESET_EXPR = `(() => {
  const removed = { ss: [], ls: [] };
  const kill = (store, pred, bucket) => {
    try {
      const ks = [];
      for (let i = 0; i < store.length; i += 1) ks.push(store.key(i));
      for (const k of ks) { if (k && pred(k)) { store.removeItem(k); bucket.push(k); } }
    } catch (e) {}
  };
  const isPgc = (k) => k.indexOf('pluma:pgc-vi') === 0 || k.indexOf('pluma:pgc-cache') === 0;
  const isGuard = (k) => k.indexOf('pluma:pgc-reload') === 0 || k.indexOf('pluma:pgc-guard') === 0;
  kill(sessionStorage, isPgc, removed.ss);
  kill(sessionStorage, isGuard, removed.ss);
  kill(localStorage, isGuard, removed.ls);
  kill(localStorage, isPgc, removed.ls);
  return JSON.stringify({ phase: 'reset', removed, ss_left: (() => { const o=[]; for (let i=0;i<sessionStorage.length;i+=1){const k=sessionStorage.key(i); if(k&&k.indexOf('pluma')===0)o.push(k);} return o; })() });
})()`;

// ── 主流程 ────────────────────────────────────────────────────────────────────

const report = {
  generated_at: new Date().toISOString(),
  session: SID,
  ep: EP,
  url: `https://www.bilibili.com/bangumi/play/${EP}`,
  keep_cache: KEEP_CACHE,
  wait_ms: WAIT_MS,
  scenarios: {},
  sniff_at_end: null,
};

function log(s) {
  if (!AS_JSON) console.log(s);
}

function capture(label, tabIdHint) {
  const tabId = tabIdHint ?? activeTabId();
  const e1 = evaluate(tabId, E1_EXPR);
  const e2 = evaluate(tabId, E2_EXPR);
  return {
    label,
    tab_id: tabId,
    captured_at: new Date().toISOString(),
    E1_consumer: e1.ok ? e1.value : { error: e1.err },
    E2_timing: e2.ok ? e2.value : { error: e2.err },
  };
}

/** 从一次 capture 里提取关键判断 */
function verdictOf(cap) {
  const r = cap?.E1_consumer?.pgcReload;
  if (!r) return { status: 'no-data', why: 'pgcReload 取不到' };
  if (!r.orchestrateCalls) {
    return {
      status: 'not-run',
      why: 'orchestrateCalls=0：门控没让任何 ssr-playinfo 通过，本轮不能判定',
    };
  }
  return {
    status: r.ssrPatchedByUs === true ? 'true' : r.ssrPatchedByUs === false ? 'false' : 'null',
    why: `ssrPatchedByUs=${String(r.ssrPatchedByUs)} exit=${r.orchestrateExit} ssrTruncated=${String(r.ssrTruncated)}`,
  };
}

function printCapture(cap, indent = '  ') {
  const e1 = cap.E1_consumer?.pgcReload;
  const e2 = cap.E2_timing;
  const v = verdictOf(cap);
  log(`${indent}[${cap.label}] tab=${String(cap.tab_id)}`);
  log(`${indent}  → E1 ssrPatchedByUs = ${String(e1?.ssrPatchedByUs)}   (${v.status})`);
  log(
    `${indent}    orchestrateCalls=${String(e1?.orchestrateCalls)} exit=${String(e1?.orchestrateExit)} ` +
      `ssrTruncated=${String(e1?.ssrTruncated)} hadSync=${String(e1?.hadSync)}`,
  );
  if (e2 && !e2.error) {
    log(
      `${indent}    E2 bootAt=${String(e2.bootAt)} ssAt=${String(e2.ssAt)} patchedAt=${String(e2.patchedAt)} ` +
        `playinfoAt=${String(e2.playinfoAt)} createPlayerAt=${String(e2.createPlayerAt)}`,
    );
    log(
      `${indent}       patchedInSetter=${String(e2.patchedInSetter)} lastStage=${String(e2.lastStage)} ` +
        `ssHit=${String(e2.ssHit)} cfgCount=${String(e2.cfgCount)} injected ${String(e2.injectedFrom)}→${String(e2.injectedTo)}`,
    );
    log(
      `${indent}       dur=${String(e2.video_duration)} wh=${JSON.stringify(e2.video_wh)} ` +
        `proxyOff=${String(e2.skipProxyOffCount)} disabled=${String(e2.skipDisabledCount)} inactive=${String(e2.skipInactiveCount)}`,
    );
    if (typeof e2.ssAt === 'number' && typeof e2.bootAt === 'number') {
      log(`${indent}       ssAt-bootAt = ${String(e2.ssAt - e2.bootAt)}ms`);
    }
    if (typeof e2.patchedAt === 'number' && typeof e2.ssAt === 'number' && e2.patchedAt > 0) {
      log(`${indent}       patchedAt-ssAt = ${String(e2.patchedAt - e2.ssAt)}ms  ← 注入在 setter 内耗时`);
    }
  } else {
    log(`${indent}    E2 ${String(e2?.error ?? 'n/a')}`);
  }
}

log('=== pgcPatched 第一轮可靠性 trace（bsk 真机）===');
log(`session=${SID}  ep=${EP}  keepCache=${String(KEEP_CACHE)}  freshTab=${String(FRESH_TAB)}  wait=${String(WAIT_MS)}ms`);
log('');

// ---- 场景 A：有缓存（同 tab 刷新，sessionStorage 保留） ----
log('[场景 A] 有 sessionStorage 缓存 → 期望 setter 内同步注入');
if (FRESH_TAB) {
  log('  step 0: tab create（--fresh-tab：新标签页，sessionStorage 必空）');
  const created = bsk(['tab', 'create', '--session', SID, '--url', 'about:blank', '--json'], {
    allowFail: true,
  });
  try {
    const j = JSON.parse(created.stdout);
    log(`  created tab=${String(j.tab_id)}`);
    report.fresh_tab_id = j.tab_id;
  } catch {
    log('  ⚠️ tab create 输出无法解析：' + created.stdout.slice(0, 200));
  }
}
log('  step 1/3: navigate（首次进入，建立缓存）');
const navArgs = ['navigate', '--session', SID];
if (report.fresh_tab_id) navArgs.push('--tab-id', String(report.fresh_tab_id));
navArgs.push(`https://www.bilibili.com/bangumi/play/${EP}`);
const nav = bsk(navArgs, { allowFail: true });
let tabId = tabIdFromNavigate(nav.stdout) ?? report.fresh_tab_id ?? activeTabId();
log(`  ${(nav.stdout || nav.stderr || '').trim().split('\n')[0] ?? '(no output)'}  tab=${String(tabId)}`);
sleep(WAIT_MS);

const warmup = capture('warmup', tabId);
printCapture(warmup);
report.scenarios.warmup = warmup;

const ssKeys = warmup.E2_timing?.ssHit;
const cachePresent = ssKeys === true || warmup.E1_consumer?.pgcReload?.hadSync === true;
if (!cachePresent) {
  log('  ⚠️ 首趟没看到缓存命中（ssHit/hadSync 都非 true）—— 场景 A 前提可能不成立，照常记录');
}

log('  step 2/3: reload（sessionStorage 保留 → 走"有缓存"分支）');
const reloadA = bsk(['reload', '--session', SID], { allowFail: true });
if (reloadA.status !== 0) log('  ⚠️ reload 失败: ' + reloadA.stderr.slice(0, 200));
sleep(WAIT_MS);

const capA = capture('scenario-A-with-cache', tabId);
printCapture(capA);
report.scenarios.A_with_cache = capA;
report.A_verdict = verdictOf(capA);

// ---- 场景 B：无缓存 ----
if (KEEP_CACHE) {
  log('');
  log('[场景 B] 跳过（--keep-cache）');
} else {
  log('');
  log('[场景 B] 清 PGC 缓存 + 护栏 → 首轮无缓存（应取流 + 自己 reload）');
  const reset = evaluate(tabId, RESET_EXPR);
  log('  reset: ' + JSON.stringify(reset.ok ? reset.value : reset.err).slice(0, 400));

  log('  step 2/3: reload（缓存已清）');
  const reloadB = bsk(['reload', '--session', SID], { allowFail: true });
  if (reloadB.status !== 0) log('  ⚠️ reload 失败: ' + reloadB.stderr.slice(0, 200));
  sleep(WAIT_MS);

  // 首轮：**期望**无缓存，从而 ssrPatchedByUs=false（这时 false 是**对的**，不是 bug）。
  // ⚠️ 真机上很难做到 —— 见文件头 §场景 B 的两条实测。所以这里检查 ssHit，
  // 若仍命中就把这次记为 degraded，**不得**当作"首轮 pgcPatched=false"的证据。
  const capB1 = capture('scenario-B-first-load', tabId);
  printCapture(capB1);
  const b1CacheStillHit =
    capB1.E2_timing?.ssHit === true || capB1.E1_consumer?.pgcReload?.hadSync === true;
  report.scenarios.B_first_load = capB1;
  report.B_first_verdict = verdictOf(capB1);
  report.B_first_degraded = b1CacheStillHit;
  if (b1CacheStillHit) {
    log('  ⚠️ degraded：清掉 sessionStorage 后仍然缓存命中（storage.local LRU 跨标签页存活）');
    log('     → 本轮**不是**"真正无缓存"，不能作为场景 B 的证据');
  }

  // 等它自己刷完（取流 → 写缓存 → reload）再看
  sleep(WAIT_MS);
  const capB2 = capture('scenario-B-after-selfreload', tabId);
  printCapture(capB2);
  report.scenarios.B_after_selfreload = capB2;
  report.B_settled_verdict = verdictOf(capB2);
}

// ---- SPA 切集：这条链路到底会不会再触发 orchestratePgc ----
//
// `main-world.js:589-594` 的注释断言：SPA 切集时 `__playinfo__` **完全不重新赋值**，
// setter 不被调用，切集改由响应层拦 `/ogv/player/playview`（ADR 0023）。
// 若成立，则 ADR 0030 表里「切走再切回」那个场景**根本不经过 `pgcPatched` 这条链路** ——
// 对方案 c 的落地范围有直接影响。所以这里顺带实测一次。
if (!KEEP_CACHE) {
  log('');
  log('[SPA 切集] 点下一集 → 读 setter 是否再次触发 / orchestratePgc 是否再被调用');
  const beforeE2 = evaluate(tabId, E2_EXPR);
  const beforeE1 = evaluate(tabId, E1_EXPR);
  const nextEpLink = evaluate(
    tabId,
    `(() => {
      const cur = Number((/ep(\\d+)/.exec(location.href) || [])[1] || 0);
      const links = [...document.querySelectorAll('a[href*="/bangumi/play/ep"]')]
        .map((a) => ({ a, ep: Number((/ep(\\d+)/.exec(a.getAttribute('href')) || [])[1] || 0) }))
        .filter((x) => x.ep > cur);
      links.sort((x, y) => x.ep - y.ep);
      if (!links[0]) return JSON.stringify({ found: false });
      const href = links[0].a.getAttribute('href');
      links[0].a.setAttribute('data-pluma-probe', '1');
      return JSON.stringify({ found: true, ep: links[0].ep, href });
    })()`,
  );
  const linkInfo = nextEpLink.ok ? nextEpLink.value : { found: false };
  if (linkInfo?.found) {
    const clicked = bsk(
      ['click', '--session', SID, '--tab-id', tabId, '[data-pluma-probe="1"]'],
      { allowFail: true },
    );
    log(`  点击 ep${String(linkInfo.ep)} : ${(clicked.stdout || clicked.stderr || '').trim().split('\n')[0]}`);
    sleep(Math.min(WAIT_MS, 9000));
    const afterE2 = evaluate(tabId, E2_EXPR);
    const afterE1 = evaluate(tabId, E1_EXPR);
    report.spa_switch = {
      target_ep: linkInfo.ep,
      before: { E1: beforeE1.value, E2: beforeE2.value },
      after: { E1: afterE1.value, E2: afterE2.value },
    };
    const b2 = beforeE2.value ?? {};
    const a2 = afterE2.value ?? {};
    const setterRefired = a2.ssAt !== b2.ssAt || a2.patchedAt !== b2.patchedAt;
    const orchestrateRefired =
      (afterE1.value?.pgcReload?.orchestrateCalls ?? 0) !==
      (beforeE1.value?.pgcReload?.orchestrateCalls ?? 0);
    report.spa_switch.setter_refired = setterRefired;
    report.spa_switch.orchestrate_refired = orchestrateRefired;
    log(
      `  setter 再次触发 = ${String(setterRefired)}  (ssAt ${String(b2.ssAt)} → ${String(a2.ssAt)}, patchedAt ${String(b2.patchedAt)} → ${String(a2.patchedAt)})`,
    );
    log(
      `  orchestratePgc 再次调用 = ${String(orchestrateRefired)}  (${String(beforeE1.value?.pgcReload?.orchestrateCalls)} → ${String(afterE1.value?.pgcReload?.orchestrateCalls)})`,
    );
    log(
      `  swapCount ${String(b2.swapCount)} → ${String(a2.swapCount)} (swapCid=${String(a2.swapLastCid)})  dur=${String(a2.video_duration)}`,
    );
    log(
      !setterRefired && !orchestrateRefired
        ? '  → 证实：SPA 切集**完全不经过** pgcPatched 链路（走 ADR 0023 响应层换流）'
        : '  → 与注释不一致：切集确实触发了 setter/orchestrate —— 需人工复核',
    );
  } else {
    log('  未找到下一集链接，跳过');
    report.spa_switch = { skipped: 'no next-episode link' };
  }
}

// ---- E3：页面侧重放（软证据） ----
log('');
log('[E3] 页面侧重放 ssr-playinfo（只能接到本次加载之后的补报；首次已错过）');
const e3 = evaluate(tabId, E3_EXPR);
report.sniff_at_end = e3.ok ? e3.value : { error: e3.err };
log('  ' + JSON.stringify(report.sniff_at_end).slice(0, 700));

// ---- 汇总 ----
const a = report.A_verdict ?? { status: 'unknown' };
if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  log('');
  log('=== 结论 ===');
  log(`场景 A（有缓存）ssrPatchedByUs = ${String(report.scenarios.A_with_cache?.E1_consumer?.pgcReload?.ssrPatchedByUs)}  [${a.status}]`);
  log(`  ${String(a.why)}`);
  if (report.B_first_verdict) {
    log(`场景 B 首轮（无缓存） = ${String(report.scenarios.B_first_load?.E1_consumer?.pgcReload?.ssrPatchedByUs)}  [${report.B_first_verdict.status}]`);
    log(`  ${String(report.B_first_verdict.why)}`);
  }
  if (report.B_settled_verdict) {
    log(`场景 B 自刷后 = ${String(report.scenarios.B_after_selfreload?.E1_consumer?.pgcReload?.ssrPatchedByUs)}  [${report.B_settled_verdict.status}]`);
  }
  if (report.B_first_degraded) {
    log('  ⚠️ 场景 B 首轮标注为 degraded（未做到真正无缓存）');
  }
  if (report.spa_switch && !report.spa_switch.skipped) {
    log('');
    log(`SPA 切集 → ep${String(report.spa_switch.target_ep)}:`);
    log(`  setter 再次触发      = ${String(report.spa_switch.setter_refired)}`);
    log(`  orchestratePgc 再调  = ${String(report.spa_switch.orchestrate_refired)}`);
  }
  log('');
  log('复跑：node poc/probe/probe-pgcpatched-timing.mjs ' + SID + ' ' + EP);
}

const aStatus = report.A_verdict?.status;
process.exit(aStatus === 'true' ? 0 : aStatus === 'false' ? 1 : 3);
