#!/usr/bin/env node
/**
 * 路径 1 的**严格版**：真正构造出 lead 所说的 `still-truncated` 那一轮。
 *
 * ## 为什么需要这个脚本（第一版的教训）
 *
 * `probe-pgc-guard-paths.mjs --only=1` 的 `set-proxy false → true → reload`
 * 在真机上**没能**复现 `still-truncated`：
 *
 * ```
 * p1-after-reload: exit=cache-hadsync-no-reload patchedByUs=true truncated=false hadSync=true
 *                  outcome=injected action=clear dur=1441
 * ```
 *
 * 原因是 **ADR 0028 第二层（清 `pluma:pgc-vi:*`）挂在 `page/activate` 的回包上，
 * 且只在 `res.reason === 'disabled'` 时执行**（`entrypoints/content.ts:1810`）。
 * 拨开关本身**不刷新页面**，所以那一次回包根本不会发生 ——
 * sessionStorage 里的 92KB 缓存原封不动（实测读数见下），
 * 于是重开后的 reload 仍然命中缓存 → `pgcPatched = true` → `injected`。
 *
 * ## 真正的 `still-truncated` 怎么构造
 *
 * 要让「缓存没了、SSR 仍是试看流」同时成立，必须**在开关关着的情况下整页 reload**：
 *
 * ```
 * ① reload（开关=开）      → 缓存命中，injected
 * ② set-proxy false
 * ③ **reload**（开关=关）   → page/activate 回 reason:'disabled'
 *                            → 第二层 clearPgcSessionCache() 真的清掉 pluma:pgc-vi:*
 *                            → 主世界第一层门控生效，不注入
 *                            → 本轮 outcome = still-truncated（护栏保留/消耗一次）
 * ④ set-proxy true         → 第三层 clearPgcReloadGuards()
 * ⑤ reload（开关=开）      → **无缓存** + SSR 仍是试看
 *                            → 这一轮的 outcome 到底是 still-truncated 还是 injected？
 *                            → 若 still-truncated：c 不清护栏，**第三层不可省**（lead 判断成立）
 *                            → 若 injected/clear：c 能收尾，lead 判断需修正
 * ```
 *
 * **⑤ 这一次加载就是裁决点。** 本脚本把它单独标成 `verdict_round` 并原样打印。
 *
 * ## 只读 + 最小的写
 *
 * 唯一的写：`set-proxy`（拨开关）、`reload`、以及**植入一条护栏**
 * （否则"清没清"没有可观测对象）。全部记进 `preparations[]`。
 * **不碰**第一层的 `localStorage` 标记、不手工清 `pluma:pgc-vi:*`
 * （第二层由产品自己清，本脚本只**观测**它清没清 —— 这是关键，否则就是自己造的数据）。
 *
 * 用法：
 * ```bash
 * node poc/probe/probe-pgc-path1-strict.mjs <session-id> <tab-id> [ep号] [--json]
 * ```
 *
 * 退出码：
 *   0 = 裁决轮 outcome 为 `still-truncated`（→ 证明 c 在本场景不清护栏，第三层必需）
 *   1 = 裁决轮 outcome 为 `injected`/`native-complete`（→ c 也能清，lead 判断需修正）
 *   2 = 参数错误
 *   3 = 未能构造（第 ③ 步没清掉缓存 / 读不到 trace）
 *   4 = 构建过期（无 ADR 0030 埋点）
 */

import { spawnSync } from 'node:child_process';

const BSK = process.env.BSK_BIN || 'bsk';
const argv = process.argv.slice(2);
const SID = argv[0];
const TAB = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
const EP = argv[2] && !argv[2].startsWith('--') ? argv[2] : 'ep341217';
const AS_JSON = argv.includes('--json');
const WAIT_MS = Number((argv.find((a) => a.startsWith('--wait=')) ?? '--wait=11000').slice(7));

if (!SID || !TAB) {
  console.error(
    '用法: node poc/probe/probe-pgc-path1-strict.mjs <session-id> <tab-id> [ep号] [--json] [--wait=11000]',
  );
  process.exit(2);
}

function bsk(args) {
  const r = spawnSync(BSK, args, {
    env: { ...process.env, BSK_AUTO_START: '0' },
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function sleep(ms) {
  const r = bsk(['wait-ms', String(ms)]);
  if (r.status === 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* 自旋兜底 */
  }
}

function evaluate(expression) {
  const r = bsk(['evaluate', '--session', SID, '--tab-id', TAB, expression]);
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) return { ok: false, err: (r.stderr || out).slice(0, 400) };
  try {
    const p = JSON.parse(out);
    return { ok: true, value: typeof p === 'string' ? tryJson(p) : p };
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

const READ_EXPR = `(async () => {
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
    const p = snap.pgcReload || {};
    const s = snap.snapshot || null;
    const v = document.querySelector('video');
    const guards = {};
    const pgcSs = {};
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (!k) continue;
      const val = String(sessionStorage.getItem(k));
      if (k.indexOf('pluma:pgc-reload') === 0) guards[k] = val;
      if (k.indexOf('pluma:pgc-vi:') === 0) pgcSs[k] = val.length;
    }
    const ls = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.indexOf('pluma') === 0) ls[k] = String(localStorage.getItem(k)).slice(0, 80);
    }
    return JSON.stringify({
      pgcReload: p, guards, pgcViSizes: pgcSs, localStorage: ls,
      proxy: s && s.proxy ? s.proxy.enabled : null,
      video: v ? { duration: v.duration, w: v.videoWidth, h: v.videoHeight } : null,
      at_epoch: Date.now(),
    });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
})()`;

function read(label) {
  const r = evaluate(READ_EXPR);
  return { label, at: new Date().toISOString(), ...(r.ok ? r.value : { error: r.err }) };
}

const setProxyExpr = (enabled) => `(async () => {
  try {
    const r = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('set-proxy-reply timeout')), 5000);
      const h = (e) => {
        if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'set-proxy-reply') {
          clearTimeout(t); window.removeEventListener('message', h); resolve(e.data);
        }
      };
      window.addEventListener('message', h);
      window.postMessage({ __ns: '__PLUMA__', type: 'set-proxy', enabled: ${enabled} }, '*');
    });
    return JSON.stringify(r);
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
})()`;

const report = { generated_at: new Date().toISOString(), session: SID, tab: TAB, ep: EP, preparations: [], rounds: {}, verdicts: [] };
const log = (s) => { if (!AS_JSON) console.log(s); };

function record(round, rec) {
  report.rounds[round] = rec;
  log(
    `  [${rec.label}] proxy=${String(rec.proxy)} exit=${String(rec.pgcReload?.orchestrateExit)} ` +
      `calls=${String(rec.pgcReload?.orchestrateCalls)} patchedByUs=${String(rec.pgcReload?.ssrPatchedByUs)} ` +
      `truncated=${String(rec.pgcReload?.ssrTruncated)} hadSync=${String(rec.pgcReload?.hadSync)}`,
  );
  log(
    `      outcome=${String(rec.pgcReload?.lastGuardOutcome)} action=${String(rec.pgcReload?.lastGuardAction)} ` +
      `cleared=${String(rec.pgcReload?.guardClearedByOutcome)} reloadIssued=${String(rec.pgcReload?.reloadIssued)} ` +
      `dur=${String(rec.video?.duration)} guards=${Object.keys(rec.guards ?? {}).length} ` +
      `pgcViSizes=${JSON.stringify(rec.pgcViSizes)} ls=${JSON.stringify(rec.localStorage)}`,
  );
  return rec;
}

function reload(reason) {
  report.preparations.push({ action: 'reload', reason, at: new Date().toISOString() });
  bsk(['reload', '--session', SID, '--tab-id', TAB]);
  sleep(WAIT_MS);
}

function setProxy(enabled, reason) {
  const r = evaluate(setProxyExpr(enabled));
  report.preparations.push({ action: 'set-proxy', enabled, reason, reply: r.value ?? r.err, at: new Date().toISOString() });
  log(`  拨开关 → enabled=${String(enabled)} reply=${JSON.stringify(r.value ?? r.err)}`);
  sleep(2500);
  return r;
}

function seedGuard(rec, attempts, reason) {
  const cid = rec.pgcReload?.cid ?? '';
  if (!cid) {
    log('  ⚠️ 读不到 cid，无法植入护栏');
    return null;
  }
  const expr = `(() => {
    const k = 'pluma:pgc-reload:' + ${JSON.stringify(cid)};
    const v = JSON.stringify({ attempts: ${String(attempts)}, at: Date.now() });
    sessionStorage.setItem(k, v);
    return JSON.stringify({ key: k, value: v });
  })()`;
  const r = evaluate(expr);
  report.preparations.push({
    action: 'seed-guard',
    key: `pluma:pgc-reload:${cid}`,
    value: { attempts, at: '<now>' },
    reason,
    result: r.value ?? r.err,
    at: new Date().toISOString(),
  });
  log(`  植入护栏 attempts=${String(attempts)} cid=${cid}`);
  return r;
}

// ── preflight ────────────────────────────────────────────────────────────────

log('=== 路径 1 严格版：真正构造 still-truncated 裁决轮 ===');
const pre = read('preflight');
report.rounds.preflight = pre;
const hasAll =
  pre.pgcReload &&
  'lastGuardOutcome' in pre.pgcReload &&
  'lastGuardAction' in pre.pgcReload &&
  'guardClearedByOutcome' in pre.pgcReload;
if (!hasAll) {
  log('  ✗ 构建过期：缺 ADR 0030 埋点。先重建并重载扩展。');
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  process.exit(4);
}
log(`  ✓ 埋点在位（字段数 ${String(Object.keys(pre.pgcReload).length)}）`);
record('preflight', pre);

// ── ① 先保证这一轮有缓存命中（injected） ─────────────────────────────────────
log('');
log('① reload（开关=开）→ 期望缓存命中，建立"已完成注入"的基线');
reload('① 建立缓存命中基线');
record('round1_cached', read('① cached'));

// ── ② 关开关 ─────────────────────────────────────────────────────────────────
log('');
log('② 关总开关（不刷新）');
setProxy(false, '② 关闭总开关');

// ── ③ **开关关着时整页 reload** → 触发第二层清缓存 ──────────────────────────
log('');
log('③ **开关关着时整页 reload** —— 这一步才会触发 page/activate 回 disabled → 第二层清缓存');
reload('③ 开关关着时 reload，让 ADR 0028 第二层真正清掉 pluma:pgc-vi:*');
const r3 = record('round3_off_reloaded', read('③ off+reloaded'));

let cacheGone = Object.keys(r3.pgcViSizes ?? {}).length === 0;
log(`  ADR 0028 第二层是否清掉缓存 = ${String(cacheGone)}（剩 ${Object.keys(r3.pgcViSizes ?? {}).length} 条 pluma:pgc-vi:*）`);
report.second_layer = { cleared_cache: cacheGone, remaining: r3.pgcViSizes };

/**
 * ## 第二层没清时，由脚本自己清（**场景准备**，不是伪造结论）
 *
 * 实测（2026-10-30）：开关关着 reload 后，`pluma:pgc-vi:<cid>` 的 92,568B
 * 那份缓存**仍在**（`page/activate` 没回 `reason:'disabled'`，
 * 第二层的 `if (res.reason === 'disabled')` 就没进）。
 *
 * 但 c 的裁决点要的是「**无缓存** + SSR 仍是试看」这一轮，
 * 与"缓存是谁清掉的"无关 —— 用户手工清站点数据、换设备、TTL 过期都会造成同一状态。
 * 所以这里授权自己清，并**明确记进 preparations**，不冒充第二层的行为。
 */
if (!cacheGone) {
  const r = evaluate(`(() => {
    const removed = [];
    const ks = [];
    for (let i = 0; i < sessionStorage.length; i += 1) ks.push(sessionStorage.key(i));
    for (const k of ks) {
      if (k && k.indexOf('pluma:pgc-vi:') === 0) { sessionStorage.removeItem(k); removed.push(k); }
    }
    return JSON.stringify({ removed });
  })()`);
  report.preparations.push({
    action: 'remove-pgc-vi-cache',
    reason:
      'ADR 0028 第二层本轮未清（page/activate 未回 disabled）；为构造 c 的裁决轮（无缓存 + SSR 试看），由脚本清除。这不冒充第二层行为。',
    result: r.value ?? r.err,
    at: new Date().toISOString(),
  });
  cacheGone = Object.keys(read('③b after-manual-clear').pgcViSizes ?? {}).length === 0;
  log(`  脚本自行清缓存后：cacheGone = ${String(cacheGone)}`);
}

// 放一条护栏：模拟"上一轮已经刷过、护栏还在"
seedGuard(r3, 2, '③ 之后植入满额护栏：这是"关开关时护栏被保留"的状态（ADR 0028 第二层明确不清护栏）');

// ── ④ 重开开关 → 第三层清护栏 ────────────────────────────────────────────────
log('');
log('④ 重开总开关 → ADR 0028 第三层 clearPgcReloadGuards()');
const beforeOn = read('④ before-on');
log(`  重开前：护栏 ${Object.keys(beforeOn.guards ?? {}).length} 条`);
setProxy(true, '④ 重开总开关，触发第三层清护栏');
const afterOn = read('④ after-on');
record('round4_reenabled', afterOn);
const guardClearedByLayer3 = Object.keys(afterOn.guards ?? {}).length === 0;
log(`  → 第三层清护栏 = ${String(guardClearedByLayer3)}（剩 ${Object.keys(afterOn.guards ?? {}).length} 条）`);

// ── ⑤ 裁决轮：reload（开关=开，无缓存） ─────────────────────────────────────
log('');
log('⑤ **裁决轮**：reload（开关=开，缓存已被第二层清掉）');
reload('⑤ 裁决轮：无缓存 + 开关开，看本轮 outcome');
const r5 = record('round5_verdict', read('⑤ verdict'));

const outcome = r5.pgcReload?.lastGuardOutcome ?? null;
const action = r5.pgcReload?.lastGuardAction ?? null;
const dur = r5.video?.duration;
const reloadIssued = Number(r5.pgcReload?.reloadIssued ?? 0);

log('');
log('=== 裁决 ===');
log(`  裁决轮 outcome = ${String(outcome)}   action = ${String(action)}`);
log(`  dur = ${String(dur)}   reloadIssued = ${String(reloadIssued)}`);
log(`  第二轮缓存清掉 = ${String(cacheGone)}   第三层清护栏 = ${String(guardClearedByLayer3)}`);

const guardKept = Object.keys(r5.guards ?? {}).length;
log(`  裁决轮结束时护栏条数 = ${String(guardKept)}（attempts=${String(tryJson(Object.values(r5.guards ?? {})[0] ?? '')?.attempts)}）`);

report.verdict = {
  layer2_cleared_cache: cacheGone,
  layer3_cleared_guard: guardClearedByLayer3,
  verdict_round_outcome: outcome,
  verdict_round_action: action,
  duration: dur,
  reload_issued: reloadIssued,
  guard_keys_after: guardKept,
  interpretation:
    outcome === 'still-truncated'
      ? 'c 在本场景**不清**护栏（retry）→ ADR 0028 第三层不可省，lead 判断成立'
      : outcome === 'injected' || outcome === 'native-complete'
        ? 'c 在本场景**能清**护栏 → lead 判断需修正'
        : '未构造出可判定的裁决轮（见 preparations 与 rounds）',
};
log(`  → ${report.verdict.interpretation}`);

if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else {
  console.log('');
  console.log('清过 / 拨过的东西：');
  for (const p of report.preparations) console.log('  - ' + JSON.stringify(p));
}

process.exit(
  !cacheGone || outcome === null ? 3 : outcome === 'still-truncated' ? 0 : 1,
);
