/**
 * 「proxy 到底慢不慢」探针 · 吞吐量与冷热档。
 *
 * ## 为什么不能再只看 TTFB
 *
 * 前两轮的结论互相矛盾：第一轮 proxy TTFB 中位 949 ms（18 条里 10 条 ≥915 ms，
 * 478–915 之间零样本 ⇒ 明显两档），第二轮 45 条全部 ≤474 ms。TTFB 只能说明"首字节多久到"，
 * 而 4K 轨的 `bandwidth` 是 6–12 Mbps：若 proxy 这一跳在**首字节之后**限速，
 * 用户看到的是卡顿，而不是"多等 800 ms"。这是前两轮共同的盲区。
 *
 * ## 三组测量（与任务书一一对应）
 *
 * | 组 | 做法 | 回答 |
 * | --- | --- | --- |
 * | **T**（throughput） | 同一对象 proxy 包装 vs 官方直连，各下 `Range: bytes=0-2MiB` | proxy 的持续吞吐是否低于直连 |
 * | **C**（cold） | 同一 proxy URL 连续 5 次，逐次记 TTFB | 冷对象是否必落慢档 / 缓存假设是否成立 |
 * | **D**（direct tail） | 官方直连的慢样本按 host 归类 | 是否某个官方镜像本身慢 |
 *
 * ## 为什么 T 组要交替顺序、并且每轮重来
 *
 * 网络有日间漂移，若先跑完所有 proxy 再跑所有 direct，两者会被不同时段的拥塞污染。
 * 因此逐对象交替（一半对象 proxy-first、一半 direct-first），并重复 `ROUNDS` 轮。
 *
 * ## 为什么 C 组必须用**全新**对象
 *
 * 第一轮曾对 15 个对象各发过一次 proxy 请求 —— 在 proxy 边缘它们已经是热的。
 * 拿它们测"冷对象是否必慢"必然得出"不慢"的错误结论。所以 C 组用
 * `proxy-throughput-candidates.json`（采集时排除了上一轮全部 bvid），
 * 且**每个对象只测一次连续 5 请求**，绝不重复使用。
 *
 * ## 口径
 *
 * UA + `Referer: https://www.bilibili.com/` + `Range`；串行，每条间隔 `INTERVAL_MS`。
 * 下载量：`Range: bytes=0-2097152`（2 MiB，含首尾 ⇒ content-length 2097153）。
 * 中途按 `reader.read()` 的 chunk 到达时间戳算最大间隔，>2000 ms 记 stall。
 *
 * 跑法：
 *   node poc/probe/pcdn-diag/measure-proxy-throughput.mjs
 *
 * 环境变量：`THROUGHPUT_OUT`（默认 `proxy-throughput.json`）、`ROUNDS`（默认 3）。
 *
 * 输入：`proxy-throughput-candidates.json`（阶段 A 冷样本，gitignored）
 * 输出：`proxy-throughput.json`（gitignored）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.join(HERE, process.env.THROUGHPUT_IN || 'proxy-throughput-candidates.json');
const OUT = path.join(HERE, process.env.THROUGHPUT_OUT || 'proxy-throughput.json');
/** 上一轮（已热）候选池，仅用于 D 组的直连慢样本归类 */
const WARM_INPUT = path.join(HERE, 'v1-path-candidates.json');

const PROXY_HOST = 'proxy-tf-all-ws.bilivideo.com';
const V1_PREFIX = '/v1/resource/upgcxcode/';
/** 2 MiB；Range 上界含端点，所以实际返回 2097153 字节 */
const RANGE_END = 2 * 1024 * 1024 - 1;
const TARGET_BYTES = RANGE_END + 1;
const INTERVAL_MS = 150;
/** 单次下载超时：2 MiB / 最慢 ~20 KB/s 也要 100 s，给足 */
const DOWNLOAD_TIMEOUT_MS = 60000;
/** 首字节等待超时 */
const TTFB_TIMEOUT_MS = 30000;
/** 相邻 chunk 间隔超过此值即视为 stall */
const STALL_MS = 2000;
const ROUNDS = Number(process.env.ROUNDS || 3);
/** T 组样本对象数 */
const THROUGHPUT_SAMPLE = 12;
/** C 组样本对象数（每个只测一次） */
const COLD_SAMPLE = 8;

/** 中位数；空数组 → null */
function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 分位数（线性插值） */
function quantile(values, p) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round3 = (value) => (value === null || value === undefined ? null : Math.round(value * 1000) / 1000);
const ms = (value) => (value === null || value === undefined ? null : Math.round(value));
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

/**
 * 下载前 `bytes` 字节并全程计时。
 *
 * 关键分界：
 * - `ttfbMs` —— `fetch` resolve（响应头到达）；
 * - `transferMs` —— 首块到达 → 最后一字节到达，**只算有效载荷时间**，不含 TTFB；
 * - `mbPerSec` —— `TARGET_BYTES / transferMs`，这才是 4K 播放真正吃到的速率；
 * - `maxGapMs` —— 相邻 chunk 的最大间隔，>2000 ms 记 stall。
 *
 * `fetch` 没有暴露"首块到达"的回调，所以把第一次 `reader.read()` 返回的时刻当作首块，
 * 用 `响应头到达 → 首块` 的差单独记录（`headerToFirstByteMs`），避免把它算进传输时间。
 *
 * @returns 状态、TTFB、传输耗时、吞吐、最大间隔、字节数
 */
async function download(url, headers, limitBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const start = performance.now();
  let ttfbMs = null;
  let firstChunkMs = null;
  let totalBytes = 0;
  let maxGapMs = 0;
  let chunks = 0;
  let httpStatus = null;
  let statusText = null;
  let errorLabel = null;
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    ttfbMs = performance.now() - start;
    httpStatus = response.status;
    statusText = String(response.status);
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        status: statusText, httpStatus, ttfbMs: ms(ttfbMs), transferMs: null,
        mbPerSec: null, totalBytes: 0, maxGapMs: null, chunks: 0,
        headerToFirstByteMs: null, truncated: true, error: 'no-body',
      };
    }
    let last = performance.now();
    while (totalBytes < limitBytes) {
      const chunk = await reader.read();
      const now = performance.now();
      if (chunk.done) break;
      if (firstChunkMs === null) firstChunkMs = now;
      const gap = now - last;
      if (chunks > 0 && gap > maxGapMs) maxGapMs = gap;
      last = now;
      totalBytes += chunk.value.byteLength;
      chunks += 1;
    }
    const endMs = performance.now();
    await reader.cancel().catch(() => {});
    const transferMs = firstChunkMs === null ? null : endMs - firstChunkMs;
    return {
      status: statusText,
      httpStatus,
      ttfbMs: ms(ttfbMs),
      headerToFirstByteMs: firstChunkMs === null ? null : ms(firstChunkMs - start - ttfbMs),
      transferMs: ms(transferMs),
      mbPerSec: transferMs && transferMs > 0
        ? round3(totalBytes / 1048576 / (transferMs / 1000))
        : null,
      totalBytes,
      maxGapMs: chunks > 1 ? ms(maxGapMs) : 0,
      chunks,
      stalled: chunks > 1 && maxGapMs > STALL_MS,
      truncated: totalBytes < limitBytes,
    };
  } catch (error) {
    const code = (error?.cause && error.cause.code) || error?.code || '';
    if (error?.name === 'AbortError') errorLabel = '超时';
    else if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ENOSERVER'].includes(code)) errorLabel = `DNS失败:${code}`;
    else errorLabel = `失败:${code || error.message}`;
    return {
      status: errorLabel, httpStatus: null,
      ttfbMs: ttfbMs === null ? null : ms(ttfbMs),
      headerToFirstByteMs: null, transferMs: null, mbPerSec: null,
      totalBytes, maxGapMs: null, chunks, truncated: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 只测首字节（C 组：连续 5 次看冷热档位变化，不需要下载整段） */
async function headOnly(url, headers, timeoutMs = TTFB_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
    const ttfb = performance.now() - start;
    let bodyBytes = 0;
    try {
      const reader = response.body?.getReader();
      if (reader) {
        const chunk = await reader.read();
        bodyBytes = chunk?.value?.byteLength || 0;
        await reader.cancel().catch(() => {});
      }
    } catch {
      // 忽略 body 读取失败
    }
    return { status: String(response.status), httpStatus: response.status, ttfbMs: ms(ttfb), bodyBytes };
  } catch (error) {
    const code = (error?.cause && error.cause.code) || error?.code || '';
    const label = error?.name === 'AbortError' ? '超时' : `失败:${code || error.message}`;
    return { status: label, httpStatus: null, ttfbMs: ms(performance.now() - start), bodyBytes: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── 读样本 ───────────────────────────

if (!existsSync(INPUT)) {
  throw new Error(`缺少输入 ${INPUT} —— 先跑 collect-v1-path-candidates.mjs`);
}
const raw = JSON.parse(readFileSync(INPUT, 'utf8'));
const ua = (raw.videos.find((video) => video.ua) || {}).ua
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/**
 * 每个对象 = 一条轨里真实存在的 `/v1` 候选（必须走 proxy）
 * + 同轨官方对等候选（必须能直连）。
 *
 * 两条都取不到的对象无法成对比较，直接跳过。
 */
const pool = [];
for (const video of raw.videos) {
  for (const track of video.tracks || []) {
    if (!track.hasV1) continue;
    const v1 = (track.candidates || []).find((candidate) => candidate.url.includes(V1_PREFIX));
    if (!v1) continue;
    const peers = (track.candidates || []).filter((candidate) => !candidate.url.includes(V1_PREFIX));
    const peer = peers.find((candidate) => candidate.index === 2) || peers[peers.length - 1];
    if (!peer) continue;
    pool.push({
      bvid: video.bvid,
      trackIndex: track.trackIndex,
      codecid: track.codecid,
      bandwidth: track.bandwidth,
      v1Url: v1.url,
      peerUrl: peer.url,
      peerHost: new URL(peer.url).hostname,
    });
  }
}
process.stdout.write(`冷样本池：${pool.length} 条含 /v1 的轨（源 ${raw.at}）\n`);
if (pool.length === 0) throw new Error('样本池为空，无法测量');

/** 交替取样：跨 bvid、跨 codecid */
function pickSample(entries, want) {
  const picked = [];
  const usedBvid = new Set();
  for (const codecid of [7, 12, 13]) {
    const found = entries.find((entry) => entry.codecid === codecid && !usedBvid.has(entry.bvid));
    if (found && picked.length < want) {
      picked.push(found);
      usedBvid.add(found.bvid);
    }
  }
  for (const pass of [true, false]) {
    for (const entry of entries) {
      if (picked.length >= want) break;
      if (picked.includes(entry)) continue;
      if (pass && usedBvid.has(entry.bvid)) continue;
      picked.push(entry);
      usedBvid.add(entry.bvid);
    }
  }
  return picked.slice(0, want);
}

const throughputSample = pickSample(pool, Math.min(THROUGHPUT_SAMPLE, pool.length));
const coldSample = pickSample(
  pool.filter((entry) => !throughputSample.includes(entry)), Math.min(COLD_SAMPLE, pool.length));

function headersFor(range) {
  return {
    'User-Agent': ua,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Range: range,
    Accept: '*/*',
  };
}

const proxyUrlOf = (v1Url) => `https://${PROXY_HOST}/?url=${encodeURIComponent(v1Url)}`;
const objectKey = (entry) => `${entry.bvid}#t${entry.trackIndex}`;

// ─────────────────────────── T 组：吞吐量 ───────────────────────────

process.stdout.write(`\n══ T：proxy vs 直连，各下 2 MiB，${throughputSample.length} 对象 × ${ROUNDS} 轮 ══\n`);
const throughputRows = [];
for (let round = 1; round <= ROUNDS; round += 1) {
  process.stdout.write(`\n── 第 ${round} 轮 ──\n`);
  for (let index = 0; index < throughputSample.length; index += 1) {
    const entry = throughputSample[index];
    /** 奇偶交替顺序，消除"总是 proxy 先跑"的偏差 */
    const proxyFirst = (index + round) % 2 === 0;
    const proxyUrl = proxyUrlOf(entry.v1Url);
    const range = `bytes=0-${RANGE_END}`;
    let proxy;
    let direct;
    if (proxyFirst) {
      proxy = await download(proxyUrl, headersFor(range), TARGET_BYTES);
      await sleep(INTERVAL_MS);
      direct = await download(entry.peerUrl, headersFor(range), TARGET_BYTES);
    } else {
      direct = await download(entry.peerUrl, headersFor(range), TARGET_BYTES);
      await sleep(INTERVAL_MS);
      proxy = await download(proxyUrl, headersFor(range), TARGET_BYTES);
    }
    const row = {
      round, kind: 'throughput', order: proxyFirst ? 'proxy-first' : 'direct-first',
      bvid: entry.bvid, trackIndex: entry.trackIndex, codecid: entry.codecid,
      bandwidth: entry.bandwidth, peerHost: entry.peerHost,
      proxy: { ...proxy, host: PROXY_HOST },
      direct: { ...direct, host: entry.peerHost },
    };
    throughputRows.push(row);
    process.stdout.write(
      `  ${objectKey(entry)} cc${entry.codecid} ${row.order} ` +
        `proxy[${proxy.status} ttfb=${proxy.ttfbMs} xfer=${proxy.transferMs} ` +
        `${proxy.mbPerSec} MB/s gap=${proxy.maxGapMs}${proxy.stalled ? ' STALL' : ''}] ` +
        `direct[${direct.status} ttfb=${direct.ttfbMs} xfer=${direct.transferMs} ` +
        `${direct.mbPerSec} MB/s gap=${direct.maxGapMs}${direct.stalled ? ' STALL' : ''}]\n`,
    );
    await sleep(INTERVAL_MS);
  }
}

// ─────────────────────────── C 组：冷对象 5 连发 ───────────────────────────

process.stdout.write(`\n══ C：冷对象同一 proxy URL 连续 5 次，${coldSample.length} 对象 ══\n`);
const coldRows = [];
for (const entry of coldSample) {
  const proxyUrl = proxyUrlOf(entry.v1Url);
  const attempts = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    /** 首次用完整 2 MiB（真实冷路径），后续用 1 KiB（只看首字节档位，别把对象又焐热） */
    const range = attempt === 1 ? `bytes=0-${RANGE_END}` : 'bytes=0-1023';
    if (attempt === 1) {
      const first = await download(proxyUrl, headersFor(range), TARGET_BYTES);
      attempts.push({ attempt, range: '2MiB', ...first });
    } else {
      const later = await headOnly(proxyUrl, headersFor(range));
      attempts.push({ attempt, range: '1KiB', ...later });
    }
    await sleep(INTERVAL_MS);
  }
  const row = {
    kind: 'cold', bvid: entry.bvid, trackIndex: entry.trackIndex,
    codecid: entry.codecid, bandwidth: entry.bandwidth, peerHost: entry.peerHost,
    attempts,
  };
  coldRows.push(row);
  process.stdout.write(
    `  ${objectKey(entry)} cc${entry.codecid} → ` +
      attempts.map((item) => `${item.status}@${item.ttfbMs}`).join(' ') + '\n',
  );
}

// ─────────────────────────── D 组：直连慢样本归类 ───────────────────────────

/** 把 T 组所有官方直连样本按 host 归类，看慢的是否集中在某个镜像 */
const directByHost = {};
for (const row of throughputRows) {
  const host = row.direct.host;
  const bucket = (directByHost[host] = directByHost[host] || { n: 0, ttfb: [], mbps: [] });
  if (row.direct.httpStatus === 206) {
    bucket.n += 1;
    if (row.direct.ttfbMs !== null) bucket.ttfb.push(row.direct.ttfbMs);
    if (row.direct.mbPerSec !== null) bucket.mbps.push(row.direct.mbPerSec);
  }
}
const directHostSummary = Object.entries(directByHost).map(([host, bucket]) => ({
  host,
  n: bucket.n,
  ttfbMed: ms(median(bucket.ttfb)),
  ttfbP90: ms(quantile(bucket.ttfb, 0.9)),
  ttfbMax: bucket.ttfb.length ? Math.max(...bucket.ttfb) : null,
  mbpsMed: round3(median(bucket.mbps)),
  slowCount: bucket.ttfb.filter((value) => value >= 500).length,
}));

// ─────────────────────────── 汇总 ───────────────────────────

/** 成对统计：只取两边都 206 的行 */
const paired = throughputRows.filter((row) => row.proxy.httpStatus === 206 && row.direct.httpStatus === 206);
const proxyMbps = paired.map((row) => row.proxy.mbPerSec).filter((value) => value !== null);
const directMbps = paired.map((row) => row.direct.mbPerSec).filter((value) => value !== null);
/** 逐对比值：同一轮同一对象的 proxy / direct 吞吐 */
const ratios = paired
  .filter((row) => row.proxy.mbPerSec && row.direct.mbPerSec)
  .map((row) => row.proxy.mbPerSec / row.direct.mbPerSec);
const proxyTtfb = paired.map((row) => row.proxy.ttfbMs).filter((value) => value !== null);
const directTtfb = paired.map((row) => row.direct.ttfbMs).filter((value) => value !== null);

/**
 * 是否足以播 4K：轨的 `bandwidth` 单位是 bit/s，除以 8 得字节需求；
 * 留 1.5 倍余量（播放器需要缓冲填充，实际可持续速率要高于码率）。
 */
const SUSTAIN_FACTOR = 1.5;
const playbackRows = paired.map((row) => {
  const needMbps = (row.bandwidth / 8) / 1048576;
  return {
    bvid: row.bvid, trackIndex: row.trackIndex, codecid: row.codecid,
    bandwidthMbps: round3(needMbps),
    needWithFactor: round3(needMbps * SUSTAIN_FACTOR),
    proxyOk: row.proxy.mbPerSec !== null && row.proxy.mbPerSec >= needMbps * SUSTAIN_FACTOR,
    directOk: row.direct.mbPerSec !== null && row.direct.mbPerSec >= needMbps * SUSTAIN_FACTOR,
    proxyMbps: row.proxy.mbPerSec,
    directMbps: row.direct.mbPerSec,
  };
});

/** C 组：首次 vs 后续的 TTFB 对比（本轮核心判断） */
const coldStats = coldRows.map((row) => {
  const first = row.attempts[0];
  const rest = row.attempts.slice(1);
  const restTtfb = rest.map((item) => item.ttfbMs).filter((value) => value !== null);
  return {
    bvid: row.bvid, trackIndex: row.trackIndex, codecid: row.codecid,
    firstTtfb: first.ttfbMs,
    firstStatus: first.status,
    restTtfb,
    restMed: ms(median(restTtfb)),
    drop: first.ttfbMs !== null && restTtfb.length
      ? ms(first.ttfbMs - median(restTtfb)) : null,
  };
});
const firstValues = coldStats.map((entry) => entry.firstTtfb).filter((value) => value !== null);
const restValues = coldStats.flatMap((entry) => entry.restTtfb);
/** 慢档阈值：第一轮的"两档"分界在 478 / 915 之间，取 600 ms 作为保守判据 */
const SLOW_THRESHOLD_MS = 600;
const coldFirstSlow = firstValues.filter((value) => value >= SLOW_THRESHOLD_MS).length;
const coldRestSlow = restValues.filter((value) => value >= SLOW_THRESHOLD_MS).length;

const summary = {
  at: new Date().toISOString(),
  sourceAt: raw.at,
  note: '「proxy 吞吐量与冷热档」探针；含签名 URL，gitignored',
  config: {
    rangeEnd: RANGE_END, targetBytes: TARGET_BYTES, rounds: ROUNDS,
    throughputSample: throughputSample.length, coldSample: coldSample.length,
    intervalMs: INTERVAL_MS, stallMs: STALL_MS, slowThresholdMs: SLOW_THRESHOLD_MS,
    sustainFactor: SUSTAIN_FACTOR,
  },
  sample: {
    throughput: throughputSample.map((entry) => ({
      bvid: entry.bvid, trackIndex: entry.trackIndex,
      codecid: entry.codecid, bandwidth: entry.bandwidth, peerHost: entry.peerHost,
    })),
    cold: coldSample.map((entry) => ({
      bvid: entry.bvid, trackIndex: entry.trackIndex,
      codecid: entry.codecid, bandwidth: entry.bandwidth, peerHost: entry.peerHost,
    })),
  },
  throughput: {
    pairs: paired.length,
    proxy: {
      n: proxyMbps.length,
      mbpsMed: round3(median(proxyMbps)),
      mbpsP10: round3(quantile(proxyMbps, 0.1)),
      mbpsP90: round3(quantile(proxyMbps, 0.9)),
      mbpsMin: proxyMbps.length ? round3(Math.min(...proxyMbps)) : null,
      mbpsMax: proxyMbps.length ? round3(Math.max(...proxyMbps)) : null,
      ttfbMed: ms(median(proxyTtfb)),
      ttfbP90: ms(quantile(proxyTtfb, 0.9)),
      stallCount: paired.filter((row) => row.proxy.stalled).length,
      truncatedCount: paired.filter((row) => row.proxy.truncated).length,
    },
    direct: {
      n: directMbps.length,
      mbpsMed: round3(median(directMbps)),
      mbpsP10: round3(quantile(directMbps, 0.1)),
      mbpsP90: round3(quantile(directMbps, 0.9)),
      mbpsMin: directMbps.length ? round3(Math.min(...directMbps)) : null,
      mbpsMax: directMbps.length ? round3(Math.max(...directMbps)) : null,
      ttfbMed: ms(median(directTtfb)),
      ttfbP90: ms(quantile(directTtfb, 0.9)),
      stallCount: paired.filter((row) => row.direct.stalled).length,
      truncatedCount: paired.filter((row) => row.direct.truncated).length,
    },
    ratio: {
      n: ratios.length,
      medOfRatios: round3(median(ratios)),
      p10: round3(quantile(ratios, 0.1)),
      p90: round3(quantile(ratios, 0.9)),
      min: ratios.length ? round3(Math.min(...ratios)) : null,
      max: ratios.length ? round3(Math.max(...ratios)) : null,
      proxyWins: ratios.filter((value) => value > 1).length,
    },
  },
  playback: {
    total: playbackRows.length,
    proxyOk: playbackRows.filter((row) => row.proxyOk).length,
    directOk: playbackRows.filter((row) => row.directOk).length,
    rows: playbackRows,
  },
  cold: {
    objects: coldStats.length,
    slowThresholdMs: SLOW_THRESHOLD_MS,
    firstTtfbMed: ms(median(firstValues)),
    restTtfbMed: ms(median(restValues)),
    firstSlow: coldFirstSlow,
    restSlow: coldRestSlow,
    rows: coldStats,
  },
  directHostSummary,
  throughputRows,
  coldRows,
};

writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');

process.stdout.write('\n══ 汇总 ══\n');
process.stdout.write(
  `T 组配对 ${summary.throughput.pairs} 对\n` +
    `  proxy  吞吐中位 ${summary.throughput.proxy.mbpsMed} MB/s ` +
    `(p10 ${summary.throughput.proxy.mbpsP10} / p90 ${summary.throughput.proxy.mbpsP90})，` +
    `TTFB 中位 ${summary.throughput.proxy.ttfbMed}ms，stall ${summary.throughput.proxy.stallCount}\n` +
    `  direct 吞吐中位 ${summary.throughput.direct.mbpsMed} MB/s ` +
    `(p10 ${summary.throughput.direct.mbpsP10} / p90 ${summary.throughput.direct.mbpsP90})，` +
    `TTFB 中位 ${summary.throughput.direct.ttfbMed}ms，stall ${summary.throughput.direct.stallCount}\n` +
    `  逐对比值（proxy/direct）中位 ${summary.throughput.ratio.medOfRatios}，` +
    `p10 ${summary.throughput.ratio.p10} / p90 ${summary.throughput.ratio.p90}，` +
    `proxy 更快 ${summary.throughput.ratio.proxyWins}/${summary.throughput.ratio.n}\n` +
    `  可播 4K（含 ${SUSTAIN_FACTOR}× 余量）：proxy ${summary.playback.proxyOk}/${summary.playback.total}，` +
    `direct ${summary.playback.directOk}/${summary.playback.total}\n`,
);
process.stdout.write(
  `C 组冷对象 ${summary.cold.objects} 个：首次 TTFB 中位 ${summary.cold.firstTtfbMed}ms ` +
    `（≥${SLOW_THRESHOLD_MS}ms 的 ${summary.cold.firstSlow}/${summary.cold.objects}），` +
    `后续 TTFB 中位 ${summary.cold.restTtfbMed}ms ` +
    `（≥${SLOW_THRESHOLD_MS}ms 的 ${summary.cold.restSlow}/${summary.cold.objects * 4}）\n`,
);
process.stdout.write('D 组官方直连按 host：\n');
for (const row of directHostSummary) {
  process.stdout.write(
    `  ${row.host.padEnd(34)} n=${row.n} ttfb 中位 ${row.ttfbMed}ms ` +
      `p90 ${row.ttfbP90}ms max ${row.ttfbMax}ms 慢样本 ${row.slowCount} 吞吐中位 ${row.mbpsMed} MB/s\n`,
  );
}
process.stdout.write(`已写出 ${OUT}\n`);