#!/usr/bin/env node
/**
 * 真机回归：ADR 0030 方案 c 的**四条路径**，每条都要看到护栏按新语义收尾。
 *
 * 这是方案 c 的**最后一门**（`docs/decisions/0030-pgc-reload-guard-semantics.md`
 * §「落地前的验证要求」）。在它跑通之前，**不得**把 c 标成「已验证」。
 *
 * ## 前置：本脚本第一件事是**验构建新鲜度**
 *
 * 2026-10-30 首次接手时踩到的坑（必须记住）：
 *
 * ```
 * .output/chrome-mv3/content-scripts/content.js   17:38:22
 * entrypoints/content.ts                          19:45:13   ← 源码比 bundle 新 2 小时
 * ```
 *
 * 浏览器从 `.output/chrome-mv3` **静态加载**扩展，没有 dev server / 构建 watcher，
 * 所以它跑的是 c **之前**的代码。症状极具欺骗性：桥梁工作正常、trace 有值、
 * `bsk evaluate` exit 0，**只是三个新埋点一个都不存在**：
 *
 * ```json
 * {"allKeys":["orchestrateCalls","orchestrateExit","cid","hadSync","ssrPatchedByUs",
 *             "ssrTruncated","shouldReloadCalls","shouldReloadArgs","shouldReloadVerdict",
 *             "reloadWithGuardCalls","reloadIssued","lastReason"],   ← 12 项，全是旧字段
 *  "hasLastGuardOutcome":false,"hasLastGuardAction":false,"hasGuardClearedByOutcome":false}
 * ```
 *
 * 若不先验这一步，四条路径会全部「跑得出数、看得像成功、结论全错」。
 * 所以 `preflight()` 是**硬门**：埋点缺失 → exit 4，不进入任何场景。
 *
 * ## 四条路径（判据全部来自 ADR 0030）
 *
 * | # | 路径 | 构造 | 期望（按 c 的新语义） |
 * | --- | --- | --- | --- |
 * | 1 | **关开总开关** | `set-proxy false` → 看护栏 → `set-proxy true` → reload | 第三层 `clearPgcReloadGuards()` 清掉护栏；重开后**不被 alreadyTried 挡住** |
 * | 2 | **手动 F5** | 成功集（`ssrPatchedByUs=true`）之后 reload | `guardClearedByOutcome` 增长（c 按结果清） |
 * | 3a | **SPA 内点选集** | 点下一集链接 | **不**触发 `orchestratePgc`（ADR 0023 响应层，ADR 0030 已记录） |
 * | 3b | **整页重进同一集** | address bar 回车 | **触发** `orchestratePgc`，`orchestrateCalls` 增长 |
 * | 3c | **切到别的集再后退** | 整页进 epB → `history.back()` | 看是否触发（**如实记录**，不预设） |
 * | 4 | **TTL 内重开** | 护栏未过期（<10min）时重开整页 | 成功集**不应**被挡住 |
 *
 * ## 判据（每条都记原始值，不许只写"通过"）
 *
 * 1. 成功集（`ssrPatchedByUs=true`）的**下一轮**加载 → `guardClearedByOutcome` 增长
 * 2. 未成功集（`still-truncated`）→ 护栏**保留**，`attempts` 最多到 2（`MAX_RELOAD_ATTEMPTS`）
 * 3. **`reloadIssued` 不得失控增长** —— 这是 c 最大的风险（去掉/削弱 alreadyTried 后的防循环）
 * 4. 用户可见结果：`video.duration` 是否等于整集时长、画质是否到顶
 *
 * ## ⚠️ 路径 1 是「c 能否取代 ADR 0028 第三层」的**唯一实测依据**
 *
 * lead 的判断是：c **不能**取代第三层，因为「关开关 → 重开 → 刷新」这一轮的
 * `outcome` 是 `still-truncated`（`guardActionForOutcome` 返回 `retry` → **不清护栏**）。
 * 本脚本把这一轮的 `lastGuardOutcome` / `lastGuardAction` **原样打出来** ——
 * 若实测是 `clear` 且随后能正常取流，**那就是 lead 的判断需要修正**，如实报。
 *
 * ## 允许的写操作（其余一律不做）
 *
 * - `set-proxy` 桥拨总开关（路径 1 必需）
 * - `location.reload()` / `bsk reload`（路径 2/3b/4 必需）
 * - 清 `sessionStorage` 的 `pluma:pgc-reload*` / `pluma:pgc-vi*` 做**场景准备**
 *   （每处清理都记进报告 `preparations[]`，明说清过什么）
 *
 * **不做**：改 `src/` / `entrypoints/` / `docs/`、装删 DNR 规则、改凭据、升 bsk、起第二个 daemon。
 * **不碰** ADR 0028 第一层/第二层（`localStorage` 标记、清缓存）的内部状态 —— 只观察。
 *
 * 用法：
 *
 * ```bash
 * # daemon 已在跑（不要起第二个）。先拿 session 与 tab：
 * #   bsk session start --no-focus --json   → session_id
 * #   bsk tab list --session <sid> --json   → agent 窗口里那条 tab_id
 *
 * node poc/probe/probe-pgc-guard-paths.mjs <session-id> <tab-id> [ep号]
 * node poc/probe/probe-pgc-guard-paths.mjs <sid> <tab> ep341217 --json
 * node poc/probe/probe-pgc-guard-paths.mjs <sid> <tab> --only=1     # 只跑路径 1
 * node poc/probe/probe-pgc-guard-paths.mjs <sid> <tab> --wait=12000 # 慢网络加等
 * ```
 *
 * 退出码：
 *   0 = 四条路径都按新语义收尾
 *   1 = 有路径不符合预期（详见 `verdicts[]`）
 *   2 = 参数错误
 *   3 = 未能实测（读不到 trace / 页面形态不对）
 *   4 = **构建过期**（活扩展里没有 ADR 0030 埋点）—— 需先重建并重载扩展
 */

import { spawnSync } from 'node:child_process';

const BSK = process.env.BSK_BIN || 'bsk';
const argv = process.argv.slice(2);
const SID = argv[0];
const TAB = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
const EP = argv[2] && !argv[2].startsWith('--') ? argv[2] : 'ep341217';
const AS_JSON = argv.includes('--json');
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);
const WAIT_MS = Number((argv.find((a) => a.startsWith('--wait=')) ?? '--wait=10000').slice(7));
/** 重进同一集用的「另一个集」，供路径 3c 的「切走再后退」用 */
const EP_ALT = (argv.find((a) => a.startsWith('--alt=')) ?? '--alt=ep341218').slice(6);

if (!SID || !TAB) {
  console.error(
    '用法: node poc/probe/probe-pgc-guard-paths.mjs <session-id> <tab-id> [ep号] ' +
      '[--json] [--only=1|2|3|4] [--alt=ep341218] [--wait=10000]',
  );
  process.exit(2);
}

// ── bsk 薄封装（与 probe-pgcpatched-timing.mjs 同源） ─────────────────────────

/**
 * ⚠️ `shell: false`（默认值，**不要改成 true**）。
 *
 * 与 `reload-extension.mjs` 的坑 4 同源：`shell: true` 时表达式会被 cmd 再解析一遍，
 * `!` 触发历史展开、`"` 被剥掉。本脚本的表达式里有大量引号、箭头函数与 `!`。
 *
 * 另一个实测坑（2026-10-30）：**不要用 PowerShell 直接传含引号的 `--expression`** ——
 * `bsk evaluate ... $expr` 会被 PS 参数解析剥掉双引号，报
 * `error: unexpected argument '...' found`。必须经 Node 的 `spawnSync` 走数组传参。
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
 * 在 tab 上 evaluate 并取回 JSON。
 *
 * ## async IIFE 约定（docs/guides/bsk-page-bridges.md §1）
 *
 * 需要等 `postMessage` 的表达式**必须**是 async IIFE、**内部 await 完再 stringify**。
 * 直接 `JSON.stringify(promise)` 得到 `{}`，而 `bsk evaluate` **exit 0** ——
 * 看起来完全"成功"。CLI 的 `--await-promise` 默认 true 只 await 表达式的最终值。
 */
function evaluate(expression, { allowFail = true } = {}) {
  const r = bsk(['evaluate', '--session', SID, '--tab-id', TAB, expression], { allowFail });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) return { ok: false, err: (r.stderr || out).slice(0, 400) };
  try {
    const parsed = JSON.parse(out);
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

// ── 读侧表达式 ────────────────────────────────────────────────────────────────

/** `snapshot` 桥（async IIFE + 内部 await，见文档 §1） */
const SNAPSHOT_PROMISE = `
  const snap = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('snapshot-reply timeout')), 6000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
        clearTimeout(t); window.removeEventListener('message', h); resolve(e.data);
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
  });`;

/**
 * 一次完整读数：trace + 护栏原值 + 用户可见结果。
 *
 * `pgcReload` 是**产品自己**的埋点（`content.ts:169` 定义、`:468` 经 `page/snapshot:ok` 送出），
 * 不是从代码顺序推的。
 */
const READ_EXPR = `(async () => {
  try {
${SNAPSHOT_PROMISE}
    const p = snap.pgcReload || {};
    const s = snap.snapshot || null;
    const v = document.querySelector('video');
    // 护栏原值：直接读 sessionStorage 里那条键（不经过产品代码）
    const guards = {};
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (k && k.indexOf('pluma:pgc-reload') === 0) guards[k] = sessionStorage.getItem(k);
    }
    const pgcKeys = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (k && k.indexOf('pluma:pgc') === 0) pgcKeys.push(k);
    }
    return JSON.stringify({
      phase: 'read',
      pgcReload: p,
      guards,
      pgcSessionKeys: pgcKeys,
      proxy: s && s.proxy ? { enabled: s.proxy.enabled, ruleCount: s.proxy.ruleCount } : null,
      page: s && s.page ? { kind: s.page.kind, pageKey: s.page.pageKey } : null,
      video: v ? { duration: v.duration, w: v.videoWidth, h: v.videoHeight, t: v.currentTime } : null,
      href: location.href,
      at: Math.round(performance.now()),
      at_epoch: Date.now()
    });
  } catch (e) {
    return JSON.stringify({ phase: 'read', error: String(e && e.message ? e.message : e) });
  }
})()`;

/** 主世界诊断对象（时序链，用于判定 setter 是否重新触发） */
const MAIN_EXPR = `(() => {
  const t = window.__PLUMA_PGC__ || null;
  if (!t) return JSON.stringify({ phase: 'main', error: 'no __PLUMA_PGC__' });
  return JSON.stringify({
    phase: 'main',
    bootAt: t.bootAt, ssAt: t.ssAt, ssHit: t.ssHit, ssCid: t.ssCid,
    patchedAt: t.patchedAt, patchedInSetter: t.patchedInSetter,
    swapCount: t.swapCount, swapLastCid: t.swapLastCid,
    lastStage: t.lastStage, cacheBytes: t.cacheBytes,
    now: Math.round(performance.now())
  });
})()`;

/** 场景准备：只清 PGC 缓存与护栏（**不碰** ADR 0028 的 localStorage 标记） */
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
  return JSON.stringify({ phase: 'reset', removed });
})()`;

/** 只清护栏（路径 1/2/4 需要「先有护栏」的状态，缓存留着） */
const CLEAR_GUARD_ONLY_EXPR = `(() => {
  const removed = [];
  const ks = [];
  for (let i = 0; i < sessionStorage.length; i += 1) ks.push(sessionStorage.key(i));
  for (const k of ks) {
    if (k && k.indexOf('pluma:pgc-reload') === 0) { sessionStorage.removeItem(k); removed.push(k); }
  }
  return JSON.stringify({ phase: 'clear-guard-only', removed });
})()`;

/** 拨总开关（`set-proxy` 桥；`enabled` 必须真布尔） */
function setProxyExpr(enabled) {
  return `(async () => {
  try {
    const r = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('set-proxy-reply timeout')), 5000);
      const h = (e) => {
        if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'set-proxy-reply') {
          clearTimeout(t); window.removeEventListener('message', h); resolve(e.data);
        }
      };
      window.addEventListener('message', h);
      window.postMessage({ __ns: '__PLUMA__', type: 'set-proxy', enabled: ${enabled ? 'true' : 'false'} }, '*');
    });
    return JSON.stringify({ phase: 'set-proxy', reply: r });
  } catch (e) {
    return JSON.stringify({ phase: 'set-proxy', error: String(e && e.message ? e.message : e) });
  }
})()`;
}

/** 找「下一集」链接（SPA 内点选集，路径 3a） */
const NEXT_EP_EXPR = `(() => {
  const cur = Number((/ep(\\d+)/.exec(location.href) || [])[1] || 0);
  const links = [...document.querySelectorAll('a[href*="/bangumi/play/ep"]')]
    .map((a) => ({ a, ep: Number((/ep(\\d+)/.exec(a.getAttribute('href')) || [])[1] || 0) }))
    .filter((x) => x.ep > cur);
  links.sort((x, y) => x.ep - y.ep);
  if (!links[0]) return JSON.stringify({ found: false });
  const href = links[0].a.getAttribute('href');
  links[0].a.setAttribute('data-pluma-probe', '1');
  return JSON.stringify({ found: true, ep: links[0].ep, href });
})()`;

// ── 报告与工具 ────────────────────────────────────────────────────────────────

const report = {
  generated_at: new Date().toISOString(),
  session: SID,
  tab: TAB,
  ep: EP,
  alt_ep: EP_ALT,
  wait_ms: WAIT_MS,
  preflight: null,
  // 每处写操作都记下来（诚实口径：清过什么、拨了什么）
  preparations: [],
  steps: [],
  verdicts: [],
};

const log = (s) => {
  if (!AS_JSON) console.log(s);
};

function step(name, data) {
  report.steps.push({ name, at: new Date().toISOString(), data });
  return data;
}

function read(label) {
  const r = evaluate(READ_EXPR);
  const m = evaluate(MAIN_EXPR);
  const rec = {
    label,
    captured_at: new Date().toISOString(),
    pgcReload: r.ok ? r.value?.pgcReload ?? null : { error: r.err },
    guards: r.ok ? r.value?.guards ?? null : null,
    pgcSessionKeys: r.ok ? r.value?.pgcSessionKeys ?? null : null,
    proxy: r.ok ? r.value?.proxy ?? null : null,
    video: r.ok ? r.value?.video ?? null : null,
    href: r.ok ? r.value?.href ?? null : null,
    main: m.ok ? m.value ?? null : { error: m.err },
    read_error: r.ok ? null : r.err,
  };
  return step(label, rec);
}

/** 从护栏原值里取 attempts（数值），没有键 → null */
function guardAttempts(rec) {
  const g = rec?.guards;
  if (!g) return null;
  const ks = Object.keys(g);
  if (ks.length === 0) return null;
  const parsed = tryJson(g[ks[0]]);
  return parsed && typeof parsed.attempts === 'number' ? parsed.attempts : null;
}

function guardKeyCount(rec) {
  return rec?.guards ? Object.keys(rec.guards).length : 0;
}

function verdict(name, pass, detail) {
  const v = { path: name, pass, detail, at: new Date().toISOString() };
  report.verdicts.push(v);
  log(`  → [${pass ? 'PASS' : 'FAIL'}] ${name}: ${detail}`);
  return v;
}

function printRead(rec, indent = '  ') {
  const p = rec.pgcReload ?? {};
  log(
    `${indent}[${rec.label}] exit=${String(p.orchestrateExit)} calls=${String(p.orchestrateCalls)} ` +
      `patchedByUs=${String(p.ssrPatchedByUs)} truncated=${String(p.ssrTruncated)} hadSync=${String(p.hadSync)}`,
  );
  log(
    `${indent}  outcome=${String(p.lastGuardOutcome)} action=${String(p.lastGuardAction)} ` +
      `clearedByOutcome=${String(p.guardClearedByOutcome)} reloadIssued=${String(p.reloadIssued)} ` +
      `reloadWithGuardCalls=${String(p.reloadWithGuardCalls)}`,
  );
  log(
    `${indent}  guards=${JSON.stringify(rec.guards)} dur=${String(rec.video?.duration)} ` +
      `wh=${rec.video ? `${String(rec.video.w)}x${String(rec.video.h)}` : 'null'} proxy=${JSON.stringify(rec.proxy)}`,
  );
}

function reloadTab(reason) {
  report.preparations.push({ action: 'reload', reason, at: new Date().toISOString() });
  const r = bsk(['reload', '--session', SID, '--tab-id', TAB], { allowFail: true });
  if (r.status !== 0) log(`  ⚠️ reload 失败: ${(r.stderr || '').split('\n')[0]}`);
  sleep(WAIT_MS);
}

function navigate(url, reason) {
  report.preparations.push({ action: 'navigate', url, reason, at: new Date().toISOString() });
  bsk(['navigate', '--session', SID, '--tab-id', TAB, url], { allowFail: true });
  sleep(WAIT_MS);
}

// ── preflight：活扩展里到底有没有 ADR 0030 的埋点 ─────────────────────────────

function preflight() {
  log('=== preflight：确认活扩展含 ADR 0030 埋点（否则后面全是假数据）===');
  const rec = read('preflight');
  const p = rec.pgcReload ?? {};
  const hasOutcome = Object.prototype.hasOwnProperty.call(p, 'lastGuardOutcome');
  const hasAction = Object.prototype.hasOwnProperty.call(p, 'lastGuardAction');
  const hasCleared = Object.prototype.hasOwnProperty.call(p, 'guardClearedByOutcome');
  const info = {
    allKeys: Object.keys(p),
    hasLastGuardOutcome: hasOutcome,
    hasLastGuardAction: hasAction,
    hasGuardClearedByOutcome: hasCleared,
    href: rec.href,
    ok: hasOutcome && hasAction && hasCleared,
  };
  report.preflight = info;

  if (read_failed(rec)) {
    log(`  ✗ 读不到 trace（${String(rec.read_error)}）—— 页面可能不是播放页，或扩展没注入`);
    return { status: 'unreadable' };
  }
  if (!info.ok) {
    log(`  ✗ **构建过期**：trace 只有 ${String(info.allKeys.length)} 个字段，c 的三个新埋点缺失`);
    log(`    allKeys = ${JSON.stringify(info.allKeys)}`);
    log('    → 必须先重建（pnpm build）并重新加载 .output/chrome-mv3，再来跑本脚本');
    return { status: 'stale-build' };
  }
  log(`  ✓ 埋点在位（字段数 ${String(info.allKeys.length)}）`);
  printRead(rec);
  return { status: 'ok', rec };
}

function read_failed(rec) {
  return rec?.pgcReload === null || rec?.read_error !== null;
}

// ── 路径 1：关开总开关 ───────────────────────────────────────────────────────

/**
 * 这条是 **lead 判断的裁决点**。
 *
 * 场景：让这一集先有护栏（它必须挡住下一轮），然后关开关、重开。
 * ADR 0028 第三层会在 `isProxyReenabled(false→true)` 那一刻 `clearPgcReloadGuards()`。
 *
 * ⚠️ 用户任务原文要求「关总开关 → 观察护栏是否被清掉 → 重开开关 → 刷新 → 护栏不应拦住取流」。
 * 第三层的清护栏发生在**重开**那一刻（不是关闭），所以本脚本在两处都读：关后、开后。
 */
function path1() {
  log('');
  log('=== 路径 1：关开总开关（c 能否取代 ADR 0028 第三层）===');

  // 场景准备：先让这一集有护栏，这样"清没清"才可观测
  const pre = read('p1-before-prep');
  log(`  准备前护栏条数 = ${String(guardKeyCount(pre))}（attempts=${String(guardAttempts(pre))}）`);

  // 若本来没有护栏，手动放一条「已满额」的护栏（模拟"本会话已刷过"），
  // 这正是第三层要补的洞 2 的状态。记为场景准备，报告里明说。
  if (guardKeyCount(pre) === 0) {
    const cid = pre.pgcReload?.cid ?? '';
    if (cid) {
      const expr = `(() => {
        sessionStorage.setItem('pluma:pgc-reload:' + ${JSON.stringify(cid)}, JSON.stringify({ attempts: 2, at: Date.now() }));
        return JSON.stringify({ seeded: 'pluma:pgc-reload:' + ${JSON.stringify(cid)} });
      })()`;
      const seeded = evaluate(expr);
      report.preparations.push({
        action: 'seed-guard',
        key: `pluma:pgc-reload:${cid}`,
        value: { attempts: 2, at: '<now>' },
        reason: '让本集处于"本会话已刷满额"的状态，才能观测第三层是否清掉它',
        result: seeded.value ?? seeded.err,
        at: new Date().toISOString(),
      });
      log(`  已植入护栏（attempts=2, cid=${cid}）—— 见 preparations`);
    }
  }

  const beforeOff = read('p1-before-off');
  log(
    `  关闭前：护栏 ${String(guardKeyCount(beforeOff))} 条，attempts=${String(guardAttempts(beforeOff))}，` +
      `proxy.enabled=${String(beforeOff.proxy?.enabled)}`,
  );

  // 关总开关
  const off = evaluate(setProxyExpr(false));
  report.preparations.push({
    action: 'set-proxy',
    enabled: false,
    reply: off.value?.reply ?? off.err,
    at: new Date().toISOString(),
  });
  log(`  关闭开关 → ${JSON.stringify(off.value?.reply ?? off.err)}`);
  sleep(2500); // 等 storage.onChanged 传播

  const afterOff = read('p1-after-off');
  log(
    `  关闭后：护栏 ${String(guardKeyCount(afterOff))} 条（attempts=${String(guardAttempts(afterOff))}），` +
      `proxy.enabled=${String(afterOff.proxy?.enabled)}`,
  );

  // 重开总开关 —— 第三层的清护栏就发生在这里
  const on = evaluate(setProxyExpr(true));
  report.preparations.push({
    action: 'set-proxy',
    enabled: true,
    reply: on.value?.reply ?? on.err,
    at: new Date().toISOString(),
  });
  log(`  重开开关 → ${JSON.stringify(on.value?.reply ?? on.err)}`);
  sleep(2500);

  const afterOn = read('p1-after-on');
  log(
    `  重开后：护栏 ${String(guardKeyCount(afterOn))} 条（attempts=${String(guardAttempts(afterOn))}），` +
      `proxy.enabled=${String(afterOn.proxy?.enabled)}`,
  );

  const layer3Cleared = guardKeyCount(afterOn) === 0 && guardKeyCount(beforeOff) >= 0;

  // 重开后刷新，看护栏有没有挡住取流
  reloadTab('路径 1：重开开关后的刷新，验证护栏不挡取流');
  const afterReload = read('p1-after-reload');
  printRead(afterReload);

  const p = afterReload.pgcReload ?? {};
  // "护栏没挡住"的判据：orchestratePgc 走到了能取流的分支（不是被 alreadyTried 提前 return）
  const notBlocked =
    p.orchestrateExit !== '' &&
    p.orchestrateExit !== 'pending' &&
    !String(p.lastReason ?? '').includes('不再取流');
  const guardGone = guardKeyCount(afterReload) === 0;
  const playerOk = typeof afterReload.video?.duration === 'number' && afterReload.video.duration > 180;
  const reloadIssued = Number(p.reloadIssued ?? 0);

  verdict(
    '1 关开总开关',
    layer3Cleared && notBlocked && playerOk && reloadIssued <= 2,
    `第三层清护栏=${String(layer3Cleared)}（before=${String(guardAttempts(beforeOff))}→after=${String(guardKeyCount(afterOn))}条）` +
      ` notBlocked=${String(notBlocked)}(exit=${String(p.orchestrateExit)})` +
      ` dur=${String(afterReload.video?.duration)} reloadIssued=${String(reloadIssued)}` +
      ` | outcome=${String(p.lastGuardOutcome)}/action=${String(p.lastGuardAction)}`,
  );

  /**
   * **对 lead 判断的直接回答**：这一轮（重开后刷新）的 outcome 到底是什么。
   * 若 `lastGuardAction === 'clear'` 且 `guardClearedByOutcome` 增长 → c 也能清 → lead 需修正。
   */
  report.path1_outcome_evidence = {
    lastGuardOutcome: p.lastGuardOutcome ?? null,
    lastGuardAction: p.lastGuardAction ?? null,
    guardClearedByOutcome: p.guardClearedByOutcome ?? 0,
    guardKeysBeforeReload: guardKeyCount(afterOn),
    guardKeysAfterReload: guardKeyCount(afterReload),
    note:
      "若第三层把护栏清了、且本轮 outcome 仍是 still-truncated，则 c 在本场景**不清**，第三层不可省；" +
      '若 lastGuardAction === clear 则说明 c 也能收尾，lead 判断需修正',
  };
  return afterReload;
}

// ── 路径 2：手动 F5 ──────────────────────────────────────────────────────────

function path2() {
  log('');
  log('=== 路径 2：手动 F5（成功集，c 应按结果清护栏）===');

  const before = read('p2-before-f5');
  const p0 = before.pgcReload ?? {};
  if (p0.ssrPatchedByUs !== true) {
    log(`  ⚠️ 前置不成立：ssrPatchedByUs=${String(p0.ssrPatchedByUs)}（需要 true = 成功注入过的集）`);
  }
  const clearedBefore = Number(p0.guardClearedByOutcome ?? 0);
  log(
    `  F5 前：patchedByUs=${String(p0.ssrPatchedByUs)} clearedByOutcome=${String(clearedBefore)} ` +
      `guards=${String(guardKeyCount(before))} dur=${String(before.video?.duration)}`,
  );

  // 放一条护栏，模拟"本会话已刷过"（否则没有可清的对象，guardClearedByOutcome 不会增长）
  const cid = p0.cid ?? '';
  if (cid && guardKeyCount(before) === 0) {
    const expr = `(() => {
      sessionStorage.setItem('pluma:pgc-reload:' + ${JSON.stringify(cid)}, JSON.stringify({ attempts: 1, at: Date.now() }));
      return JSON.stringify({ seeded: true });
    })()`;
    evaluate(expr);
    report.preparations.push({
      action: 'seed-guard',
      key: `pluma:pgc-reload:${cid}`,
      value: { attempts: 1, at: '<now>' },
      reason: '路径 2 需要一条"本会话已刷过"的护栏，才能观测 c 是否按结果清掉它',
      at: new Date().toISOString(),
    });
    log('  已植入护栏（attempts=1）');
  }

  reloadTab('路径 2：手动 F5');
  const after = read('p2-after-f5');
  printRead(after);

  const p1 = after.pgcReload ?? {};
  const clearedAfter = Number(p1.guardClearedByOutcome ?? 0);
  /**
   * ⚠️ **`guardClearedByOutcome` 是「本 document」的计数器**，不是跨轮次累计。
   *
   * 实测（2026-10-30，第一版脚本在这里误判成 FAIL）：
   * ```
   * F5 前：clearedByOutcome=1   （旧 document）
   * F5 后：clearedByOutcome=1   （新 document，从 0 重新计到 1）
   * ```
   * 简单的 `after > before` 会得到「未增长」的错误结论 —— 因为两边是**两个不同的计数器**。
   *
   * 正确判据分两条，任一成立即证明 c 生效：
   *   1. F5 后新 document 里 `clearedByOutcome >= 1`（本轮按结果清过）
   *   2. F5 后护栏键**确实没了**（`guards` 为空）
   * 单看 1 而不看 2 会被"本来就没护栏"骗过；所以两条一起要求。
   */
  const grewInNewDocument = clearedAfter >= 1;
  const guardsLeft = guardKeyCount(after);
  const dur = after.video?.duration;
  const reloadIssued = Number(p1.reloadIssued ?? 0);

  verdict(
    '2 手动 F5',
    grewInNewDocument && guardsLeft === 0 && reloadIssued <= 2,
    `新 document 的 guardClearedByOutcome=${String(clearedAfter)}（F5 前旧 document 是 ${String(clearedBefore)}，` +
      `两个计数器不跨 reload 累计） 剩余护栏=${String(guardsLeft)} ` +
      `outcome=${String(p1.lastGuardOutcome)}/action=${String(p1.lastGuardAction)} ` +
      `dur=${String(dur)} reloadIssued=${String(reloadIssued)}`,
  );
  return after;
}

// ── 路径 3：切走再切回（三种子场景） ─────────────────────────────────────────

function path3() {
  log('');
  log('=== 路径 3：切走再切回（区分 SPA / 整页重进 / 浏览器后退）===');

  // ---- 3a：SPA 内点选集 → 预期**不**触发 orchestratePgc ----
  log('  [3a] SPA 内点选集 → 预期**不**触发 orchestratePgc（走 ADR 0023 响应层）');
  const b3a = read('p3a-before');
  const callsBefore = Number(b3a.pgcReload?.orchestrateCalls ?? 0);
  const linkInfo = evaluate(NEXT_EP_EXPR);
  if (linkInfo.ok && linkInfo.value?.found) {
    const clicked = bsk(
      ['click', '--session', SID, '--tab-id', TAB, '[data-pluma-probe="1"]'],
      { allowFail: true },
    );
    log(`    点击 ep${String(linkInfo.value.ep)} : ${(clicked.stdout || clicked.stderr || '').trim().split('\n')[0]}`);
    sleep(Math.min(WAIT_MS, 9000));
    const a3a = read('p3a-after');
    const callsAfter = Number(a3a.pgcReload?.orchestrateCalls ?? 0);
    const setterRefired =
      (a3a.main?.ssAt ?? null) !== (b3a.main?.ssAt ?? null) ||
      (a3a.main?.patchedAt ?? null) !== (b3a.main?.patchedAt ?? null);
    const orchestrateRefired = callsAfter !== callsBefore;
    log(
      `    orchestrateCalls ${String(callsBefore)}→${String(callsAfter)}（再触发=${String(orchestrateRefired)}）` +
        ` setter 再触发=${String(setterRefired)} swapCount=${String(a3a.main?.swapCount)} dur=${String(a3a.video?.duration)}`,
    );
    verdict(
      '3a SPA 内点选集',
      !orchestrateRefired,
      `orchestratePgc 再触发=${String(orchestrateRefired)}（calls ${String(callsBefore)}→${String(callsAfter)}）` +
        ` setter 再触发=${String(setterRefired)} swapCount=${String(a3a.main?.swapCount)} → 与 ADR 0030 记录一致（SPA 走响应层）`,
    );
  } else {
    log('    未找到下一集链接 → **未测**');
    verdict('3a SPA 内点选集', false, '未测：页面上找不到"下一集"链接');
  }

  // ---- 3b：整页重进同一集（address bar 回车）→ 预期**触发** ----
  log('  [3b] 整页重进同一集（navigate 同一 URL）→ 预期**触发** orchestratePgc');
  const b3b = read('p3b-before');
  const callsB = Number(b3b.pgcReload?.orchestrateCalls ?? 0);
  const clearedB = Number(b3b.pgcReload?.guardClearedByOutcome ?? 0);
  navigate(`https://www.bilibili.com/bangumi/play/${EP}`, '路径 3b：整页重进同一集（等价 address bar 回车）');
  const a3b = read('p3b-after');
  printRead(a3b, '    ');
  const callsA = Number(a3b.pgcReload?.orchestrateCalls ?? 0);
  const clearedA = Number(a3b.pgcReload?.guardClearedByOutcome ?? 0);
  const refired3b = callsA >= 1; // 整页重载后 trace 是新的，calls 从 0 起算
  verdict(
    '3b 整页重进同一集',
    refired3b,
    `整页重载后 orchestrateCalls=${String(callsA)}（整页加载后 trace 重置，≥1 即证明触发）` +
      ` exit=${String(a3b.pgcReload?.orchestrateExit)} clearedByOutcome=${String(clearedB)}→${String(clearedA)}` +
      ` dur=${String(a3b.video?.duration)}`,
  );

  // ---- 3c：切到别的集再浏览器后退 → 如实记录是否触发 ----
  log('  [3c] 整页进另一集 → 浏览器后退 → **如实记录**是否触发 orchestratePgc');
  navigate(
    `https://www.bilibili.com/bangumi/play/${EP_ALT}`,
    '路径 3c：先整页进入另一集，再后退回来',
  );
  const onAlt = read('p3c-on-alt');
  log(
    `    在 ${EP_ALT}：exit=${String(onAlt.pgcReload?.orchestrateExit)} calls=${String(onAlt.pgcReload?.orchestrateCalls)} ` +
      `dur=${String(onAlt.video?.duration)}`,
  );
  const callsOnAlt = Number(onAlt.pgcReload?.orchestrateCalls ?? 0);
  const clearedOnAlt = Number(onAlt.pgcReload?.guardClearedByOutcome ?? 0);
  // 浏览器后退
  try {
    bsk(['back', '--session', SID, '--tab-id', TAB], { allowFail: true });
  } catch {
    evaluate('(() => { history.back(); return JSON.stringify({ok:true}); })()');
  }
  report.preparations.push({
    action: 'history-back',
    reason: '路径 3c：从另一集浏览器后退回原集',
    at: new Date().toISOString(),
  });
  sleep(WAIT_MS);
  const afterBack = read('p3c-after-back');
  printRead(afterBack, '    ');
  const callsAfterBack = Number(afterBack.pgcReload?.orchestrateCalls ?? 0);
  const refired3c = callsAfterBack >= 1;
  verdict(
    '3c 切走再浏览器后退',
    true, // 这条是"如实记录"，不预设期望
    `后退后 orchestrateCalls=${String(callsAfterBack)}（在另一集时=${String(callsOnAlt)}，clearedByOutcome=${String(clearedOnAlt)}）` +
      ` → ${refired3c ? '触发' : '未触发'}（记录用，不预设期望）；` +
      ` exit=${String(afterBack.pgcReload?.orchestrateExit)} dur=${String(afterBack.video?.duration)}`,
  );
  return afterBack;
}

// ── 路径 4：TTL 内重开 ───────────────────────────────────────────────────────

function path4() {
  log('');
  log('=== 路径 4：TTL 内重开（护栏未过期，成功集不应被挡住）===');

  const before = read('p4-before');
  printRead(before);
  const p0 = before.pgcReload ?? {};
  const cid = p0.cid ?? '';

  // 放一条**新鲜**护栏（attempts 满额、at=现在），这正是"TTL 内重开"的状态
  if (cid) {
    const expr = `(() => {
      sessionStorage.setItem('pluma:pgc-reload:' + ${JSON.stringify(cid)}, JSON.stringify({ attempts: 2, at: Date.now() }));
      return JSON.stringify({ seeded: true, attempts: 2, at: Date.now() });
    })()`;
    const seeded = evaluate(expr);
    report.preparations.push({
      action: 'seed-guard',
      key: `pluma:pgc-reload:${cid}`,
      value: { attempts: 2, at: '<now>（未过期，TTL 10min）' },
      reason: '路径 4 要构造"护栏未过期"的状态；若不清，TTL 内重开会证明 c 是否会清它',
      result: seeded.value ?? seeded.err,
      at: new Date().toISOString(),
    });
    log(`  已植入新鲜护栏（attempts=2，未过期）：pluma:pgc-reload:${cid}`);
  }

  const clearedBefore = Number(p0.guardClearedByOutcome ?? 0);
  reloadTab('路径 4：TTL 内重开（护栏未过期）');
  const after = read('p4-after');
  printRead(after);

  const p1 = after.pgcReload ?? {};
  const dur = after.video?.duration;
  const playerOk = typeof dur === 'number' && dur > 180;
  const clearedAfter = Number(p1.guardClearedByOutcome ?? 0);
  /**
   * 同路径 2 的教训：`guardClearedByOutcome` 是**本 document** 的计数器，
   * reload 之后从 0 重新计，**不能**拿跨 reload 的 `after > before` 判增长。
   * 正确判据：新 document 里 `>= 1` **且** 护栏键确实没了。
   */
  const grewInNewDocument = clearedAfter >= 1;
  const guardsLeft = guardKeyCount(after);
  const notBlocked = !String(p1.lastReason ?? '').includes('不再取流');
  const reloadIssued = Number(p1.reloadIssued ?? 0);

  verdict(
    '4 TTL 内重开',
    playerOk && grewInNewDocument && guardsLeft === 0 && notBlocked && reloadIssued <= 2,
    `重开后（新 document）outcome=${String(p1.lastGuardOutcome)}/action=${String(p1.lastGuardAction)}` +
      ` guardClearedByOutcome=${String(clearedAfter)}（旧 document 是 ${String(clearedBefore)}，不跨 reload 累计）` +
      ` 剩余护栏=${String(guardsLeft)} dur=${String(dur)}` +
      ` notBlocked=${String(notBlocked)} reloadIssued=${String(reloadIssued)}`,
  );
  return after;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

log('=== ADR 0030 方案 c：四条真机路径回归 ===');
log(`session=${SID} tab=${TAB} ep=${EP} alt=${EP_ALT} wait=${String(WAIT_MS)}ms only=${ONLY || 'all'}`);
log('');

const pf = preflight();
if (pf.status !== 'ok') {
  // 读不到 / 构建过期，都不进入场景 —— 否则产出的是假结论
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  else {
    log('');
    log('=== 未能实测 ===');
    log(
      pf.status === 'stale-build'
        ? '构建过期：活扩展无 ADR 0030 埋点。请先 pnpm build 并在 edge://extensions 重新加载。'
        : '读不到 trace：确认页面是番剧播放页、扩展已注入。',
    );
    log(`复跑：node poc/probe/probe-pgc-guard-paths.mjs ${SID} ${TAB} ${EP}`);
  }
  process.exit(pf.status === 'stale-build' ? 4 : 3);
}

const run = (key) => !ONLY || ONLY === key;

if (run('1')) path1();
if (run('2')) path2();
if (run('3')) path3();
if (run('4')) path4();

// ---- 汇总 ----
if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  log('');
  log('=== 汇总 ===');
  let allPass = true;
  for (const v of report.verdicts) {
    if (!v.pass) allPass = false;
    log(`${v.pass ? 'PASS' : 'FAIL'}  ${v.path}`);
    log(`      ${v.detail}`);
  }
  if (report.path1_outcome_evidence) {
    log('');
    log('--- 路径 1 对「c 能否取代 ADR 0028 第三层」的证据 ---');
    log(`  ${JSON.stringify(report.path1_outcome_evidence)}`);
  }
  log('');
  log('清过的东西（preparations）：');
  for (const p of report.preparations) log(`  - ${JSON.stringify(p)}`);
  log('');
  log(`复跑：node poc/probe/probe-pgc-guard-paths.mjs ${SID} ${TAB} ${EP}`);
  process.exit(allPass ? 0 : 1);
}

process.exit(report.verdicts.every((v) => v.pass) ? 0 : 1);
