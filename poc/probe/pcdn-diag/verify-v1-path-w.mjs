/**
 * 「`/v1/resource/upgcxcode/` 路径能否在官方 host 上直连」探针 · 阶段 C：**决定性对照（W 组）**。
 *
 * ## 为什么还需要 W 组
 *
 * 阶段 B 的 Q1 / Q2b 都是 403。但这两组有一个共同的混淆点：**改的是 `/v1` 那条候选，
 * 用的是 `/v1` 自己的签名**。403 可能有两种解释：
 *
 * 1. **路径不被接受**：官方 CDN 上没有 `/v1/resource/…` 这个路径；
 * 2. **签名不匹配**：签名是绑 path 的，改了 path 就废。
 *
 * 两者都 403，光看阶段 B 分不开。而它们的工程后果完全不同：
 * 若是 (1)，规则 B 永远消不掉；若是 (2)，理论上也无解（我们只能改 authority，不能改签名）。
 *
 * ## W 组怎么分开它们
 *
 * 拿**同轨官方候选**（`/upgcxcode/…`，签名已验证 206，即 Q4）当底料，
 * **只把 path 加上 `/v1/resource` 前缀**，签名一字不动：
 *
 * | 组 | host | path | 签名来源 | 若 206 说明 | 若 403 说明 |
 * | --- | --- | --- | --- | --- | --- |
 * | W1 | 官方（peer 自己的 host） | `/v1/resource/upgcxcode/…` | **peer 的（已验证有效）** | 官方接受 `/v1` 路径，规则 B 可消 | 官方不接受该路径 |
 * | W2 | 官方（peer host） | `/upgcxcode/…` | peer 的 | —— 对照组，应 206 | 底料本身失效 |
 *
 * W2 是 W1 的自检：同一 host、同一签名、只差 `/v1/resource` 前缀。
 * **W2 = 206 且 W1 = 403 ⇒ 403 由"路径"造成，与签名无关**（这是 W 组唯一要证的结论）。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/verify-v1-path-w.mjs
 * 输出：合并进 `v1-path-on-official.json`（新增 `W1` / `W2` 与对应 records）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.join(HERE, 'v1-path-candidates.json');
const RESULTS = path.join(HERE, 'v1-path-on-official.json');

const V1_PREFIX = '/v1/resource/upgcxcode/';
const PLAIN_PREFIX = '/upgcxcode/';
const INTERVAL_MS = 150;
const TIMEOUT_MS = 12000;

/** 中位数；空数组 → null */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 小睡，控制请求节奏 */
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

/**
 * 发一次 Range 请求并计时。
 *
 * @returns 状态、TTFB、耗时、读到字节数、body 前 200 字节
 */
async function probe(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow', cache: 'no-store' });
    const ttfb = performance.now() - start;
    let bodyBytes = 0;
    let bodyHead = '';
    try {
      const reader = response.body?.getReader();
      if (reader) {
        const chunk = await reader.read();
        if (chunk && chunk.value) {
          bodyBytes = chunk.value.byteLength;
          if (response.status !== 206) bodyHead = Buffer.from(chunk.value).toString('utf8').slice(0, 200);
        }
        await reader.cancel().catch(() => {});
      }
    } catch {
      // body 读取失败不影响状态码判定
    }
    return {
      status: String(response.status), httpStatus: response.status,
      ttfbMs: Math.round(ttfb), durationMs: Math.round(performance.now() - start),
      bodyBytes, bodyHead,
      server: response.headers.get('server'), contentType: response.headers.get('content-type'),
    };
  } catch (error) {
    const code = (error?.cause && error.cause.code) || error?.code || '';
    let label = '请求失败';
    if (error?.name === 'AbortError') label = '超时';
    else if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ENOSERVER'].includes(code)) label = 'DNS失败';
    return {
      status: `${label}${code ? `:${code}` : ''}`, httpStatus: null, ttfbMs: null,
      durationMs: Math.round(performance.now() - start), bodyBytes: 0, bodyHead: '',
      server: null, contentType: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

const raw = JSON.parse(readFileSync(INPUT, 'utf8'));
const previous = JSON.parse(readFileSync(RESULTS, 'utf8'));
const ua = (raw.videos.find((video) => video.ua) || {}).ua
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/** 用阶段 B 已经选中的那批样本（同一批对象，结果才能横向对账） */
const sampleKeys = new Set((previous.sample || []).map((entry) => `${entry.bvid}|${entry.trackIndex}`));

const pool = [];
for (const video of raw.videos) {
  for (const track of video.tracks) {
    if (!track.hasV1) continue;
    if (!sampleKeys.has(`${video.bvid}|${track.trackIndex}`)) continue;
    const v1 = track.candidates.find((candidate) => candidate.url.includes(V1_PREFIX));
    const peers = track.candidates.filter((candidate) => !candidate.url.includes(V1_PREFIX));
    const peer = peers.find((candidate) => candidate.index === 2) || peers[peers.length - 1] || null;
    if (!v1 || !peer) continue;
    pool.push({
      bvid: video.bvid, trackIndex: track.trackIndex, codecid: track.codecid,
      peerUrl: peer.url, peerHost: new URL(peer.url).hostname,
    });
  }
}
process.stdout.write(`W 组样本：${pool.length} 条（与阶段 B 同一批对象）\n`);

const records = [];

/** 统一请求 + 记录 */
async function run(group, entry, label, url) {
  const headers = {
    'User-Agent': ua,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Range: 'bytes=0-1023',
    Accept: '*/*',
  };
  const result = await probe(url, headers, TIMEOUT_MS);
  const target = new URL(url);
  const record = {
    group, label,
    bvid: entry.bvid, trackIndex: entry.trackIndex, codecid: entry.codecid,
    targetHost: target.hostname,
    pathShape: target.pathname.includes(V1_PREFIX) ? '/v1/resource/upgcxcode/…' : '/upgcxcode/…',
    paramCount: target.searchParams.size,
    ...result,
  };
  records.push(record);
  process.stdout.write(
    `  [${group}·${label}] ${entry.bvid}#t${entry.trackIndex} ${record.targetHost} ` +
      `${record.pathShape} → ${result.status} ttfb=${result.ttfbMs}ms bytes=${result.bodyBytes}` +
      `${result.bodyHead ? ` body="${result.bodyHead.replace(/\s+/g, ' ').slice(0, 60)}"` : ''}\n`,
  );
  await sleep(INTERVAL_MS);
  return record;
}

process.stdout.write('\n══ W1：peer 的签名 + 把 path 加上 `/v1/resource` 前缀 ══\n');
for (const entry of pool) {
  const url = new URL(entry.peerUrl);
  url.pathname = url.pathname.replace(PLAIN_PREFIX, V1_PREFIX);
  await run('W1', entry, 'peerSig-v1path', url.toString());
}

process.stdout.write('\n══ W2：peer 的签名 + 原 `/upgcxcode/` path（自检，应 206）══\n');
for (const entry of pool) {
  await run('W2', entry, 'peerSig-plainpath', entry.peerUrl);
}

// ─────────────────────────── 汇总并合并 ───────────────────────────

/** 按 group 汇总 */
function summarize(group) {
  const rows = records.filter((record) => record.group === group);
  const ok = rows.filter((record) => record.httpStatus === 206);
  const ttfb = ok.map((record) => record.ttfbMs).filter((value) => value !== null);
  return {
    total: rows.length,
    ok: ok.length,
    statuses: rows.reduce((acc, record) => {
      acc[record.status] = (acc[record.status] || 0) + 1;
      return acc;
    }, {}),
    medianTtfbMs: ttfb.length ? Math.round(median(ttfb)) : null,
  };
}

/** 逐条配对结论：同 host 同签名，只差 path 前缀 */
const pairs = pool.map((entry) => {
  const w1 = records.find((record) => record.group === 'W1' && record.bvid === entry.bvid
    && record.trackIndex === entry.trackIndex);
  const w2 = records.find((record) => record.group === 'W2' && record.bvid === entry.bvid
    && record.trackIndex === entry.trackIndex);
  return {
    bvid: entry.bvid, trackIndex: entry.trackIndex, codecid: entry.codecid,
    peerHost: entry.peerHost,
    v1PathStatus: w1 ? w1.status : null, plainPathStatus: w2 ? w2.status : null,
    /** 自检通过 + v1 路径失败 = 路径问题的干净证据 */
    verdict: w2 && w2.httpStatus === 206 && w1 && w1.httpStatus !== 206
      ? 'path-rejected' : (w2 && w2.httpStatus !== 206 ? 'baseline-invalid' : 'path-accepted'),
  };
});

const merged = {
  ...previous,
  W1: summarize('W1'),
  W2: summarize('W2'),
  Wpairs: pairs,
  records: previous.records.concat(records),
  wAt: new Date().toISOString(),
};
writeFileSync(RESULTS, JSON.stringify(merged, null, 2), 'utf8');

process.stdout.write('\n══ 汇总 ══\n');
for (const group of ['W1', 'W2']) {
  const row = merged[group];
  process.stdout.write(`${group}: ${row.ok}/${row.total} 206，状态 ${JSON.stringify(row.statuses)}\n`);
}
process.stdout.write('逐条配对：\n');
for (const pair of pairs) {
  process.stdout.write(`  ${pair.bvid}#t${pair.trackIndex} peer=${pair.peerHost} ` +
    `/v1 路径=${pair.v1PathStatus} 原路径=${pair.plainPathStatus} ⇒ ${pair.verdict}\n`);
}
const pathRejected = pairs.filter((pair) => pair.verdict === 'path-rejected').length;
process.stdout.write(`\n判定：${pathRejected}/${pairs.length} 条证明"官方不接受 /v1 路径"（自检基线 206 且 /v1 路径非 206）\n`);
process.stdout.write(`已合并写入 ${RESULTS}\n`);