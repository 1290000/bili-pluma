/**
 * ADR 0039 验证门 #1 · 阶段 B：把 2160p 的 PCDN 候选按两条规则换 authority 后实测。
 *
 * 输入：`rewrite-4k-candidates.json`（阶段 A 产出，gitignored，含签名 URL）。
 * 输出：`rewrite-4k-results.json`（gitignored；**只记 host 与 path 形态，不记签名 URL**）
 *       + 控制台汇总（用于写 `REPORT-rewrite-4k.md`）。
 *
 * 规则（与 ADR 0039 决定节一致）：
 *   A · 普通 PCDN          → new URL(url) 只换 protocol/host/port，path/search/hash 不动
 *   B · mcdn + /v1/resource/upgcxcode/ → proxy-tf-all-ws.bilivideo.com?url=<encodeURIComponent(原URL)>
 * 非 PCDN 候选只统计、不改写、不发请求。
 *
 * 请求规模控制（ADR 边界 8）：串行、每条间隔 150ms、单请求 12s 超时，
 * 默认镜像每条 PCDN 必打；对照镜像每轨最多各 1 条。总量远低于 200。
 *
 * 跑法：
 *   node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/verify-rewrite-4k.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.join(HERE, 'rewrite-4k-candidates.json');
const OUT = path.join(HERE, 'rewrite-4k-results.json');

/** 默认镜像（已在匿名 720p 上验过 206） */
const DEFAULT_MIRROR = 'upos-sz-mirrorhw.bilivideo.com';
/** 对照镜像（各抽测少量，用来回答"哪个镜像对 2160p 通"） */
const ALT_MIRRORS = [
  'upos-sz-mirrorcoso1.bilivideo.com',
  'upos-sz-estgoss.bilivideo.com',
];
const PROXY_HOST = 'proxy-tf-all-ws.bilivideo.com';
const MCDN_PATH = '/v1/resource/upgcxcode/';
const INTERVAL_MS = 150;
const TIMEOUT_MS = 12000;
const PROXY_TIMEOUT_MS = 20000;

/** 把毫秒数格式化成整数字符串 */
function ms(value) {
  return Math.round(value);
}

/** 中位数；空数组返回 null */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 只换 authority：protocol / host / port，pathname / search / hash 一字不动 */
function swapAuthority(rawUrl, mirrorHost) {
  const url = new URL(rawUrl);
  url.protocol = 'https:';
  url.hostname = mirrorHost;
  url.port = '';
  return url.toString();
}

/** mcdn proxy 包装：ADR 0039 允许的唯一 URL 结构例外 */
function wrapProxy(rawUrl) {
  return `https://${PROXY_HOST}/?url=${encodeURIComponent(rawUrl)}`;
}

/** 是不是 mcdn（`mcdn` 作为独立标签，与 classify.ts 的判据一致） */
function isMcdnHost(hostname) {
  return hostname.toLowerCase().split('.').includes('mcdn');
}

/** path 形态：只留前几段，不回传完整签名路径 */
function pathShape(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  return `/${segments.slice(0, 3).join('/')}${segments.length > 3 ? '/…' : ''}`;
}

/**
 * 发一次 Range 请求并计时。
 *
 * `fetch` resolve 于响应头到达 ⇒ 这就是 TTFB；随后立刻 cancel body，
 * 只量首块开销，不把整段媒体拉下来（ADR 边界 8）。
 *
 * @returns {{status: string, httpStatus: number|null, ttfb: number|null, duration: number|null}}
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
    try {
      await response.body?.cancel();
    } catch {
      // 取消 body 失败不影响状态码判定
    }
    const duration = performance.now() - start;
    const httpStatus = response.status;
    let status = String(httpStatus);
    if (httpStatus >= 400 && httpStatus < 500) status = `${httpStatus} (4xx)`;
    if (httpStatus >= 500) status = `${httpStatus} (5xx)`;
    return { status, httpStatus, ttfb: ms(ttfb), duration: ms(duration) };
  } catch (error) {
    const code = (error?.cause && error.cause.code) || error?.code || '';
    let status = '请求失败';
    if (error?.name === 'AbortError') status = '超时';
    else if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ENOSERVER'].includes(code)) status = 'DNS失败';
    const duration = performance.now() - start;
    return { status: `${status}${code ? `:${code}` : ''}`, httpStatus: null,
      ttfb: null, duration: ms(duration) };
  } finally {
    clearTimeout(timer);
  }
}

/** 小睡，控制请求节奏 */
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

// ─────────────────────────── 主流程 ───────────────────────────

const raw = JSON.parse(readFileSync(INPUT, 'utf8'));
const ua = (raw.videos.find((v) => v.ua) || {}).ua
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const records = [];
const stats = {
  videos: raw.videos.length,
  tracks: 0,
  candidates: 0,
  official: 0,
  'third-party': 0,
  unknown: 0,
  pcdn: 0,
  ruleA: 0,
  ruleB: 0,
  unparseable: 0,
  requests: 0,
};
const byMirror = new Map();
const failures = [];
const proxyPairs = [];

function bumpMirror(host, result) {
  if (!byMirror.has(host)) byMirror.set(host, { total: 0, ok: 0, codes: {}, ttfb: [], duration: [] });
  const bucket = byMirror.get(host);
  bucket.total += 1;
  if (result.httpStatus === 206) bucket.ok += 1;
  bucket.codes[result.status] = (bucket.codes[result.status] || 0) + 1;
  if (result.ttfb !== null) { bucket.ttfb.push(result.ttfb); bucket.duration.push(result.duration); }
}

async function record(meta, url, timeoutMs) {
  const headers = {
    'User-Agent': ua,
    Referer: `https://www.bilibili.com/video/${meta.bvid}/`,
    Origin: 'https://www.bilibili.com',
    Range: 'bytes=0-1023',
    Accept: '*/*',
  };
  const result = await probe(url, headers, timeoutMs);
  stats.requests += 1;
  const row = {
    ...meta,
    targetHost: new URL(url).hostname,
    status: result.status,
    httpStatus: result.httpStatus,
    ttfbMs: result.ttfb,
    durationMs: result.duration,
  };
  records.push(row);
  bumpMirror(row.targetHost, result);
  if (result.httpStatus !== 206) failures.push(row);
  process.stdout.write(
    `  ${meta.rule}/${meta.mirror} ${meta.bvid} #${meta.trackIndex}/${meta.candidateIndex}` +
      ` → ${row.status} ttfb=${row.ttfbMs}ms total=${row.durationMs}ms\n`,
  );
  await sleep(INTERVAL_MS);
  return row;
}

for (const video of raw.videos) {
  for (const track of video.tracks) {
    stats.tracks += 1;
    // 每轨的对照镜像配额：每个对照镜像最多 1 条（与默认镜像合计 ≤3/轨）
    const altQuota = new Map(ALT_MIRRORS.map((mirror) => [mirror, 1]));
    for (const candidate of track.candidates) {
      stats.candidates += 1;
      let url;
      try {
        url = new URL(candidate.url);
      } catch {
        stats.unparseable += 1;
        continue;
      }
      const cls = classifyCdn(url.hostname, url.search).cls;
      stats[cls] += 1;
      if (cls !== 'pcdn') continue;

      const meta = {
        bvid: video.bvid,
        trackIndex: track.trackIndex,
        codecid: track.codecid,
        candidateIndex: candidate.index,
        originalHost: url.hostname,
        originalPathShape: pathShape(url.pathname),
        hasOsMcdn: url.search.toLowerCase().split('&').includes('os=mcdn'),
        cls,
      };
      const isUgcxcode = url.pathname.includes(MCDN_PATH);
      const rule = isMcdnHost(url.hostname) && isUgcxcode ? 'B' : 'A';

      if (rule === 'B') {
        stats.ruleB += 1;
        meta.rule = 'B';
        meta.mirror = 'proxy(direct-control)';
        const direct = await record(meta, swapAuthority(candidate.url, DEFAULT_MIRROR), TIMEOUT_MS);
        meta.mirror = 'proxy(wrapped)';
        const wrapped = await record(meta, wrapProxy(candidate.url), PROXY_TIMEOUT_MS);
        proxyPairs.push({ bvid: meta.bvid, trackIndex: meta.trackIndex,
          candidateIndex: meta.candidateIndex, direct, wrapped });
      } else {
        stats.ruleA += 1;
        meta.rule = 'A';
        meta.mirror = 'default';
        await record(meta, swapAuthority(candidate.url, DEFAULT_MIRROR), TIMEOUT_MS);
        for (const mirror of ALT_MIRRORS) {
          if ((altQuota.get(mirror) || 0) <= 0) continue;
          altQuota.set(mirror, altQuota.get(mirror) - 1);
          meta.mirror = `alt:${mirror}`;
          await record(meta, swapAuthority(candidate.url, mirror), TIMEOUT_MS);
        }
      }
    }
  }
}

// ─────────────────────────── 汇总 ───────────────────────────

const summary = {
  at: new Date().toISOString(),
  stats,
  byMirror: Object.fromEntries(
    Array.from(byMirror.entries()).map(([host, value]) => [host, {
      ...value,
      medianTtfbMs: value.ttfb.length ? ms(median(value.ttfb)) : null,
      medianDurationMs: value.duration.length ? ms(median(value.duration)) : null,
      ttfb: undefined,
      duration: undefined,
    }]),
  ),
  failures: failures.map((row) => ({
    bvid: row.bvid, trackIndex: row.trackIndex, candidateIndex: row.candidateIndex,
    rule: row.rule, mirror: row.mirror, originalHost: row.originalHost,
    originalPathShape: row.originalPathShape, status: row.status,
  })),
  proxyPairs: proxyPairs.map((pair) => ({
    bvid: pair.bvid, trackIndex: pair.trackIndex, candidateIndex: pair.candidateIndex,
    directStatus: pair.direct.status, directTtfbMs: pair.direct.ttfbMs,
    directDurationMs: pair.direct.durationMs,
    wrappedStatus: pair.wrapped.status, wrappedTtfbMs: pair.wrapped.ttfbMs,
    wrappedDurationMs: pair.wrapped.durationMs,
    extraDurationMs: pair.wrapped.durationMs !== null && pair.direct.durationMs !== null
      ? pair.wrapped.durationMs - pair.direct.durationMs : null,
  })),
  proxyMedianExtraDurationMs: (() => {
    const deltas = proxyPairs
      .filter((p) => p.wrapped.durationMs !== null && p.direct.durationMs !== null)
      .map((p) => p.wrapped.durationMs - p.direct.durationMs);
    return deltas.length ? ms(median(deltas)) : null;
  })(),
};

// 记录里不存任何签名 URL，只有 host / path 形态，便于入库复核
writeFileSync(OUT, JSON.stringify({ summary, records }, null, 2), 'utf8');

const line = (text) => process.stdout.write(`${text}\n`);
line('');
line(`样本：${stats.videos} 视频 / ${stats.tracks} 条 2160p 轨 / ${stats.candidates} 条候选`);
line(
  `分类：pcdn=${stats.pcdn} official=${stats.official} ` +
    `third-party=${stats['third-party']} unknown=${stats.unknown} 解析失败=${stats.unparseable}`,
);
line(`规则命中：A=${stats.ruleA} B=${stats.ruleB}；总请求=${stats.requests}`);
line('按目标 host：');
for (const [host, value] of Object.entries(summary.byMirror)) {
  line(`  ${host}: ${value.ok}/${value.total} 206，中位 TTFB=${value.medianTtfbMs}ms，` +
    `中位耗时=${value.medianDurationMs}ms，码分布=${JSON.stringify(value.codes)}`);
}
line(`失败 ${failures.length} 条：`);
for (const f of summary.failures.slice(0, 30)) {
  line(`  ${f.rule}/${f.mirror} ${f.bvid} #${f.trackIndex}/${f.candidateIndex}` +
    ` ${f.originalHost} ${f.originalPathShape} → ${f.status}`);
}
line(`proxy 额外耗时中位=${summary.proxyMedianExtraDurationMs}ms（${proxyPairs.length} 对）`);
for (const p of summary.proxyPairs) {
  line(`  ${p.bvid} #${p.trackIndex}/${p.candidateIndex}: 直连 ${p.directStatus} ${p.directDurationMs}ms` +
    ` → proxy ${p.wrappedStatus} ${p.wrappedDurationMs}ms`);
}
line(`已写出 ${OUT}`);
