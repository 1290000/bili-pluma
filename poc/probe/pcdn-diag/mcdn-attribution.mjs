/**
 * `os=mcdn` 改写后的实际归属 —— Q-A / Q-B / Q-C / Q-D（2026-11-18）。
 *
 * ## 为什么这项可能比原任务更关键
 *
 * `classify.ts` 第 5 条判据是「query 里整段 `os=mcdn` → `cls='pcdn'`」，注释称它是
 * 「官方镜像代理 mcdn 资源时**唯一**的信号」。
 *
 * 而 `rewriteOne()`（`core/cdn/filter.ts` → 主世界 `rewriteCandidateUrl()`）
 * 按 ADR 0039「只改 authority，path/search/hash 一字不动」——
 * **换掉了 host，却把 `os=mcdn` 原封不动留在 query 里**。
 *
 * 于是改写之后：
 * ```
 * before: mountaintoys + os=mcdn            → classify = pcdn
 * after : upos-sz-mirrorhw + 同一串 os=mcdn → classify = pcdn   ← 仍然是 pcdn
 * ```
 *
 * 后果：改写成功后**我们自己的分类器仍把这条请求判成 PCDN**，
 * 线路卡的时间轴照旧画橙色 P2P 节点。用户看到「开关开着、时间轴还有 P2P」
 * 完全合理 —— 而这不是"没屏蔽"，是**判据与改写互相矛盾**。
 *
 * ## 本脚本要回答的四件事
 *
 * | # | 问题 | 判据 |
 * | --- | --- | --- |
 * | Q-A | 形态 2（官方镜像 + os=mcdn）返回 206 吗？ | 403 ⇒ 签名绑了 host / os 不能跨 host 用，改写本身就是坏的 |
 * | Q-B | 形态 2 的响应头与形态 1、与基线各差在哪？ | 形态 2 的头更像形态 1（同一套 Server/X-Cache 家族）⇒ 换 host 只是换入口，源站仍是 mcdn |
 * | Q-C | 形态 2 与形态 1 的首块字节相同吗？ | 相同 ⇒ 同一份资源；不同 ⇒ 拿到了别的版本 |
 * | Q-D | 形态 3（proxy）相对形态 2，头更像基线吗？ | 更像 ⇒ proxy 才是真能脱离 mcdn 的路径 |
 *
 * ## 三种形态（输入来自 `pgc-pcdn.json` 里的现场候选 —— 签名会过期，必须现取）
 *
 * 1. **原样**：`*.mcdn.bilivideo.cn` / `*.edge.mountaintoys.cn`，带 `os=mcdn`
 * 2. **换 host 到官方镜像，query 完全不动**：`upos-sz-mirrorhw.bilivideo.com`
 *    ← **这是生产代码当前真正会产出的形态**（`DEFAULT_REWRITE_RULES.mirrorHost`）
 * 3. **proxy 包装**：`https://proxy-tf-all-ws.bilivideo.com?url=<encodeURIComponent(原URL)>`
 * 4. **基线**：一条本来就干净的官方候选（`os` 不是 `mcdn`）
 *
 * 每个请求 `Range: bytes=0-1023`，记**全量响应头** + TTFB + 首块 md5。
 * Node 侧（undici）没有 CORS 限制，`Server` / `Via` / `X-Cache` 都能读到 ——
 * 这正是 Q-B 需要的判据（浏览器里读不到这些头）。
 *
 * ## 用法
 *
 * ```bash
 * npx tsx poc/probe/pcdn-diag/mcdn-attribution.mjs          # 用 pgc-pcdn.json 的现场候选
 * npx tsx poc/probe/pcdn-diag/mcdn-attribution.mjs --dry    # 只列出会打哪些 URL
 * ```
 *
 * 产出：`mcdn-attribution.json`（gitignored；**不存签名 URL**，只存 host + path 形态）
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IN = path.join(HERE, 'pgc-pcdn.json');
const OUT = path.join(HERE, 'mcdn-attribution.json');

/** 生产代码实际用的那两个 host（与 `DEFAULT_REWRITE_RULES` 一致） */
const MIRROR_HOST = 'upos-sz-mirrorhw.bilivideo.com';
const PROXY_HOST = 'proxy-tf-all-ws.bilivideo.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/** 每条 PCDN 主体打几个请求由这里定（3 形态 × N 主体 + 1 基线，规模可控） */
const SUBJECT_LIMIT = Number(process.env.PL_SUBJECTS ?? 2);
const DRY = process.argv.includes('--dry');
/** 每个请求之间的间隔：B站 对媒体请求有速率风控，别打太密 */
const GAP_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只换 authority；pathname / search / hash 一字不动（与 ADR 0039 边界 1 逐字一致） */
function swapAuthority(rawUrl, mirrorHost) {
  const u = new URL(rawUrl);
  u.protocol = 'https:';
  u.hostname = mirrorHost;
  u.port = '';
  return u.toString();
}

/** proxy 包装（ADR 0039 边界 7 的唯一例外形状） */
function wrapProxy(rawUrl) {
  return `https://${PROXY_HOST}/?url=${encodeURIComponent(rawUrl)}`;
}

/** path 形态：只留前三段，报告里用它描述（不回传签名路径） */
function pathShape(pathname) {
  const segs = String(pathname || '').split('/').filter(Boolean);
  return `/${segs.slice(0, 3).join('/')}${segs.length > 3 ? '/…' : ''}`;
}

/**
 * 只保留「能暴露源站身份」的响应头。
 *
 * 这套键的选法：`Server` / `Via` / `X-Cache*` / `X-Served-By` 是 CDN 家族指纹；
 * `Content-Range` / `Content-Length` 用来对账「是不是同一段」；
 * `X-Bili-*` 是 B站 自己的边缘标记（有就记）。
 */
const HEADER_KEYS = [
  'server', 'via', 'x-cache', 'x-cache-lookup', 'x-cache-status', 'x-served-by',
  'x-cdn-provider', 'x-upsig', 'cache-control', 'age', 'content-type',
  'content-length', 'content-range', 'accept-ranges', 'x-check', 'x-note',
  'x-bili-trace-id', 'x-bili-rip', 'x-bili-ec', 'x-bili-via', 'x-bili-origin',
  'x-origin-server', 'x-proxy-by', 'x-real-host', 'x-upstream-host',
];

function digestHeaders(headers) {
  const out = {};
  for (const k of HEADER_KEYS) {
    const v = headers[k];
    if (v !== undefined) out[k] = String(v).slice(0, 140);
  }
  return out;
}

/**
 * 发一次 `Range: bytes=0-1023` 请求，记状态码 / TTFB / 全量头 / 首块指纹。
 *
 * @param rawUrl 目标 URL
 * @param referer Referer
 */
async function probe(rawUrl, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const t0 = performance.now();
  try {
    const resp = await fetch(rawUrl, {
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Origin: 'https://www.bilibili.com',
        Range: 'bytes=0-1023',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      },
    });
    const ttfbMs = Math.round(performance.now() - t0);
    const digest = digestHeaders(resp.headers);
    let bytes = 0;
    let md5 = null;
    let hex16 = null;
    try {
      const buf = Buffer.from(await resp.arrayBuffer());
      bytes = buf.length;
      md5 = createHash('md5').update(buf).digest('hex');
      hex16 = buf.subarray(0, 16).toString('hex');
    } catch (e) {
      md5 = 'read-failed:' + String(e && e.message).slice(0, 40);
    }
    return {
      status: resp.status,
      ttfbMs,
      totalMs: Math.round(performance.now() - t0),
      bytes,
      md5,
      hex16,
      resolvedHost: (() => {
        try {
          return new URL(resp.url).hostname;
        } catch {
          return null;
        }
      })(),
      headers: digest,
    };
  } catch (e) {
    const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
    return {
      status: null,
      error:
        (e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e).slice(0, 120)) +
        (code ? ':' + code : ''),
      ttfbMs: null,
      totalMs: Math.round(performance.now() - t0),
      bytes: 0,
      md5: null,
      headers: {},
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 摊平一集 playurl 摘要里的全部候选（flac 是对象、dolby.audio 是数组，形状不同）。
 *
 * 优先 `rawCandidates`（探针 2026-11-18 后期补的字段，含 flac/dolby）；
 * 老结构的 `ssr` 只有 video/audio，作为回退。
 */
function flattenEpisode(ep) {
  const groups = [];
  const rc = ep.rawCandidates;
  if (rc) {
    for (const t of rc.video || []) groups.push({ from: 'raw', kind: 'video', id: t.id, h: t.h, cands: t.cands || [] });
    for (const t of rc.audio || []) groups.push({ from: 'raw', kind: 'audio', id: t.id, cands: t.cands || [] });
    if (Array.isArray(rc.flac)) groups.push({ from: 'raw', kind: 'flac', id: 0, cands: rc.flac });
    if (Array.isArray(rc.dolby)) {
      rc.dolby.forEach((d, i) => groups.push({ from: 'raw', kind: 'dolby' + i, id: i, cands: d || [] }));
    }
    return groups;
  }
  const ssr = ep.ssr || {};
  for (const t of ssr.video || []) groups.push({ from: 'ssr', kind: 'video', id: t.id, h: t.h, cands: t.cands || [] });
  for (const t of ssr.audio || []) groups.push({ from: 'ssr', kind: 'audio', id: t.id, cands: t.cands || [] });
  return groups;
}

/**
 * 从 `pgc-pcdn.json` 抽 PCDN 主体 + 一条干净基线。
 *
 * ⚠️ **候选里必须有完整 URL**：`pgc-pcdn.json` 的 `pack()` 把 `host/os/path/search`
 * 分开存了，但没存原始 `url` —— 签名在 query 里，必须拼回来。
 * 这里按 `pathname + search` 还原：`https://<host><path><search>`。
 */
function collect() {
  const data = JSON.parse(readFileSync(IN, 'utf8'));
  const pcdn = [];
  const official = [];
  const seen = new Set();
  for (const ep of data.episodes || []) {
    if (ep.err) continue;
    for (const g of flattenEpisode(ep)) {
      for (const c of g.cands) {
        const url = `https://${c.host}${c.path}${c.search || ''}`;
        const dedupe = c.host + '|' + c.path;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const cls = classifyCdn(c.host, c.search || '');
        const row = {
          ep: ep.ep, from: g.from, kind: g.kind, trackId: g.id,
          host: c.host, os: c.os || '', pathname: c.path, pathShape: pathShape(c.path),
          url, cls: cls.cls, flavor: cls.flavor,
        };
        if (cls.cls === 'pcdn') pcdn.push(row);
        else if (cls.cls === 'official' && c.os !== 'mcdn') official.push(row);
      }
    }
  }
  return { pcdn, official, episodes: data.episodes || [] };
}

/** 一条横比：两个形态之间哪些头不同（Q-B / Q-D 的判据都用它） */
function diffHeaders(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const rows = [];
  for (const k of keys) {
    const va = a[k] === undefined ? null : a[k];
    const vb = b[k] === undefined ? null : b[k];
    if (va !== vb) rows.push({ header: k, a: va, b: vb });
  }
  return rows;
}

async function main() {
  if (!existsSync(IN)) throw new Error(`缺 ${IN} —— 先跑 pgc-pcdn.mjs`);
  const { pcdn, official, episodes } = collect();
  const referer = `https://www.bilibili.com/bangumi/play/ep${(episodes[0] && episodes[0].ep) || ''}`;

  process.stdout.write(`现场候选：PCDN ${pcdn.length} 条 / 干净官方 ${official.length} 条\n`);
  for (const c of pcdn.slice(0, 10)) {
    process.stdout.write(`  [pcdn] ep${c.ep} ${c.from}/${c.kind}#${c.trackId} ${c.host} os=${c.os || '(none)'} ${c.pathShape}\n`);
  }
  for (const c of official.slice(0, 5)) {
    process.stdout.write(`  [official] ep${c.ep} ${c.from}/${c.kind}#${c.trackId} ${c.host} os=${c.os || '(none)'} ${c.pathShape}\n`);
  }

  if (pcdn.length === 0) {
    const out = {
      at: new Date().toISOString(), ok: false,
      note: '本轮 PGC 候选里没有一条 cls=pcdn，构造不出形态 1 —— Q-A~Q-D 测不出来',
      subjects: [], baseline: null, rows: [],
    };
    writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    process.stdout.write('⚠️ 无 PCDN 候选，Q-A~Q-D 无法执行（照实报告）\n');
    return;
  }

  const subjects = pcdn.slice(0, SUBJECT_LIMIT);
  const baseline = official[0] || null;

  const rows = [];
  for (const sub of subjects) {
    process.stdout.write(`\n── 形态对照：${sub.host} os=${sub.os || '(none)'} ${sub.pathShape} ──\n`);
    const variants = [
      { v: 1, name: '原样(mcdn)', url: sub.url, targetHost: new URL(sub.url).hostname },
      { v: 2, name: '换官方镜像+保留query', url: swapAuthority(sub.url, MIRROR_HOST), targetHost: MIRROR_HOST },
      { v: 3, name: 'proxy包装', url: wrapProxy(sub.url), targetHost: PROXY_HOST },
    ];
    if (DRY) {
      for (const it of variants) process.stdout.write(`  [dry] ${it.name} → ${it.targetHost}\n`);
      continue;
    }
    const got = {};
    for (const it of variants) {
      const r = await probe(it.url, referer);
      got[it.v] = r;
      rows.push({
        group: sub.host + ' ' + sub.pathShape, variant: it.v, name: it.name,
        targetHost: it.targetHost, ...stripUrl(r),
      });
      report(it.v, it.name, r);
      await sleep(GAP_MS);
    }
    // Q-A 直接判、Q-C 直接判
    rows.push({
      group: sub.host + ' ' + sub.pathShape, variant: 'summary',
      originalStatus: got[1].status, mirrorStatus: got[2].status, proxyStatus: got[3].status,
      originalMd5: got[1].md5, mirrorMd5: got[2].md5, proxyMd5: got[3].md5,
      mirrorSameBytes: !!(got[2].md5 && got[1].md5 && got[2].md5 === got[1].md5),
      proxySameBytes: !!(got[3].md5 && got[1].md5 && got[3].md5 === got[1].md5),
      mirrorVsOriginalHeaders: diffHeaders(got[1].headers, got[2].headers),
      proxyVsMirrorHeaders: diffHeaders(got[2].headers, got[3].headers),
    });
  }

  if (baseline && !DRY) {
    process.stdout.write(`\n── 真官方基线：${baseline.host} os=${baseline.os || '(none)'} ${baseline.pathShape} ──\n`);
    const b = await probe(baseline.url, referer);
    rows.push({
      group: 'baseline', variant: 4, name: '干净官方候选',
      targetHost: new URL(baseline.url).hostname, ...stripUrl(b),
    });
    report(4, '基线', b);
    // 与每个主体比：形态 2 更像形态 1 还是更像基线
    for (const sub of subjects) {
      const g = sub.host + ' ' + sub.pathShape;
      const m = rows.find((r) => r.group === g && r.variant === 2);
      const o = rows.find((r) => r.group === g && r.variant === 1);
      if (!m || !o) continue;
      rows.push({
        group: g, variant: 'vsBaseline',
        mirrorVsBaselineHeaders: diffHeaders(b.headers, m.headers),
        originalVsBaselineHeaders: diffHeaders(b.headers, o.headers),
      });
    }
  } else if (DRY && baseline) {
    process.stdout.write(`  [dry] baseline → ${new URL(baseline.url).hostname}\n`);
  }

  const out = {
    at: new Date().toISOString(), ok: true,
    mirrorHost: MIRROR_HOST, proxyHost: PROXY_HOST,
    subjects: subjects.map((s) => ({
      ep: s.ep, from: s.from, kind: s.kind, trackId: s.trackId,
      host: s.host, os: s.os, pathShape: s.pathShape,
    })),
    baseline: baseline
      ? { ep: baseline.ep, host: baseline.host, os: baseline.os, pathShape: baseline.pathShape }
      : null,
    rows,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  process.stdout.write(`\n已写出 ${OUT}\n`);
}

/** 从 probe() 结果里去掉 URL 原文（只留 host + 指纹） */
function stripUrl(r) {
  return {
    status: r.status, error: r.error || null,
    ttfbMs: r.ttfbMs, totalMs: r.totalMs,
    bytes: r.bytes, md5: r.md5, hex16: r.hex16,
    resolvedHost: r.resolvedHost || null,
    headers: r.headers,
  };
}

/** stdout 一行摘要 + 关键头 */
function report(variant, name, r) {
  const status = r.status === null ? r.error : r.status;
  process.stdout.write(
    `  [${variant}] ${name}: status=${status} ttfb=${r.ttfbMs}ms bytes=${r.bytes}` +
      ` md5=${r.md5 ? String(r.md5).slice(0, 10) + '…' : '-'}` +
      `${r.resolvedHost ? ' →' + r.resolvedHost : ''}\n`,
  );
  const show = ['server', 'via', 'x-cache', 'x-cache-lookup', 'content-length',
    'content-range', 'content-type', 'x-cdn-provider', 'x-bili-via'];
  const line = show.filter((k) => r.headers[k] !== undefined)
    .map((k) => `${k}=${r.headers[k]}`).join(' | ');
  if (line) process.stdout.write(`      ${line}\n`);
}

main().catch((e) => {
  process.stdout.write(`失败：${(e && e.message) || e}\n`);
  process.exitCode = 1;
});