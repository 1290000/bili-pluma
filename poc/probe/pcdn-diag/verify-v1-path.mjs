/**
 * 「`/v1/resource/upgcxcode/` 路径能否在官方 host 上直连」探针 · 阶段 B：四组请求。
 *
 * ## 它要回答什么
 *
 * ADR 0039 的规则 B（mcdn + `/v1/resource/upgcxcode/`）只能走
 * `proxy-tf-all-ws.bilivideo.com?url=…`，实测 TTFB 中位 949 ms，是规则 A 的 7.4 倍。
 * 若"官方 host + 原 `/v1` path"能直接 206，这条分支就可以整条删掉，代价归零。
 *
 * ## 四组（与任务书一一对应）
 *
 * | 组 | 做法 | 回答 |
 * | --- | --- | --- |
 * | **Q1** | 原 `/v1` path + host 换成 3 个官方镜像，以及与同轨 index2 官方候选**同一个 host 原值** | 有没有官方 host 接受 `/v1` 路径 |
 * | **Q2** | 去掉 `/v1/resource` 前缀（path 从 `/v1/resource/upgcxcode/…` 变成 `/upgcxcode/…`），其余一字不动 | 签名绑不绑 path 前缀 |
 * | **Q3** | 现状复核：mirror + 原 `/v1`（与 Q1-mirrorhw 同一条，复用）+ `proxy-tf-all-ws` 包装 | 949 ms / 403 是否还成立 |
 * | **Q4** | 同轨 index2 官方候选**原始 URL** 直连 | 128 ms 基准是否还成立 |
 *
 * ## Q2 为什么有两个变体
 *
 * 任务书的 Q2 是"保留原 mcdn host、去掉前缀"。但 mcdn 域在本机公共 DNS 上返回 `0.0.0.0`
 * （计划 F5，`mcdn-reachable.json` 实测三种组合全失败：请求根本没发出），所以那个变体
 * **必然 DNS 失败**，拿不到任何关于"签名是否绑 path"的信息。
 * 因此额外加一个真正有信息量的变体：**签名不动、host 换官方、只去掉 `/v1/resource`**。
 * 若它 206 → 签名没绑 path 前缀（且对象在官方 CDN 上确实存在于 `/upgcxcode/`）。
 *
 * ## 口径
 *
 * 与 `verify-rewrite-4k.mjs` 完全一致：GET + `Range: bytes=0-1023`，
 * 同 UA + `Referer: https://www.bilibili.com/`；串行，每条间隔 150 ms；12 s 超时（proxy 20 s）。
 * 非 206 时记录 body 前 200 字节 —— B站 403 是 320 / 548 字节错误页，
 * 可据此区分"路径不存在"与"签名过期/权限不足"。
 *
 * 跑法：
 *   node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/verify-v1-path.mjs
 *
 * 输入：`v1-path-candidates.json`（阶段 A，gitignored）
 * 输出：`v1-path-on-official.json`（gitignored）+ 控制台逐条表格
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.join(HERE, 'v1-path-candidates.json');
const OUT = path.join(HERE, 'v1-path-on-official.json');

/** 官方镜像（Q1 / Q3） */
const MIRRORS = [
  'upos-sz-mirrorhw.bilivideo.com',
  'upos-sz-mirrorcoso1.bilivideo.com',
  'upos-sz-estgoss.bilivideo.com',
];
const PROXY_HOST = 'proxy-tf-all-ws.bilivideo.com';
const V1_PREFIX = '/v1/resource/upgcxcode/';
const PLAIN_PREFIX = '/upgcxcode/';
const INTERVAL_MS = 150;
const TIMEOUT_MS = 12000;
const PROXY_TIMEOUT_MS = 20000;
/** 选中做 proxy 复核的候选数（任务书：2 条即可） */
const PROXY_SAMPLE = 2;

/** 中位数；空数组 → null */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 舍入成整数毫秒 */
function ms(value) {
  return Math.round(value);
}

/** 小睡，控制请求节奏 */
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

/**
 * 发一次 Range 请求并计时。
 *
 * `fetch` resolve 于响应头到达 ⇒ 这就是 TTFB；随后只读前 200 字节即 cancel body，
 * 既能拿到 403 的 body 特征（判断失败类型），又不把整段媒体拉下来。
 *
 * @returns 状态、TTFB、耗时、读到字节数、body 前 200 字节
 */
async function probe(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    const ttfb = performance.now() - start;
    let bodyBytes = 0;
    let bodyHead = '';
    try {
      const reader = response.body?.getReader();
      if (reader) {
        const chunk = await reader.read();
        if (chunk && chunk.value) {
          bodyBytes = chunk.value.byteLength;
          if (response.status !== 206) {
            bodyHead = Buffer.from(chunk.value).toString('utf8').slice(0, 200);
          }
        }
        await reader.cancel().catch(() => {});
      }
    } catch {
      // body 读取失败不影响状态码判定
    }
    const duration = performance.now() - start;
    return {
      status: String(response.status),
      httpStatus: response.status,
      ttfbMs: ms(ttfb),
      durationMs: ms(duration),
      bodyBytes,
      bodyHead,
      server: response.headers.get('server'),
      contentType: response.headers.get('content-type'),
    };
  } catch (error) {
    const code = (error?.cause && error.cause.code) || error?.code || '';
    let label = '请求失败';
    if (error?.name === 'AbortError') label = '超时';
    else if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ENOSERVER'].includes(code)) label = 'DNS失败';
    return {
      status: `${label}${code ? `:${code}` : ''}`,
      httpStatus: null,
      ttfbMs: null,
      durationMs: ms(performance.now() - start),
      bodyBytes: 0,
      bodyHead: '',
      server: null,
      contentType: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── 选样 ───────────────────────────

const raw = JSON.parse(readFileSync(INPUT, 'utf8'));
const ua = (raw.videos.find((video) => video.ua) || {}).ua
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/** 候选池：每条轨里那一条真实的 `/v1` 候选 + 它的官方对等候选 */
const pool = [];
for (const video of raw.videos) {
  for (const track of video.tracks) {
    if (!track.hasV1) continue;
    const v1 = track.candidates.find((candidate) => candidate.url.includes(V1_PREFIX));
    if (!v1) continue;
    const peers = track.candidates.filter((candidate) => !candidate.url.includes(V1_PREFIX));
    /** 优先用 index 最大的那条（任务书指定 index2），没有就用最后一条官方候选 */
    const peer = peers.find((candidate) => candidate.index === 2) || peers[peers.length - 1] || null;
    pool.push({
      bvid: video.bvid, trackIndex: track.trackIndex, codecid: track.codecid,
      bandwidth: track.bandwidth, v1Url: v1.url, peerUrl: peer ? peer.url : null,
      peerHost: peer ? new URL(peer.url).hostname : null,
      peerIndex: peer ? peer.index : null,
    });
  }
}
process.stdout.write(`候选池：${pool.length} 条含 /v1 的轨\n`);

/**
 * 选样：6 条、跨 ≥4 个 bvid、覆盖 codecid 7 / 12 / 13。
 *
 * 按 `codecid → bvid` 去重挑，先把三种编码各占一条，再补足到 6 条，
 * 尽量让 bvid 不重复（同轨多条的只留一条，避免重复打同一对象）。
 */
function selectSample(entries, want) {
  const picked = [];
  const usedBvid = new Set();
  const usedKey = new Set();
  /** 第一轮：每个 codecid 各挑一条，bvid 尽量不重复 */
  for (const codecid of [7, 12, 13]) {
    const found = entries.find((entry) => entry.codecid === codecid
      && !usedBvid.has(entry.bvid)
      && !usedKey.has(`${entry.bvid}|${entry.trackIndex}`));
    if (found) {
      picked.push(found);
      usedBvid.add(found.bvid);
      usedKey.add(`${found.bvid}|${found.trackIndex}`);
    }
  }
  /** 第二轮：补足，仍优先没出现过的 bvid */
  for (const pass of [true, false]) {
    for (const entry of entries) {
      if (picked.length >= want) break;
      const key = `${entry.bvid}|${entry.trackIndex}`;
      if (usedKey.has(key)) continue;
      if (pass && usedBvid.has(entry.bvid)) continue;
      picked.push(entry);
      usedBvid.add(entry.bvid);
      usedKey.add(key);
    }
  }
  return picked;
}

const sample = selectSample(pool, 6);
process.stdout.write(
  `选样 ${sample.length} 条：` +
    sample.map((entry) => `${entry.bvid}#t${entry.trackIndex}(cc${entry.codecid})`).join(' '),
);
process.stdout.write(`\n覆盖 bvid ${new Set(sample.map((entry) => entry.bvid)).size} 个、` +
  `codecid ${Array.from(new Set(sample.map((entry) => entry.codecid))).sort().join('/')}\n`);

// ─────────────────────────── 请求 ───────────────────────────

const records = [];

/** 统一的请求 + 记录 */
async function run(group, entry, label, url, timeoutMs = TIMEOUT_MS) {
  const headers = {
    'User-Agent': ua,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Range: 'bytes=0-1023',
    Accept: '*/*',
  };
  const result = await probe(url, headers, timeoutMs);
  const target = new URL(url);
  const record = {
    group, label,
    bvid: entry.bvid, trackIndex: entry.trackIndex, codecid: entry.codecid,
    targetHost: target.hostname,
    pathShape: target.pathname.includes(V1_PREFIX) ? `/v1/resource/upgcxcode/…` : `/upgcxcode/…`,
    paramCount: target.searchParams.size,
    ...result,
  };
  records.push(record);
  process.stdout.write(
    `  [${group}${label ? `·${label}` : ''}] ${entry.bvid}#t${entry.trackIndex} ` +
      `${record.targetHost} ${record.pathShape} → ${result.status}` +
      ` ttfb=${result.ttfbMs}ms bytes=${result.bodyBytes}` +
      `${result.bodyHead ? ` body="${result.bodyHead.replace(/\s+/g, ' ').slice(0, 70)}"` : ''}\n`,
  );
  await sleep(INTERVAL_MS);
  return record;
}

/** 只换 authority：protocol / host / port，path 一字不动 */
function swapHost(rawUrl, host) {
  const url = new URL(rawUrl);
  url.protocol = 'https:';
  url.hostname = host;
  url.port = '';
  return url.toString();
}

/** 去掉 `/v1/resource` 前缀，其余（含 query 签名）一字不动 */
function stripV1Prefix(rawUrl) {
  const url = new URL(rawUrl);
  if (url.pathname.includes(V1_PREFIX)) {
    url.pathname = url.pathname.replace(V1_PREFIX, PLAIN_PREFIX);
  }
  return url.toString();
}

// ── Q1：原 /v1 path × 官方 host ────────────────────────────────
process.stdout.write('\n══ Q1：原 `/v1/resource/upgcxcode/` path + 官方 host ══\n');
for (const entry of sample) {
  for (const mirror of MIRRORS) {
    await run('Q1', entry, mirror.replace('.bilivideo.com', ''), swapHost(entry.v1Url, mirror));
  }
  /** 这一条最关键：与同轨官方候选**同一个 host 原值**，只差 path 前缀 */
  if (entry.peerHost) {
    await run('Q1', entry, `peerHost:${entry.peerHost.replace('.bilivideo.com', '')}`,
      swapHost(entry.v1Url, entry.peerHost));
  }
}

// ── Q2：去掉 `/v1/resource` 前缀 ────────────────────────────────
process.stdout.write('\n══ Q2：去掉 `/v1/resource` 前缀（签名一字不动）══\n');
for (const entry of sample) {
  /** Q2a：任务书原口径 —— 原 mcdn host + 去前缀（预期 DNS 失败，作为对照） */
  await run('Q2a', entry, 'origHost-stripped', stripV1Prefix(entry.v1Url));
  /** Q2b：真正有信息量的变体 —— 官方 host + 去前缀（签名仍是 /v1 那条的） */
  await run('Q2b', entry, 'mirrorhw-stripped', stripV1Prefix(swapHost(entry.v1Url, MIRRORS[0])));
  if (entry.peerHost) {
    await run('Q2b', entry, 'peerHost-stripped', stripV1Prefix(swapHost(entry.v1Url, entry.peerHost)));
  }
}

// ── Q3：现状复核（mirror + 原 /v1 已由 Q1 覆盖；这里补 proxy）────
process.stdout.write('\n══ Q3：现状复核（proxy 包装）══\n');
for (const entry of sample.slice(0, PROXY_SAMPLE)) {
  const wrapped = `https://${PROXY_HOST}/?url=${encodeURIComponent(entry.v1Url)}`;
  await run('Q3', entry, 'proxy-wrapped', wrapped, PROXY_TIMEOUT_MS);
}

// ── Q4：规则 A 基准（官方候选原始 URL 直连）────────────────────
process.stdout.write('\n══ Q4：同轨官方候选原始 URL 直连（基准）══\n');
let q4Count = 0;
for (const entry of sample) {
  if (q4Count >= 3) break;
  if (!entry.peerUrl) continue;
  q4Count += 1;
  await run('Q4', entry, 'peer-original', entry.peerUrl);
}

// ─────────────────────────── 汇总 ───────────────────────────

/** 按 group 汇总：条数、206 数、TTFB 中位 */
function summarize(group) {
  const rows = records.filter((record) => record.group === group
    || (group === 'Q2' && record.group.startsWith('Q2')));
  const ok = rows.filter((record) => record.httpStatus === 206);
  const ttfb = ok.map((record) => record.ttfbMs).filter((value) => value !== null);
  return {
    total: rows.length,
    ok: ok.length,
    statuses: rows.reduce((acc, record) => {
      acc[record.status] = (acc[record.status] || 0) + 1;
      return acc;
    }, {}),
    medianTtfbMs: ttfb.length ? ms(median(ttfb)) : null,
  };
}

const summary = {
  at: new Date().toISOString(),
  sourceAt: raw.at,
  sample: sample.map((entry) => ({
    bvid: entry.bvid, trackIndex: entry.trackIndex, codecid: entry.codecid,
    peerHost: entry.peerHost, peerIndex: entry.peerIndex,
  })),
  Q1: summarize('Q1'),
  Q1ByMirror: MIRRORS.concat(['peerHost']).reduce((acc, mirror) => {
    const label = mirror === 'peerHost' ? 'peerHost' : mirror.replace('.bilivideo.com', '');
    const rows = records.filter((record) => record.group === 'Q1'
      && (record.label === label || record.label.startsWith(`${label}`)));
    acc[label] = {
      total: rows.length,
      ok: rows.filter((record) => record.httpStatus === 206).length,
      statuses: rows.reduce((inner, record) => {
        inner[record.status] = (inner[record.status] || 0) + 1;
        return inner;
      }, {}),
    };
    return acc;
  }, {}),
  Q2a: summarize('Q2a'),
  Q2b: summarize('Q2b'),
  Q3: summarize('Q3'),
  Q4: summarize('Q4'),
  records,
};

writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');

process.stdout.write('\n══ 汇总 ══\n');
for (const group of ['Q1', 'Q2a', 'Q2b', 'Q3', 'Q4']) {
  const row = summary[group];
  process.stdout.write(
    `${group}: ${row.ok}/${row.total} 206，状态 ${JSON.stringify(row.statuses)}，` +
      `206 中位 TTFB ${row.medianTtfbMs}ms\n`,
  );
}
process.stdout.write('Q1 按 host：\n');
for (const [label, row] of Object.entries(summary.Q1ByMirror)) {
  process.stdout.write(`  ${label}: ${row.ok}/${row.total} 206 ${JSON.stringify(row.statuses)}\n`);
}
process.stdout.write(`已写出 ${OUT}\n`);