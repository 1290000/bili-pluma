/**
 * 从 `rewrite-4k-results.json` 的逐请求记录重算汇总（不发任何网络请求）。
 *
 * 用途：修正初版 `byMirror.ok` 计数起点，并按 ADR 0039 的两条规则
 * 给出"最终改写结果"的 206 率（规则 B 的直连对照只是对照，不属于最终改写）。
 *
 * 跑法：node poc/probe/pcdn-diag/recompute-4k-summary.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'rewrite-4k-results.json');

/** 中位数；空数组 → null */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const payload = JSON.parse(readFileSync(FILE, 'utf8'));
const records = payload.records;
const raw = JSON.parse(
  readFileSync(path.join(HERE, 'rewrite-4k-candidates.json'), 'utf8'),
);

/** 按目标 host 分组（只记最终状态，不记签名 URL） */
const byMirror = {};
for (const row of records) {
  const bucket = byMirror[row.targetHost] || (byMirror[row.targetHost] = {
    total: 0, ok: 0, codes: {}, ttfb: [], duration: [],
  });
  bucket.total += 1;
  if (row.httpStatus === 206) bucket.ok += 1;
  bucket.codes[row.status] = (bucket.codes[row.status] || 0) + 1;
  if (row.ttfbMs !== null) {
    bucket.ttfb.push(row.ttfbMs);
    bucket.duration.push(row.durationMs);
  }
}
for (const [host, bucket] of Object.entries(byMirror)) {
  bucket.medianTtfbMs = bucket.ttfb.length ? Math.round(median(bucket.ttfb)) : null;
  bucket.medianDurationMs = bucket.duration.length ? Math.round(median(bucket.duration)) : null;
  delete bucket.ttfb;
  delete bucket.duration;
  byMirror[host] = bucket;
}

/** 逐候选的"最终改写结果"：A 取 default，B 取 wrapped */
const finalByCandidate = new Map();
for (const row of records) {
  const key = `${row.bvid}|${row.trackIndex}|${row.candidateIndex}`;
  const isFinal = (row.rule === 'A' && row.mirror === 'default')
    || (row.rule === 'B' && row.mirror === 'proxy(wrapped)');
  if (isFinal) finalByCandidate.set(key, row);
}

/** 按规则统计最终结果 */
const byRule = { A: { total: 0, ok: 0, codes: {} }, B: { total: 0, ok: 0, codes: {} } };
for (const row of finalByCandidate.values()) {
  const bucket = byRule[row.rule];
  bucket.total += 1;
  if (row.httpStatus === 206) bucket.ok += 1;
  bucket.codes[row.status] = (bucket.codes[row.status] || 0) + 1;
}

/** 每条轨是否全部 PCDN 候选都改写成 206 */
let tracksWithPcdn = 0;
let tracksAllRewrittenOk = 0;
for (const video of raw.videos) {
  for (const track of video.tracks) {
    const pcdnKeys = track.candidates.map((candidate) => `${video.bvid}|${track.trackIndex}|${candidate.index}`);
    const finals = pcdnKeys.map((key) => finalByCandidate.get(key)).filter(Boolean);
    if (finals.length === 0) continue;
    tracksWithPcdn += 1;
    if (finals.every((row) => row.httpStatus === 206)) tracksAllRewrittenOk += 1;
  }
}

/** 失败样本的 path / host 共性（403 只会来自规则 B 的直连对照） */
const failureShapes = {};
const failureHosts = {};
for (const row of records) {
  if (row.httpStatus === 206) continue;
  const shape = `${row.rule}/${row.mirror} ${row.originalPathShape}`;
  failureShapes[shape] = (failureShapes[shape] || 0) + 1;
  const hostPattern = row.originalHost.replace(/\d+/g, 'N');
  failureHosts[hostPattern] = (failureHosts[hostPattern] || 0) + 1;
}

/** proxy 一跳的额外耗时（与同候选直连 403 对照配对） */
const extras = [];
const proxyPairs = [];
for (const row of records) {
  if (row.rule !== 'B' || row.mirror !== 'proxy(wrapped)') continue;
  const key = `${row.bvid}|${row.trackIndex}|${row.candidateIndex}`;
  const direct = records.find((candidate) =>
    candidate.rule === 'B' && candidate.mirror === 'proxy(direct-control)'
      && `${candidate.bvid}|${candidate.trackIndex}|${candidate.candidateIndex}` === key);
  const extra = direct && direct.durationMs !== null && row.durationMs !== null
    ? row.durationMs - direct.durationMs : null;
  if (extra !== null) extras.push(extra);
  proxyPairs.push({
    bvid: row.bvid, trackIndex: row.trackIndex, candidateIndex: row.candidateIndex,
    directStatus: direct?.status ?? null, directDurationMs: direct?.durationMs ?? null,
    wrappedStatus: row.status, wrappedDurationMs: row.durationMs, extraMs: extra,
  });
}

const summary = {
  ...payload.summary,
  byMirror,
  byRule,
  finalTotal: finalByCandidate.size,
  finalOk: Array.from(finalByCandidate.values()).filter((row) => row.httpStatus === 206).length,
  tracksWithPcdn,
  tracksAllRewrittenOk,
  failureShapes,
  failureHosts,
  proxyPairs,
  proxyMedianExtraMs: extras.length ? Math.round(median(extras)) : null,
};

writeFileSync(FILE, JSON.stringify({ summary, records }, null, 2), 'utf8');

process.stdout.write(`${JSON.stringify({
  stats: summary.stats,
  byRule: summary.byRule,
  finalOk: summary.finalOk,
  finalTotal: summary.finalTotal,
  tracksWithPcdn: summary.tracksWithPcdn,
  tracksAllRewrittenOk: summary.tracksAllRewrittenOk,
  byMirror: summary.byMirror,
  failureShapes: summary.failureShapes,
  failureHosts: summary.failureHosts,
  proxyMedianExtraMs: summary.proxyMedianExtraMs,
  proxyWrappedTtfb: Object.entries(byMirror['proxy-tf-all-ws.bilivideo.com']?.codes || {}),
}, null, 2)}\n`);
