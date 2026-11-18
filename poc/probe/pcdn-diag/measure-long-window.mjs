/**
 * 「proxy 长窗口限速」探针 —— 检验 2 MiB 短窗口是否漏掉了 CDN 的突刺-限速行为。
 *
 * ## 为什么必须补这一测
 *
 * `measure-proxy-throughput.mjs` 的结论是 proxy 吞吐中位 7.78 MB/s、stall 0/36。
 * 但它自己的局限写着：**2 MiB 对 23.21 Mbps 的轨只够播 0.7 秒**。
 *
 * CDN 的典型行为是「先给你一段高速突发（burst）把你喂饱，然后降到目标速率」，
 * 正因为它要陪一个"initialize"/"fast start"的算法。如果限速拐点出现在 2 MiB 之后，
 * 那么前一测**恰好把突发段全部测到、把限速段全部漏掉** —— 结论就该反过来。
 *
 * 这不是鸡蛋里挑骨头：**proxy 是单向转发，它比直连更可能在长连接上被限速**
 * （中转节点通常有单连接带宽策略，而直连边缘节点没有）。
 *
 * ## 怎么测才不留死角
 *
 * 1. **窗口拉到 16 MiB**（对 23 Mbps 的轨约 5.5 秒），并在下载过程中**分桶记录**：
 *    每 2 MiB 一个桶，各桶独立算 MB/s。这样不必先假设拐点在哪 —— 曲线自己说话。
 * 2. **只测答复最慢的那条**（`mirrorcoso1` 直连 1.21 MB/s 是已知最差，测它最可能暴露问题），
 *    再加一条正常镜像做对照。**不铺开测**：16 MiB × N 对象对 B站 有真实带宽成本（ADR 0039 边界 8）。
 * 3. 同一对象 proxy 与直连**相邻执行**（间隔 1.5 s），减少时段漂移。
 *
 * ## 判据（写死在脚本里，避免事后挑数）
 *
 * - `degrades(series)`：末桶速率 ÷ 首桶速率 < 0.5 ⇒ **该路径存在限速**；
 * - 若 proxy 被判定限速而直连没有 ⇒ **前一测的结论不成立，必须改**；
 * - 若两者都被限速且末桶都低于轨码率 1.5 倍 ⇒ **卡顿是真的**，与 proxy 无关，
 *   那是「换 host 到官方也会卡」的另一类问题。
 *
 * 跑法（签名有效期约 1 小时，过期就得重采）：
 *   node poc/probe/pcdn-diag/measure-long-window.mjs
 *
 * 输入：`proxy-throughput-candidates.json`（复用已采样本，不重新取流）
 * 输出：`long-window.json`（gitignored，含签名 URL）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.join(HERE, 'proxy-throughput-candidates.json');
const OUT = path.join(HERE, process.env.LONG_OUT || 'long-window.json');

const PROXY_HOST = 'proxy-tf-all-ws.bilivideo.com';
/** 总下载量：16 MiB。对 23 Mbps 轨约 5.5 秒，足以越过常见 burst 拐点 */
const TOTAL_BYTES = 16 * 1024 * 1024;
/** 分桶粒度：每 2 MiB 一桶 */
const BUCKET_BYTES = 2 * 1024 * 1024;
/** 单次下载超时（16 MiB 慢路径可能久，给足） */
const TIMEOUT_MS = 60000;
/** 两条测之间歇多久（避免同连接复用/拥塞叠加） */
const GAP_MS = 1500;
/** 末端桶 / 首桶 低于此值判为「被限速」 */
const DEGRADE_RATIO = 0.5;

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
const ms = (v) => Math.round(v);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * 下载并把字节流切成等量桶，逐桶算瞬时速率。
 *
 * 为什么按**字节数**切桶而不是按时间切：字节等分后每桶代表"播了多少内容"，
 * 与轨码率可直接对比（邻桶速率下降即"喂不饱"），比按时间切更好解释。
 */
async function downloadBucketed(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();
  const buckets = [];
  let curBytes = 0;
  let curStart = null;
  let curEnd = null;
  let totalBytes = 0;
  let ttfbMs = null;
  let httpStatus = null;
  let maxGapMs = 0;
  let lastChunkAt = null;
  let firstChunkAt = null;

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    ttfbMs = performance.now() - start;
    httpStatus = response.status;
    if (httpStatus !== 206 && httpStatus !== 200) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => {});
      return { httpStatus, interrupted: true, error: `status-${httpStatus}`, buckets: [] };
    }

    const reader = response.body.getReader();
    let interrupted = false;
    while (totalBytes < TOTAL_BYTES) {
      const chunk = await reader.read();
      const now = performance.now();
      if (chunk.done) break;

      if (firstChunkAt === null) firstChunkAt = now;
      if (lastChunkAt !== null) maxGapMs = Math.max(maxGapMs, now - lastChunkAt);
      lastChunkAt = now;

      let value = chunk.value;
      totalBytes += value.byteLength;

      // 一个大 chunk 可能跨桶边界，需要逐段切
      while (value.byteLength > 0) {
        if (curStart === null) curStart = now;
        const room = BUCKET_BYTES - curBytes;
        const take = Math.min(room, value.byteLength);
        curBytes += take;
        curEnd = now;
        value = value.subarray(take);

        if (curBytes >= BUCKET_BYTES) {
          const secs = (curEnd - curStart) / 1000;
          buckets.push({
            index: buckets.length,
            bytes: curBytes,
            ms: ms(curEnd - curStart),
            mbPerSec: secs > 0 ? Number((curBytes / 1048576 / secs).toFixed(3)) : null,
          });
          curBytes = 0;
          curStart = null;
        }
      }
    }

    // 末尾不满一桶也记下来（可能是被截断的征兆）
    if (curBytes > 0 && curStart !== null) {
      const secs = (curEnd - curStart) / 1000;
      buckets.push({
        index: buckets.length,
        bytes: curBytes,
        partial: true,
        ms: ms(curEnd - curStart),
        mbPerSec: secs > 0 ? Number((curBytes / 1048576 / secs).toFixed(3)) : null,
      });
    }

    await reader.cancel().catch(() => {});
    clearTimeout(timer);

    return {
      httpStatus,
      ttfbMs: ms(ttfbMs),
      firstByteMs: firstChunkAt === null ? null : ms(firstChunkAt - start),
      totalBytes,
      complete: totalBytes >= TOTAL_BYTES,
      maxGapMs: ms(maxGapMs),
      buckets,
      interrupted,
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      httpStatus,
      interrupted: true,
      error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error),
      ttfbMs: ttfbMs === null ? null : ms(ttfbMs),
      totalBytes,
      buckets,
    };
  }
}

/** 首桶与末桶的速率比（末/首），用于判「是否被限速」 */
function degradeRatio(buckets) {
  const full = buckets.filter((b) => !b.partial && b.mbPerSec !== null && b.bytes === BUCKET_BYTES);
  if (full.length < 2) return null;
  const first = full[0].mbPerSec;
  const last = full[full.length - 1].mbPerSec;
  if (!first) return null;
  return Number((last / first).toFixed(3));
}

/** 取「后半段」的中位速率 —— 比末桶更能抵抗单桶抖动 */
function tailMedian(buckets) {
  const full = buckets.filter((b) => !b.partial && b.mbPerSec !== null && b.bytes === BUCKET_BYTES);
  if (full.length === 0) return null;
  const half = full.slice(Math.floor(full.length / 2));
  const vals = half.map((b) => b.mbPerSec).sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Number(((vals[mid - 1] + vals[mid]) / 2).toFixed(3));
}

// ── 选样本 ────────────────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(INPUT, 'utf8'));

/**
 * 挑对象：优先「直连镜像 = mirrorcoso1」（已知最慢，最可能暴露限速），
 * 再挑一个正常镜像做对照。各取 1 条 —— 边界 8 不许铺开测。
 *
 * ### 环境变量（第一轮跑完后补的，用于复核「慢」是持续限速还是慢启动）
 *
 * - `LONG_TARGETS=4` —— 每个分组最多挑几个对象（默认 1）
 * - `LONG_ONLY=slow|fast` —— 只测某一组（默认两组都测）
 *
 * 为什么需要它：第一轮 16 MiB 结果显示 `mirrorcoso1` 只有**第一桶**慢（1.24 MB/s，
 * 1.6 s），其后 7 桶全部 8–15 MB/s。这与 2 MiB 窗口得出的"慢镜像"结论矛盾 ——
 * 必须多对象复核，否则又会把一次慢启动写成镜像属性。
 */
const MAX_PER_GROUP = Number(process.env.LONG_TARGETS || 1);
const ONLY = (process.env.LONG_ONLY || '').trim();

const targets = [];
/** @type {Map<string, number>} */
const seenHosts = new Map();
for (const video of raw.videos) {
  for (const track of video.tracks) {
    const v1 = track.candidates.find((c) => c.url.includes('/v1/resource/upgcxcode/'));
    if (!v1) continue;
    // 直连对象：同轨里非 /v1、且 host 是 upos-sz-mirror* 的那条
    const direct = track.candidates.find(
      (c) => !c.url.includes('/v1/resource/') && /upos-sz-mirror/i.test(c.url),
    );
    if (!direct) continue;
    const host = new URL(direct.url).hostname;
    const isSlow = host.includes('mirrorcoso1');
    if (ONLY === 'slow' && !isSlow) continue;
    if (ONLY === 'fast' && isSlow) continue;
    const key = isSlow ? 'slow' : 'fast';
    const count = seenHosts.get(key) ?? 0;
    if (count >= MAX_PER_GROUP) continue;
    // 同一分组内跳过同轨（同 cid 的 t0/t1 是不同轨，允许，但避免重复 bvid+tid）
    const dedupe = `${video.bvid}#${track.trackIndex}`;
    if (targets.some((t) => `${t.video.bvid}#${t.track.trackIndex}` === dedupe)) continue;
    seenHosts.set(key, count + 1);
    targets.push({ video, track, v1, direct, host, isSlow });
  }
}

process.stdout.write(`\n══ 长窗口限速探针 · ${targets.length} 个对象 × ${TOTAL_BYTES / 1048576} MiB ══\n`);
process.stdout.write(`   判据：末桶/首桶 < ${DEGRADE_RATIO} ⇒ 该路径被限速\n\n`);

const rows = [];

for (const target of targets) {
  const { video, track, v1, direct, host, isSlow } = target;
  const referer = `https://www.bilibili.com/video/${video.bvid}/`;
  const headers = (range) => ({
    'User-Agent': UA,
    Referer: referer,
    Origin: 'https://www.bilibili.com',
    Range: range,
    Accept: '*/*',
  });
  const range = `bytes=0-${TOTAL_BYTES - 1}`;
  const proxyUrl = `https://${PROXY_HOST}/?url=${encodeURIComponent(v1.url)}`;

  process.stdout.write(
    `── ${video.bvid} #t${track.trackIndex} cc${track.codecid} ` +
      `码率 ${(track.bandwidth / 1e6).toFixed(2)} Mbps 直连镜像 ${host}${isSlow ? '（已知最慢）' : ''} ──\n`,
  );

  // 交替顺序：慢镜像先 proxy，正常镜像先直连 —— 避免固定顺序偏差
  const order = isSlow ? ['proxy', 'direct'] : ['direct', 'proxy'];

  for (const kind of order) {
    const url = kind === 'proxy' ? proxyUrl : direct.url;
    const r = await downloadBucketed(url, headers(range));
    const ratio = degradeRatio(r.buckets);
    const tail = tailMedian(r.buckets);
    const row = {
      bvid: video.bvid,
      trackIndex: track.trackIndex,
      codecid: track.codecid,
      trackBandwidthMbps: Number((track.bandwidth / 1e6).toFixed(3)),
      directHost: host,
      kind,
      order: order.join('-'),
      ...r,
      degradeRatio: ratio,
      tailMedianMbps: tail,
      degraded: ratio !== null && ratio < DEGRADE_RATIO,
    };
    rows.push(row);

    const series = r.buckets
      .filter((b) => !b.partial)
      .map((b) => b.mbPerSec)
      .join(' → ');
    process.stdout.write(
      `   ${kind.padEnd(6)} ${r.httpStatus} ttfb=${r.ttfbMs}ms 桶序列：${series || '—'}\n` +
        `          ${r.complete ? '完整' : '未完成'} ${r.totalBytes}/${TOTAL_BYTES} 字节` +
        `  末/首=${ratio ?? '—'}  后半中位=${tail ?? '—'} MB/s` +
        `${r.degraded ? '  ⚠️ 被限速' : ''}\n`,
    );
    await sleep(GAP_MS);
  }
  process.stdout.write('\n');
}

// ── 汇总 ──────────────────────────────────────────────────────────────
const byKind = { proxy: [], direct: [] };
for (const row of rows) byKind[row.kind].push(row);

const summary = {};
for (const [kind, list] of Object.entries(byKind)) {
  const ratios = list.map((r) => r.degradeRatio).filter((v) => v !== null);
  const tails = list.map((r) => r.tailMedianMbps).filter((v) => v !== null);
  summary[kind] = {
    n: list.length,
    degradedCount: list.filter((r) => r.degraded).length,
    degradeRatios: ratios,
    tailMedians: tails,
    interruptedCount: list.filter((r) => r.interrupted).length,
  };
}

process.stdout.write('══ 汇总 ══\n');
for (const [kind, s] of Object.entries(summary)) {
  process.stdout.write(
    `  ${kind.padEnd(6)} n=${s.n} 被限速 ${s.degradedCount} 中断 ${s.interruptedCount}` +
      ` 末/首=${JSON.stringify(s.degradeRatios)} 后半中位=${JSON.stringify(s.tailMedians)}\n`,
  );
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      note: 'proxy 长窗口（16 MiB、按 2 MiB 分桶）限速探针；含签名 URL，gitignored',
      config: { totalBytes: TOTAL_BYTES, bucketBytes: BUCKET_BYTES, degradeRatio: DEGRADE_RATIO },
      sourceAt: raw.at,
      summary,
      rows,
    },
    null,
    2,
  ),
);

process.stdout.write(`\n已写出 ${OUT}\n`);