#!/usr/bin/env node
/**
 * ADR 0028 第二层 → 第三层的**完整链路**真机验证（一次连续流程，不手工清缓存）。
 *
 * ## 这个脚本补哪个洞
 *
 * `poc/probe/probe-pgc-guard-paths.mjs` 的四条路径全 PASS，但明确留下一句：
 *
 * > 「ADR 0028 第二层**自己**清掉缓存 → 接第三层」的完整链路，未在一次连续流程里实测到。
 *
 * `poc/probe/probe-pgc-path1-strict.mjs` 想补，但它在第 288-301 行**手工**
 * `sessionStorage.removeItem('pluma:pgc-vi:*')` 去构造"无缓存"那一轮，并把它记进
 * `preparations` —— 那是**场景准备**，不是第二层的行为，所以链路仍然没测满。
 *
 * 本脚本**一次也不清缓存**。第二层清没清，靠**产品自己写下的日志**判定。
 *
 * ## 为什么不能靠"读 sessionStorage 空了没有"判第二层（本次实测踩到的坑）
 *
 * 直觉写法是「关开关 → reload → 看 `pluma:pgc-vi:*` 还在不在」。**这个判据是错的**：
 *
 * 1. 实测：开关关着 reload 后，`pluma:pgc-vi:262765010` = 92,568B **仍在**。
 *    但这不是"第二层没跑" —— 它的日志明明写着「已清 1 条同步缓存」。
 * 2. 真相是**清了又写回**。`entrypoints/content.ts:1293` 的 `writePgcSessionCache(cid, cached, epId)`
 *    会把 `chrome.storage.local` 里那份 LRU 缓存**重新写进** `sessionStorage`。
 *    实测日志（同一次加载）：
 *
 *    ```
 *    14.925  [PGC] ss cid=262765010 hit=true
 *    15.158  [PGC] 总开关已关闭，已清 1 条同步缓存      ← 第二层清了
 *    16.999  [PGC] 命中缓存并下发（… 同步缓存原有=false） ← 又写回来了
 *    ```
 *
 * 3. 更强证据：脚本把 `pluma:pgc-vi:*` 删空后，**开关关着**再 reload，
 *    新 document 里又出现 92,568B（`hadSync=false`）。也就是说这条路径上
 *    **缓存一定会被重新写入**，`sessionStorage` 的最终状态与第二层无关。
 *
 * → 所以判据只能是**第二层自己上报的那条 note**（`已清 N 条同步缓存`）。
 *
 * ## 判据从哪来：`chrome.storage.local` 的 `pluma:diag` 环形缓冲
 *
 * `entrypoints/content.ts` 在 `res.reason === 'disabled'` 时调
 * `reportQuality({ note: '[PGC] 总开关已关闭，已清 N 条同步缓存…' })`，
 * 而 `page/quality` 会落进 background 的 `pluma:diag` 环形缓冲（**产品自己写的**，
 * 不是本脚本造的）。同理第三层重开时写 `[PGC] 总开关已重开，已清 N 条刷新护栏`。
 *
 * 扩展是**解压加载**的，它的 `chrome.storage.local` 就是磁盘上的 LevelDB：
 *
 * ```
 * <Edge profile>/Local Extension Settings/<扩展ID>/0000NN.ldb|log
 * ```
 *
 * 本脚本**只读**这些文件（`fs.readFileSync` + 解析 JSON），不写、不删。
 * 扩展 ID 从 `Secure Preferences` 里按 `"path": "...Pluma\\.output\\chrome-mv3"` 反查，
 * 不写死（用户重载扩展会换 ID —— `reload-extension.mjs` 的坑）。
 *
 * ## 链路（每一步都留原始证据）
 *
 * ```
 * ① reload（开关=开）    → 记录 vi 字节数、outcome=injected
 * ② set-proxy false      → 确认 ruleCount=0、localStorage 标记写入
 * ③ reload（开关=关）    → **关键**：page/activate 回 disabled
 *                          → 第二层 clearPgcSessionCache() 执行
 *                          → 从 diag 读「已清 N 条同步缓存」
 *                          → 这一轮 outcome 应为 still-truncated / action=retry
 * ④ set-proxy true       → 第三层 clearPgcReloadGuards()
 *                          → 从 diag 读「已清 N 条刷新护栏」
 *                          → 护栏键应为空
 * ⑤ reload（开关=开）    → 护栏为空、dur=整集时长、reloadIssued 未失控
 * ```
 *
 * ## 允许的写（全部记进 `preparations[]`）
 *
 * - `set-proxy` 拨总开关（②④）
 * - `reload`（①③⑤）
 *
 * **不做**：手工清 `pluma:pgc-vi:*`（那正是要测的东西）、改 `src/` / `entrypoints/` / `docs/`、
 * 装删 DNR 规则、动凭据、升 bsk、起第二个 daemon、跑 `reload-extension.mjs`。
 *
 * ## 用法
 *
 * ```bash
 * # daemon 已在跑（不要起第二个）。先拿 session 与 tab：
 * #   bsk session start --no-focus --json    → session_id
 * #   bsk tab list --session <sid> --json    → agent 窗口里那条 tab_id
 *
 * node poc/probe/probe-pgc-layer2-chain.mjs <session-id> <tab-id> [ep号]
 * node poc/probe/probe-pgc-layer2-chain.mjs <sid> <tab> ep341217 --json
 * node poc/probe/probe-pgc-layer2-chain.mjs <sid> <tab> --wait=13000
 * node poc/probe/probe-pgc-layer2-chain.mjs <sid> <tab> --user-data-dir="C:\...\User Data"
 * ```
 *
 * 退出码：
 *   0 = 整条链路实测成立（第二层清了、那轮 still-truncated、第三层接住、末轮正常取流）
 *   1 = 链路不成立（详见 `verdicts[]`）——**重要发现，如实报**
 *   2 = 参数错误
 *   3 = 未能实测（读不到 trace / 找不到扩展存储 / 页面形态不对）
 *   4 = 构建过期（活扩展里没有 ADR 0030 埋点）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BSK = process.env.BSK_BIN || 'bsk';
const argv = process.argv.slice(2);
const SID = argv[0];
const TAB = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
const EP = argv[2] && !argv[2].startsWith('--') ? argv[2] : 'ep341217';
const AS_JSON = argv.includes('--json');
const WAIT_MS = Number((argv.find((a) => a.startsWith('--wait=')) ?? '--wait=13000').slice(7));
const USER_DATA_DIR = (argv.find((a) => a.startsWith('--user-data-dir=')) ?? '').slice(15) || null;

if (!SID || !TAB) {
  console.error(
    '用法: node poc/probe/probe-pgc-layer2-chain.mjs <session-id> <tab-id> [ep号] ' +
      '[--json] [--wait=13000] [--user-data-dir=<Edge User Data>]',
  );
  process.exit(2);
}

// ── bsk 薄封装（与 probe-pgc-guard-paths.mjs 同源） ──────────────────────────

/**
 * ⚠️ `shell: false`（默认值，**不要改成 true**）：表达式里有大量引号、箭头函数与 `!`，
 * 经 cmd 再解析一遍会剥引号。同理**不要**在 PowerShell 里直接传含引号的参数。
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
  // bsk 0.3.3 会往 stderr 打「有新版本」提示并以非 0 退出，调用方按 allowFail 决定是否在意
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

/** `docs/guides/bsk-page-bridges.md` §1：必须 async IIFE + 内部 await 再 stringify */
function evaluate(expression) {
  const r = bsk(['evaluate', '--session', SID, '--tab-id', TAB, expression], { allowFail: true });
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
    /* pgcReload 在回包顶层（与 snapshot 平级），不在 snapshot.pgcReload 里。
       实测（2026-10-30）：topKeys = ['__ns','type','snapshot','pgcReload']，
       snapshot.pgcReload 是 null。两处都兜一下，免得 bsk/产品哪天改形状。 */
    const p = snap.pgcReload || (snap.snapshot && snap.snapshot.pgcReload) || null;
    const s = snap.snapshot || null;
    const v = document.querySelector('video');
    const guards = {}; const pgcVi = {};
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (!k) continue;
      const val = String(sessionStorage.getItem(k));
      if (k.indexOf('pluma:pgc-reload') === 0) guards[k] = val;
      if (k.indexOf('pluma:pgc-vi:') === 0) pgcVi[k] = val.length;
    }
    const ls = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.indexOf('pluma') === 0) ls[k] = String(localStorage.getItem(k)).slice(0, 80);
    }
    const main = window.__PLUMA_PGC__ || null;
    return JSON.stringify({
      pgcReload: p,
      pgcReloadKeys: p ? Object.keys(p) : [],
      guards, pgcVi, localStorage: ls,
      proxy: s && s.proxy ? s.proxy : null,
      page: s && s.page ? { kind: s.page.kind, pageKey: s.page.pageKey } : null,
      video: v ? { duration: v.duration, w: v.videoWidth, h: v.videoHeight } : null,
      main: main ? { lastCfgEnabled: main.lastCfgEnabled, lastStage: main.lastStage, patchedAt: main.patchedAt, ssHit: main.ssHit, cacheBytes: main.cacheBytes } : null,
      href: location.href,
      at_epoch: Date.now(),
    });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
})()`;

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
    return JSON.stringify(r);
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
})()`;
}

// ── 扩展存储：定位 + 只读解析 `pluma:diag` ───────────────────────────────────

/**
 * 找 Pluma 的扩展 ID → `Local Extension Settings/<id>` 目录。
 *
 * 为什么**不能写死 ID**：解压加载的扩展在「重新加载」后 ID 可能变
 * （`reload-extension.mjs` 的坑 1）。所以从 `Secure Preferences` 里按
 * `"path"` 指向本仓库 `.output/chrome-mv3` 反查。
 */
function findExtStorageDir() {
  const candidates = [];
  const roots = [];
  if (USER_DATA_DIR) roots.push(USER_DATA_DIR);
  else {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    roots.push(path.join(local, 'Microsoft', 'Edge', 'User Data'));
    roots.push(path.join(local, 'Google', 'Chrome', 'User Data'));
  }
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (name !== 'Default' && !/^Profile \d+$/.test(name)) continue;
      const prefsPath = path.join(root, name, 'Secure Preferences');
      if (!fs.existsSync(prefsPath)) continue;
      let txt;
      try {
        txt = fs.readFileSync(prefsPath, 'utf8');
      } catch {
        continue;
      }
      // 按 "extensionId":{..."path":"...chrome-mv3"...} 配对
      const re = /"([a-p]{32})":\{"account_extension_type"[\s\S]{0,4000}?"path":"([^"]+)"/g;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const id = m[1];
        const rawPath = m[2].replace(/\\\\/g, '\\');
        if (!/[\\/]\.output[\\/]chrome-mv3$/.test(rawPath)) continue;
        const storeDir = path.join(root, name, 'Local Extension Settings', id);
        if (fs.existsSync(storeDir)) {
          candidates.push({ id, loadPath: rawPath, storeDir, profile: name, userData: root });
        }
      }
    }
  }
  return candidates;
}

/** 从 LevelDB 文件字节里抓平衡的 JSON（`[` 或 `{` 开头） */
function grabBalanced(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let p = start; p < s.length; p += 1) {
    const c = s[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return p + 1;
    }
  }
  return -1;
}

/** LevelDB 里的中文是 UTF-8 字节，按 latin1 读出来再转回 */
function fixUtf8(x) {
  if (typeof x !== 'string') return x;
  try {
    return Buffer.from(x, 'latin1').toString('utf8');
  } catch {
    return x;
  }
}

/**
 * 读 `pluma:diag` 环形缓冲（**只读**）。
 *
 * 每份 `.ldb` / `.log` 里可能各存了一份快照，按 `at|from|step|detail` 去重后取并集 ——
 * LevelDB 会 compaction，历史上哪份文件里有哪一段不确定。
 */
function readDiag(storeDir, sinceMs) {
  const files = fs
    .readdirSync(storeDir)
    .filter((f) => /\.(ldb|log)$/.test(f))
    .map((f) => path.join(storeDir, f));
  const byKey = new Map();
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file).toString('latin1');
    } catch {
      continue;
    }
    let i = -1;
    while ((i = raw.indexOf('pluma:diag', i + 1)) !== -1) {
      const start = raw.indexOf('[', i);
      if (start === -1) continue;
      const end = grabBalanced(raw, start);
      if (end === -1) continue;
      let arr;
      try {
        arr = JSON.parse(raw.slice(start, end));
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      for (const d of arr) {
        if (!d || typeof d.at !== 'number') continue;
        byKey.set(`${d.at}|${d.from}|${d.step}|${d.detail}`, d);
      }
    }
  }
  const all = [...byKey.values()].sort((a, b) => a.at - b.at);
  const entries = all
    .filter((d) => d.at >= sinceMs)
    .map((d) => ({
      at: d.at,
      iso: new Date(d.at).toISOString(),
      step: fixUtf8(d.step),
      detail: fixUtf8(d.detail),
    }));
  let newestMtimeMs = 0;
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
    } catch {
      /* 跳过 */
    }
  }
  return { entries, total_seen: all.length, files: files.map((f) => path.basename(f)), newestMtimeMs };
}

// ── 报告 ──────────────────────────────────────────────────────────────────────

const report = {
  generated_at: new Date().toISOString(),
  session: SID,
  tab: TAB,
  ep: EP,
  wait_ms: WAIT_MS,
  manual_cache_clear_performed: false,
  preparations: [],
  evidence: {},
  rounds: {},
  verdicts: [],
};

const log = (s) => {
  if (!AS_JSON) console.log(s);
};

function verdict(name, pass, detail) {
  const v = { name, pass, detail, at: new Date().toISOString() };
  report.verdicts.push(v);
  log(`  → [${pass ? 'PASS' : 'FAIL'}] ${name}: ${detail}`);
  return v;
}

function read(label) {
  const r = evaluate(READ_EXPR);
  const rec = r.ok ? r.value : { error: r.err };
  report.rounds[label] = { captured_at: new Date().toISOString(), ...rec };
  return rec;
}

function guardCount(rec) {
  return rec?.guards ? Object.keys(rec.guards).length : 0;
}

function guardAttempts(rec) {
  const g = rec?.guards ?? {};
  const k = Object.keys(g)[0];
  if (!k) return null;
  const p = tryJson(g[k]);
  return p && typeof p.attempts === 'number' ? p.attempts : null;
}

function viSummary(rec) {
  const o = rec?.pgcVi ?? {};
  const ks = Object.keys(o);
  return { keys: ks, bytes: ks.map((k) => o[k]) };
}

function printRead(rec, indent = '  ') {
  const p = rec?.pgcReload ?? {};
  log(
    `${indent}proxy=${String(rec?.proxy?.enabled)} rules=${String(rec?.proxy?.ruleCount)} ` +
      `exit=${String(p.orchestrateExit)} hadSync=${String(p.hadSync)} ` +
      `patchedByUs=${String(p.ssrPatchedByUs)} truncated=${String(p.ssrTruncated)}`,
  );
  log(
    `${indent}outcome=${String(p.lastGuardOutcome)} action=${String(p.lastGuardAction)} ` +
      `clearedByOutcome=${String(p.guardClearedByOutcome)} reloadIssued=${String(p.reloadIssued)} ` +
      `guards=${JSON.stringify(rec?.guards ?? null)}`,
  );
  log(
    `${indent}vi=${JSON.stringify(viSummary(rec))} dur=${String(rec?.video?.duration)} ` +
      `ls=${JSON.stringify(rec?.localStorage ?? null)}`,
  );
}

function reload(reason) {
  report.preparations.push({ action: 'reload', reason, at: new Date().toISOString() });
  const r = bsk(['reload', '--session', SID, '--tab-id', TAB], { allowFail: true });
  if (r.status !== 0) log(`  ⚠️ reload 非零退出（bsk 0.3.3 的升级提示也会导致非零，继续）`);
  sleep(WAIT_MS);
}

function setProxy(enabled, reason) {
  const r = evaluate(setProxyExpr(enabled));
  const reply = r.ok ? r.value : { error: r.err };
  report.preparations.push({
    action: 'set-proxy',
    enabled,
    reason,
    reply,
    at: new Date().toISOString(),
  });
  log(`  拨开关 → enabled=${String(enabled)} reply=${JSON.stringify(reply)}`);
  sleep(3000); // 等 storage.onChanged 传播（第三层挂在它上面）
  return reply;
}

/** 在 diag 里找匹配的行（只看本次流程开始之后的） */
function diagMatch(data, re) {
  return data.entries.filter((e) => re.test(e.detail) || re.test(e.step));
}

/**
 * 带重试地等一条 diag 自报出现。
 *
 * ## 为什么必须重试（第二次真机复跑踩到的假 FAIL）
 *
 * LevelDB 的写入是**惰性落盘**的：`chrome.storage.local.set` 返回时，
 * 数据可能还在内存 memtable 里，`.ldb` / `.log` 文件要过一会儿才被刷。
 * 第一次跑恰好赶上了，第二次跑就没赶上 ——
 *
 * ```
 * 12:44:56.317  [proxy/set]  开启代理
 * 12:44:56.320  [page/quality]  [PGC] 总开关已重开，已清 1 条刷新护栏   ← 真实存在
 *               （但脚本在 12:44:56.4 左右就读完了文件，还没落盘）
 * ```
 *
 * 结果是「第三层自报 = false」但护栏确实 1→0 —— 一个**纯测量问题**被误报成缺陷。
 * 所以这里重试到超时为止，而不是"读一次没有就当没有"。
 *
 * @param storeDir 存储目录
 * @param sinceMs 只看这个时刻之后的
 * @param re 匹配自报的正则
 * @param timeoutMs 最多等多久
 */
function waitForDiag(storeDir, sinceMs, re, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let data = readDiag(storeDir, sinceMs);
  let hits = diagMatch(data, re);
  while (hits.length === 0 && Date.now() < deadline) {
    sleep(1200);
    data = readDiag(storeDir, sinceMs);
    hits = diagMatch(data, re);
  }
  return { data, hits, waited: timeoutMs };
}

/**
 * 早退判定：这份存储看起来被读到了，但**最近没有任何新日志** —— 说明读错了目录。
 *
 * 不判这一下，后果很具体：第一版取错了 Chrome 那份陈旧存储，
 * 日志窗口里 0 条，于是「第二层执行 = false」——**结论完全错**。
 */
function storageLooksStale(storeData, windowStartMs) {
  if (storeData.entries.length > 0) return false;
  // 窗口内没日志，再看这份存储的最后写入时间是否远早于本次流程
  return storeData.newestMtimeMs < windowStartMs - 5 * 60 * 1000;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

const startedAt = Date.now();
log('=== ADR 0028 第二层 → 第三层：完整链路真机验证（不手工清缓存）===');
log(`session=${SID} tab=${TAB} ep=${EP} wait=${String(WAIT_MS)}ms`);
log('');

// preflight ①：活扩展里有 ADR 0030 埋点
log('--- preflight 1/2：活扩展含 ADR 0030 埋点 ---');
const pre = read('preflight');
const keys = pre.pgcReloadKeys ?? [];
const hasTrace =
  keys.includes('lastGuardOutcome') && keys.includes('lastGuardAction') && keys.includes('guardClearedByOutcome');
if (pre.error || typeof pre.pgcReload !== 'object' || pre.pgcReload === null) {
  log(`  ✗ 读不到 trace：${String(pre.error ?? 'pgcReload 为空')}`);
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  process.exit(3);
}
if (!hasTrace) {
  log(`  ✗ **构建过期**：trace 只有 ${String(keys.length)} 字段，缺 ADR 0030 埋点`);
  log(`    keys = ${JSON.stringify(keys)}`);
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  process.exit(4);
}
log(`  ✓ 埋点在位（${String(keys.length)} 字段）`);
printRead(pre);

// preflight ②：能找到扩展存储（第二层/第三层的**唯一权威证据源**）
log('');
log('--- preflight 2/2：定位扩展的 chrome.storage.local（读 pluma:diag）---');
const stores = findExtStorageDir();
if (stores.length === 0) {
  log('  ✗ 找不到解压加载的 Pluma 扩展存储目录');
  log('    → 这是"未能实测"，不是"链路不成立"。可用 --user-data-dir= 指定 Edge 的 User Data');
  report.preflight_storage = { found: false };
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  process.exit(3);
}
/**
 * ⚠️ **不能取最后一个候选**（第一版踩的坑）。
 *
 * 同一个解压路径可能被多个浏览器 profile 注册过（本机 Edge 与 Chrome 都有一份
 * `Local Extension Settings/<同一个 id>` —— Chrome 那份是陈旧的，里面只有一个
 * 三天前的 `000003.log`）。取最后一个只会拿到旧数据，日志全是空的，
 * 结论就会错成「第二层没执行」。
 *
 * 正确判据：**最近被写过**的那个（`Local Extension Settings` 里的文件 mtime）。
 * 正在运行的浏览器会持续写 `MANIFEST-*` / `.log` / `.ldb`。
 */
function storeFreshnessMs(dir) {
  let newest = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* 单文件读不到就跳过 */
      }
    }
  } catch {
    /* 目录读不到 → 0 */
  }
  return newest;
}
for (const c of stores) c.freshnessMs = storeFreshnessMs(c.storeDir);
stores.sort((a, b) => a.freshnessMs - b.freshnessMs);
const store = stores[stores.length - 1];
if (stores.length > 1) {
  log(`  ⚠️ 找到 ${String(stores.length)} 个候选存储，取最近写入的那个：`);
  for (const c of stores) {
    log(`     ${c.store_dir}  (mtime=${new Date(c.freshnessMs).toISOString()})`);
  }
}
report.ext_storage = { id: store.id, load_path: store.loadPath, profile: store.profile, store_dir: store.storeDir };
log(`  ✓ 扩展 ${store.id}（${store.profile}）← ${store.loadPath}`);
const probe0 = readDiag(store.storeDir, startedAt);
log(`  ✓ 读到 pluma:diag ${String(probe0.total_seen)} 条（${probe0.files.join(', ')}），只读`);
report.diag_baseline = { total_seen: probe0.total_seen, files: probe0.files, newest_mtime: new Date(probe0.newestMtimeMs).toISOString() };
if (storageLooksStale(probe0, startedAt)) {
  log('  ✗ 这份存储最近没有新日志 —— 大概率读错了目录（陈旧副本）');
  log(`    最后写入 ${new Date(probe0.newestMtimeMs).toISOString()}，本次流程开始 ${new Date(startedAt).toISOString()}`);
  report.preflight_storage = { found: 'stale', store_dir: store.storeDir };
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  process.exit(3);
}
log(`  ✓ 存储是活的（最后写入 ${new Date(probe0.newestMtimeMs).toISOString()}）`);

// ── ① reload（开关=开）：建立"已完成注入"基线 ───────────────────────────────
log('');
log('① reload（开关=开）→ 期望 injected，并记下缓存字节数');
reload('① 建立缓存命中基线（开关=开）');
const r1 = read('round1_on');
printRead(r1);
const vi1 = viSummary(r1);
const outcome1 = r1.pgcReload?.lastGuardOutcome ?? null;
log(`  基线：outcome=${String(outcome1)} vi=${JSON.stringify(vi1)}`);

// ── ② 关总开关 ───────────────────────────────────────────────────────────────
log('');
log('② set-proxy false（不刷新页面）');
setProxy(false, '② 关闭总开关');
const r2 = read('round2_off');
printRead(r2);

// ── ③ **开关关着时整页 reload** → 触发第二层 ────────────────────────────────
log('');
log('③ **开关关着时整页 reload** —— 这一步才让 page/activate 回 disabled → 第二层执行');
const diagBefore3 = Date.now();
reload('③ 开关关着时 reload，让 ADR 0028 第二层真正清缓存');
const r3 = read('round3_off_reloaded');
printRead(r3);

log('');
log('  ↳ 从 pluma:diag 找第二层的自报（「已清 N 条同步缓存」）与 page/activate 的 reason');
const waited3 = waitForDiag(store.storeDir, diagBefore3, /已清\s*\d+\s*条同步缓存/);
const store3 = waited3.data;
const disabledHits = diagMatch(store3, /总开关已关闭\s*→?\s*不装规则|总开关已关闭，已清/);
const clearHits = diagMatch(store3, /已清\s*\d+\s*条同步缓存/);
report.evidence.round3_diag = {
  activate_disabled: diagMatch(store3, /总开关已关闭/).filter((e) => /不装规则/.test(e.detail)),
  layer2_clear_notes: clearHits,
  all_entries_in_window: store3.entries.length,
};
for (const e of diagMatch(store3, /总开关已关闭|已清|收到 SSR|命中缓存/)) {
  log(`    ${e.iso}  [${e.step}]  ${e.detail}`);
}

const layer2Ran = clearHits.length > 0;
const clearedCounts = clearHits
  .map((e) => {
    const m = /已清\s*(\d+)\s*条/.exec(e.detail);
    return m ? Number(m[1]) : null;
  })
  .filter((n) => n !== null);
const layer2ClearedAny = clearedCounts.some((n) => n > 0);
const reasonDisabled = report.evidence.round3_diag.activate_disabled.length > 0;

log('');
log(`  第二层执行 = ${String(layer2Ran)}（自报次数 ${String(clearHits.length)}，清掉条数 ${JSON.stringify(clearedCounts)}）`);
log(`  page/activate 回 disabled = ${String(reasonDisabled)}`);
log(`  ↳ 注意：relaod 后 sessionStorage 里 vi 仍在 = ${String(viSummary(r3).keys.length > 0)} —— ` +
  `**这不代表第二层没跑**（清了会被 writePgcSessionCache 写回，见脚本头注释）`);

report.evidence.second_layer = {
  executed: layer2Ran,
  cleared_counts: clearedCounts,
  cleared_any_positive: layer2ClearedAny,
  activate_reason_disabled: reasonDisabled,
  sessionStorage_after: viSummary(r3),
  note: '判据是产品自报的 note，不是 sessionStorage 的最终状态（后者会被回写覆盖）',
};

// ── ③ 的 outcome 判据 ───────────────────────────────────────────────────────
const outcome3 = r3.pgcReload?.lastGuardOutcome ?? null;
const action3 = r3.pgcReload?.lastGuardAction ?? null;
const guardAfter3 = r3.guards ?? {};
log(`  ③ 之后：outcome=${String(outcome3)} action=${String(action3)} 护栏=${JSON.stringify(guardAfter3)}`);

// ── ④ 重开开关 → 第三层清护栏 ───────────────────────────────────────────────
log('');
log('④ set-proxy true → ADR 0028 第三层 clearPgcReloadGuards()');
const guardsBefore4 = guardCount(r3);
const diagBefore4 = Date.now();
setProxy(true, '④ 重开总开关，触发第三层清护栏');
const r4 = read('round4_reenabled');
printRead(r4);
const store4 = waitForDiag(store.storeDir, diagBefore4, /已清\s*\d+\s*条刷新护栏/).data;
const layer3Hits = diagMatch(store4, /已清\s*\d+\s*条刷新护栏/);
report.evidence.round4_diag = { layer3_clear_notes: layer3Hits, entries: store4.entries.length };
for (const e of layer3Hits) log(`    ${e.iso}  [${e.step}]  ${e.detail}`);
const guardsAfter4 = guardCount(r4);
// 第三层的**行为证据**是护栏真的没了；日志只是**来源证据**。
// 若日志因落盘延迟缺失，护栏变空本身已经证明第三层跑了 —— 不能因为日志没赶上就报 FAIL。
const layer3Ran = layer3Hits.length > 0;
const layer3Behavior = guardsBefore4 > 0 && guardsAfter4 === 0;
const layer3Ok = layer3Behavior || layer3Ran;
log(`  护栏 ${String(guardsBefore4)} → ${String(guardsAfter4)}；第三层自报 = ${String(layer3Ran)}；行为证据 = ${String(layer3Behavior)}`);
report.evidence.third_layer = {
  executed: layer3Ok,
  notes: layer3Hits,
  behavior_guards_cleared: layer3Behavior,
  guards_before: guardsBefore4,
  guards_after: guardsAfter4,
};

// ── ⑤ reload（开关=开）裁决轮 ───────────────────────────────────────────────
log('');
log('⑤ reload（开关=开）—— 护栏应为空，能正常取流');
reload('⑤ 裁决轮：护栏已空 + 开关开');
const r5 = read('round5_verdict');
printRead(r5);

const outcome5 = r5.pgcReload?.lastGuardOutcome ?? null;
const dur5 = r5.video?.duration;
const reloadIssued5 = Number(r5.pgcReload?.reloadIssued ?? 0);
const guards5 = guardCount(r5);
const vi5 = viSummary(r5);
const playerOk = typeof dur5 === 'number' && dur5 > 180;
const onPlayable = Boolean(r5.pgcReload) && Number(r5.pgcReload.orchestrateCalls ?? 0) >= 1;

// ── 裁决 ──────────────────────────────────────────────────────────────────────
log('');
log('=== 裁决 ===');

verdict(
  '第二层：page/activate 回 disabled 且第二层自报清缓存',
  layer2Ran && reasonDisabled,
  `activate reason=disabled ${String(reasonDisabled)}；第二层自报 ${String(clearHits.length)} 次，` +
    `条数 ${JSON.stringify(clearedCounts)}`,
);

verdict(
  '第二层清掉后的那一轮 outcome=still-truncated / action=retry',
  outcome3 === 'still-truncated' && action3 === 'retry',
  `outcome=${String(outcome3)} action=${String(action3)}`,
);

verdict(
  '第三层：重开开关时清护栏，护栏归零',
  layer3Ok && guardsAfter4 === 0,
  `第三层自报=${String(layer3Ran)} 行为证据=${String(layer3Behavior)} 护栏 ${String(guardsBefore4)}→${String(guardsAfter4)}`,
);

verdict(
  '末轮：护栏为空、能正常取流、reloadIssued 未失控',
  guards5 === 0 && playerOk && reloadIssued5 <= 2 && onPlayable,
  `guards=${String(guards5)} dur=${String(dur5)} reloadIssued=${String(reloadIssued5)} ` +
    `exit=${String(r5.pgcReload?.orchestrateExit)} vi=${JSON.stringify(vi5)}`,
);

report.verdict = {
  layer2_executed: layer2Ran,
  layer2_cleared_counts: clearedCounts,
  layer2_cleared_any_positive: layer2ClearedAny,
  activate_reason_disabled: reasonDisabled,
  round3_outcome: outcome3,
  round3_action: action3,
  layer3_executed: layer3Ok,
  layer3_notes: layer3Hits,
  layer3_behavior_guards_cleared: layer3Behavior,
  guards_before_layer3: guardsBefore4,
  guards_after_layer3: guardsAfter4,
  round5_outcome: outcome5,
  round5_duration: dur5,
  round5_reload_issued: reloadIssued5,
  manual_cache_clear_performed: false,
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  log('');
  log('--- 原始证据 ---');
  log(`  ①  基线 outcome=${String(outcome1)} vi=${JSON.stringify(vi1)} dur=${String(r1.video?.duration)}`);
  log(`  ②  关开关后 proxy=${String(r2.proxy?.enabled)} rules=${String(r2.proxy?.ruleCount)} ls=${JSON.stringify(r2.localStorage)}`);
  log(`  ③  outcome=${String(outcome3)} action=${String(action3)} 护栏=${JSON.stringify(guardAfter3)} vi=${JSON.stringify(viSummary(r3))}`);
  log(`      第二层自报：${JSON.stringify(clearHits.map((e) => ({ at: e.iso, note: e.detail })))}`);
  log(`  ④  护栏 ${String(guardsBefore4)}→${String(guardsAfter4)}；第三层自报：${JSON.stringify(layer3Hits.map((e) => ({ at: e.iso, note: e.detail })))}`);
  log(`  ⑤  outcome=${String(outcome5)} guards=${String(guards5)} dur=${String(dur5)} reloadIssued=${String(reloadIssued5)} vi=${JSON.stringify(vi5)}`);
  log('');
  log('写过的东西（preparations）：');
  for (const p of report.preparations) log(`  - ${JSON.stringify(p)}`);
  log('');
  log('手工清缓存 = false（本脚本从不清 pluma:pgc-vi:*）');
  log('');
  log(`复跑：node poc/probe/probe-pgc-layer2-chain.mjs ${SID} ${TAB} ${EP}`);
  process.exit(report.verdicts.every((v) => v.pass) ? 0 : 1);
}

process.exit(report.verdicts.every((v) => v.pass) ? 0 : 1);
