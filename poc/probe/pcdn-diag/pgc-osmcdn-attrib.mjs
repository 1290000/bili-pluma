/**
 * `os=mcdn` 改写后的实际归属 —— Q-A ~ Q-D（2026-11-18）。
 *
 * ## 要证的那条自相矛盾
 *
 * `src/core/cdn/classify.ts` 第 5 条判据：「query 里整段 `os=mcdn` → `cls='pcdn'」。
 * 而 `rewriteCandidateUrl()` / `rewriteOne()` 按 ADR 0039「只改 authority，
 * path/search/hash 一字不动」—— **它换掉了 host，却把 `os=mcdn` 原样留在 query 里**。
 *
 * 于是改写成功后，我们自己的分类器仍然把这条请求判成 PCDN：
 *
 * ```
 * before: mountaintoys + os=mcdn            → classify = pcdn
 * after : upos-sz-mirrorhw + 同一串 os=mcdn → classify = pcdn   ← 仍然是 pcdn
 * ```
 *
 * 用户看到「开关开着、时间轴还有 P2P」，完全合理。这不是"没屏蔽"，
 * 是**判据与改写互相矛盾**。
 *
 * ## 但那只是"分类器怎么说"，不是"流量实际去哪"
 *
 * 真正决定 ADR 0039 是否成立的，是**换 host 之后源站到底是谁**。所以本探针取一份
 * 新鲜的 PCDN 候选（带签名，会过期，必须现场取），构造四种 URL 各发一次
 * `Range: bytes=0-1023`，逐条比对：
 *
 * | # | 形态 | 说明 |
 * | --- | --- | --- |
 * | 1 | 原样 | `*.edge.mountaintoys.cn` / `*.mcdn.bilivideo.cn` + `os=mcdn` |
 * | 2 | 换 host 到官方镜像，query 完全不动 | **生产代码当前真正产出的形态** |
 * | 3 | proxy 包装 | `https://proxy-tf-all-ws.bilivideo.com?url=<enc>`（ADR 0039 边界 7） |
 * | 4 | 基线：本来就干净的官方候选 | `os=bcache` / `os=estgoss`，无 `os=mcdn` |
 *
 * 每条记：状态码、全部响应头、TTFB、**首块前 16 字节 hex + sha1**
 * （用于判"是不是同一份资源"）。
 *
 * ## 请求来源
 *
 * 先照 `verify-rewrite-4k.mjs` 的做法 **Node 直连**（带 UA / Referer / Origin）。
 * 直连失败（DNS / TLS / 被墙）时不重试同一形态，改为**在 B站 页面内 fetch**
 * 并 `postMessage` 出来 —— 那条路会自动带 Referer，且 `credentials:'omit'`。
 * 报告里注明走的是哪条路。
 *
 * 用法：
 *   npx tsx poc/probe/pcdn-diag/pgc-osmcdn-attrib.mjs            # 取候选 + 四种形态各打一次
 *   npx tsx poc/probe/pcdn-diag/pgc-osmcdn-attrib.mjs --reuse    # 复用已有 candidates.json（签名可能已过期）
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAND_FILE = path.join(HERE, 'mcdn-candidates.json');
const OUT = path.join(HERE, 'mcdn-attribution.json');

/** 凡人修仙传 ep200（最新正片）。够用一集，Q-A~Q-D 不需要多集 */
const EP = process.env.PL_EP || '3854824';
const REUSE = process.argv.includes('--reuse');

/** 与 `DEFAULT_REWRITE_RULES` 一致（`core/cdn/filter.ts`） */
const MIRROR = 'upos-sz-mirrorhw.bilivideo.com';
const PROXY = 'proxy-tf-all-ws.bilivideo.com';
const PROXY_PREFIX = '/v1/resource/upgcxcode/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const ENV = { ...process.env, BSK_AUTO_START: '0' };
const TIMEOUT_MS = 15000;

// ───────────────────────── bsk ─────────────────────────

function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`bsk ${args[0]} 失败：${(e.stderr || e.stdout || e.message).slice(0, 300)}`);
  }
  if (!json) return out.trim();
  return JSON.parse(out.slice(out.indexOf('{')));
}

const sleep = (ms) => bsk(['wait-ms', String(ms)]);

let cached = null;

function current() {
  if (cached) return cached;
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      const s = bsk(['sync', '--json'], { json: true });
      cached = { session: s.session_id, tab: s.tab_id, ctx: s.ctx };
      return cached;
    } catch (e) {
      last = e;
      sleep(1200);
    }
  }
  throw last;
}

function ev(expression) {
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      const cur = current();
      const out = bsk([
        'evaluate', '--session', cur.session, '--tab-id', String(cur.tab), '--context', cur.ctx,
        '--expect', '[{"target":"body","field":"exists","equals":true}]', expression,
      ]);
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        const idx = Math.min(
          ...['{', '['].map((c) => {
            const k = out.indexOf(c);
            return k === -1 ? Number.MAX_SAFE_INTEGER : k;
          }),
        );
        parsed = JSON.parse(out.slice(idx));
      }
      return parsed && parsed.value !== undefined ? parsed.value : parsed;
    } catch (e) {
      last = e;
      cached = null;
      sleep(1500);
    }
  }
  throw last;
}

function openPage(url) {
  let cur;
  try {
    cur = current();
  } catch {
    bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '60']);
    cached = null;
    cur = current();
  }
  const created = bsk(
    [
      'tab', 'create', '--url', url, '--session', cur.session, '--context', cur.ctx,
      '--expect', '[{"target":"body","field":"exists","equals":true}]', '--json',
    ],
    { json: true },
  );
  cached = null;
  const s = bsk(['sync', '--json'], { json: true });
  cached = { session: s.session_id, tab: Number(created.tab_id), ctx: s.ctx };
  return cached;
}

// ───────────────────── 取新鲜候选 ─────────────────────

/**
 * 在番剧页内取 PGC playurl 原文，抽出**带签名的完整 URL**：
 *
 * - 2 条 PCDN（`cls === 'pcdn'`，`os=mcdn`）—— 优先 mountaintoys（不走 proxy 前缀），
 *   与 1 条 `mcdn.bilivideo.cn`（走 proxy 前缀，若存在）；
 * - 1 条**干净**官方候选（`os !== 'mcdn'`）作基线。
 *
 * 只回传完整 URL（含签名）。落盘文件在 `.gitignore` 里，报告不写完整 URL。
 */
function exprCollect(ep) {
  return `(async () => {
    const p = window.__playinfo__;
    const inner = p && p.result ? p : (p && p.data && p.data.result ? p.data : null);
    const r = inner && inner.result ? inner.result : null;
    const cid = r && r.arc && r.arc.cid;
    if (!cid) return { err: 'no cid' };
    const u = 'https://api.bilibili.com/pgc/player/web/playurl?cid=' + cid +
      '&avid=0&qn=80&fnval=4048&fnver=0&fourk=1';
    const j = await fetch(u, { credentials: 'include' }).then((x) => x.json());
    const res = j && (j.result || (j.data && j.data.result));
    if (!res || !res.dash) return { err: 'no dash', code: j && j.code };
    const track = (s) =>
      [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean);
    const all = [];
    for (const s of (res.dash.video || [])) for (const x of track(s)) all.push({ url: x, h: s.height, codecid: s.codecid, kind: 'video' });
    for (const s of (res.dash.audio || [])) for (const x of track(s)) all.push({ url: x, h: 0, codecid: s.codecid, kind: 'audio' });
    return { cid: cid, ep: ${JSON.stringify(ep)}, all: all };
  })()`;
}

// ───────────────────── 四种形态 ─────────────────────

/** 只换 authority：protocol / host / port；pathname / search / hash 一字不动 */
function swapAuthority(rawUrl, host) {
  const u = new URL(rawUrl);
  u.protocol = 'https:';
  u.hostname = host;
  u.port = '';
  return u.toString();
}

function wrapProxy(rawUrl) {
  return `https://${PROXY}/?url=${encodeURIComponent(rawUrl)}`;
}

/** host 里有没有 `mcdn` 这个独立标签（与 classify.ts 一致） */
function isMcdnLabel(host) {
  return host.toLowerCase().split('.').includes('mcdn');
}

/** path 形态：只留前 3 段，不回传完整签名路径 */
function pathShape(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  return `/${segs.slice(0, 3).join('/')}${segs.length > 3 ? '/…' : ''}`;
}

/**
 * 发一次 Range 请求，记状态码 / 全部响应头 / TTFB / 首块字节指纹。
 *
 * 只取 `bytes=0-1023`，拿到 1024 字节后**立刻 cancel**，不整段下载。
 */
async function probeOnce(url, label) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  const rec = {
    label,
    targetHost: (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return 'bad';
      }
    })(),
    status: null,
    httpStatus: null,
    ttfbMs: null,
    headers: null,
    firstBytesLen: null,
    first16Hex: null,
    sha1_1k: null,
    totalBytesSeen: null,
    error: null,
  };
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/bangumi/play/ep' + (process.env.PL_EP || '3854824'),
        Origin: 'https://www.bilibili.com',
        Range: 'bytes=0-1023',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      },
      signal: ac.signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    rec.ttfbMs = Math.round(performance.now() - t0);
    rec.httpStatus = res.status;
    rec.status = String(res.status);
    const h = {};
    res.headers.forEach((v, k) => {
      h[k.toLowerCase()] = String(v).slice(0, 200);
    });
    rec.headers = h;
    let buf = null;
    try {
      buf = await res.arrayBuffer();
    } catch {
      buf = null;
    }
    if (buf) {
      const bytes = new Uint8Array(buf);
      rec.totalBytesSeen = bytes.length;
      const head = bytes.slice(0, Math.min(1024, bytes.length));
      rec.firstBytesLen = head.length;
      rec.first16Hex = Array.from(head.slice(0, 16))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      rec.sha1_1k = createHash('sha1').update(head).digest('hex').slice(0, 16);
    }
  } catch (e) {
    const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
    rec.error = `${e && e.name === 'AbortError' ? '超时' : '失败'}${code ? ':' + code : ''}`;
    rec.status = rec.error;
  } finally {
    clearTimeout(timer);
  }
  return rec;
}

/** 小睡，控制请求节奏（ADR 0039 边界 8：串行 + 间隔） */
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * **页面内**跑同一条探针（Node 直连失败时的兜底）。
 *
 * ## 为什么必须有这条兜底
 *
 * PCDN 节点（`*.edge.mountaintoys.cn`）在公共 DNS 上常常**解析不了** ——
 * 实测 Node 侧 `fetch` 直接 `ENOENT`（DNS 失败），而浏览器能拿到，因为它走的是
 * 运营商 LocalDNS / 已缓存的解析结果。所以"形态 1 打不通"**不是结论**，
 * 只是"Node 这边解析不了"；必须换成浏览器发，否则 Q-B / Q-C 全部测不出来。
 *
 * 页面内还有两个额外好处：
 * - `Referer` 由浏览器自动带（B站 域），不必手填；
 * - 与生产路径同源（播放器的分片请求也是浏览器发的）。
 *
 * `credentials: 'omit'` —— 这一条是**刻意**的：这四种形态都不需要身份，
 * 带上 Cookie 只会让"403 是不是 Cookie 造成"变成一个解释不清的变量。
 *
 * SHA-1 用 `crypto.subtle.digest`（https 页面才有，B站 是 https，满足）。
 *
 * @param plan `[{label, url}]`
 */
function exprProbeInPage(plan) {
  return `(async () => {
    const plan = ${JSON.stringify(plan)};
    const hex = (buf, n) => Array.from(new Uint8Array(buf).slice(0, n))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const sha1 = async (buf) => {
      const d = await crypto.subtle.digest('SHA-1', buf);
      return hex(d, 8);
    };
    const out = [];
    for (const step of plan) {
      const t0 = performance.now();
      const rec = { label: step.label, inPage: true, targetHost: '', status: null,
        httpStatus: null, ttfbMs: null, headers: null, firstBytesLen: null,
        first16Hex: null, sha1_1k: null, totalBytesSeen: null, error: null };
      try { rec.targetHost = new URL(step.url).hostname; } catch (e) { rec.targetHost = 'bad'; }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      try {
        const res = await fetch(step.url, {
          headers: { Range: 'bytes=0-1023', Accept: '*/*' },
          credentials: 'omit',
          signal: ac.signal,
          cache: 'no-store',
        });
        rec.ttfbMs = Math.round(performance.now() - t0);
        rec.httpStatus = res.status;
        rec.status = String(res.status);
        const h = {};
        res.headers.forEach((v, k) => { h[k.toLowerCase()] = String(v).slice(0, 200); });
        rec.headers = h;
        let buf = null;
        try { buf = await res.arrayBuffer(); } catch (e) { buf = null; }
        if (buf) {
          rec.totalBytesSeen = buf.byteLength;
          const headLen = Math.min(1024, buf.byteLength);
          const head = buf.slice(0, headLen);
          rec.firstBytesLen = headLen;
          rec.first16Hex = hex(head, 16);
          rec.sha1_1k = await sha1(head);
        }
      } catch (e) {
        rec.error = (e && e.name === 'AbortError') ? '超时' : ('失败:' + String(e && e.message).slice(0, 60));
        rec.status = rec.error;
      } finally {
        clearTimeout(timer);
      }
      out.push(rec);
      await new Promise((r) => setTimeout(r, 200));
    }
    return out;
  })()`;
}

/** Node 侧是不是 DNS 层就挂了（这类失败**不算结论**，必须换浏览器重打） */
function isDnsFailure(rec) {
  return typeof rec.error === 'string' && /ENOTFOUND|ENOENT|EAI_AGAIN|ENODATA|ENOSERVER|DNS/i.test(rec.error);
}

// ───────────────────── 主流程 ─────────────────────

async function main() {
  const result = { at: new Date().toISOString(), ep: EP, source: null, picks: [], probes: [], notes: [] };

  let cands = null;
  if (REUSE && existsSync(CAND_FILE)) {
    cands = JSON.parse(readFileSync(CAND_FILE, 'utf8'));
    result.source = 'reuse';
    result.notes.push('复用已有 candidates.json —— 签名可能已过期，403 就重跑不加 --reuse');
  } else {
    process.stdout.write(`打开 ep${EP} 取新鲜候选 …\n`);
    openPage(`https://www.bilibili.com/bangumi/play/ep${EP}`);
    sleep(4000);
    cands = ev(exprCollect(EP));
    result.source = 'fresh';
    if (cands && cands.all) writeFileSync(CAND_FILE, JSON.stringify(cands, null, 2), 'utf8');
  }
  if (!cands || !cands.all) {
    process.stdout.write(`取候选失败：${JSON.stringify(cands).slice(0, 200)}\n`);
    writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    return;
  }

  // 分类 + 挑选
  const enriched = cands.all.map((c) => {
    let u = null;
    try {
      u = new URL(c.url);
    } catch {
      return null;
    }
    const cls = classifyCdn(u.hostname, u.search).cls;
    return {
      ...c,
      host: u.hostname,
      os: u.searchParams.get('os') || '',
      path: u.pathname,
      search: u.search,
      cls,
      isMcdnLabel: isMcdnLabel(u.hostname),
      hitsProxyPrefix: u.pathname.includes(PROXY_PREFIX),
    };
  }).filter(Boolean);

  const pcdn = enriched.filter((c) => c.cls === 'pcdn');
  const clean = enriched.filter((c) => c.cls === 'official' && c.os !== 'mcdn');
  process.stdout.write(
    `候选 ${enriched.length} 条 · PCDN ${pcdn.length} · 干净官方 ${clean.length}\n`,
  );

  /** PCDN 里挑：优先"不走 proxy 前缀"的（走 proxy 前缀的形态 2 本来就不会用到） */
  const pcdPlain = pcdn.filter((c) => !c.hitsProxyPrefix);
  const pcdProxy = pcdn.filter((c) => c.hitsProxyPrefix);
  const pick = pcdPlain[0] || pcdn[0] || null;
  const pickProxy = pcdProxy[0] || null;
  /**
   * 基线：挑一条**与 pick 同 path 尾段**的干净官方候选 —— 同一段媒体，
   * 才能把"响应头差异"归因到线路而不是内容。
   */
  const pickTail = pick ? pick.path.split('/').pop() : null;
  const base = clean.find((c) => c.path.split('/').pop() === pickTail) || clean[0] || null;

  if (!pick) {
    process.stdout.write('没有 PCDN 候选，无法做 Q-A~Q-D\n');
    writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    return;
  }

  const describe = (c) =>
    c
      ? {
          host: c.host,
          os: c.os,
          pathShape: pathShape(c.path),
          pathTail: c.path.split('/').pop(),
          cls: c.cls,
          size: c.kind,
          height: c.h,
          isMcdnLabel: c.isMcdnLabel,
          hitsProxyPrefix: c.hitsProxyPrefix,
        }
      : null;

  result.picks = { main: describe(pick), proxy: describe(pickProxy), baseline: describe(base) };
  process.stdout.write(
    `主候选：${pick.host} os=${pick.os} path=${pathShape(pick.path)} tail=${pick.path.split('/').pop()}\n`,
  );
  if (base) {
    process.stdout.write(
      `基线：  ${base.host} os=${base.os} 同尾段=${base.path.split('/').pop() === pickTail}\n`,
    );
  }

  // ── 四种形态 ──
  const plan = [
    { label: '1-original-pcdn', url: pick.url, who: 'pick' },
    { label: '2-mirror-same-query', url: swapAuthority(pick.url, MIRROR), who: 'pick' },
    { label: '3-proxy-wrapped', url: wrapProxy(pick.url), who: 'pick' },
  ];
  if (pickProxy) {
    plan.push({ label: '2b-mirror-same-query(mcdn-label)', url: swapAuthority(pickProxy.url, MIRROR), who: 'pickProxy' });
    plan.push({ label: '3b-proxy-wrapped(mcdn-label)', url: wrapProxy(pickProxy.url), who: 'pickProxy' });
  }
  if (base) plan.push({ label: '4-baseline-clean-official', url: base.url, who: 'base' });

  /**
   * 附加两条**交叉验证**（不是主理人要的四形态，但能把 Q-B 的几个解释排掉）：
   *
   * - `4b-baseline-other-mirror`：同 path 换到**另一个**官方镜像。
   *   它回答"官方镜像之间的头本来就各不相同吗" —— 若各不相同，
   *   那"形态 2 的头与基线不同"就**不能**当作"形态 2 不是官方"的证据。
   * - `2c-mirror-os-stripped`：镜像 host + path 不变，**只把 `os=mcdn` 去掉**。
   *   它回答"`os=mcdn` 这个参数到底有没有在起作用"：内容若与形态 2 相同，
   *   说明镜像根本不看它（那 `classify` 把 `os=mcdn` 当 PCDN 判据在生产形态下就失了准）；
   *   若不同，说明 `os=mcdn` 确实会路由到 mcdn 源。
   */
  if (base && pick) {
    const otherMirror = 'upos-sz-mirrorcos.bilivideo.com';
    plan.push({
      label: '4b-baseline-other-mirror',
      url: swapAuthority(pick.url, otherMirror),
      who: 'pick',
    });
    const stripped = (() => {
      const u = new URL(swapAuthority(pick.url, MIRROR));
      const kept = u.search
        .replace(/^\?/, '')
        .split('&')
        .filter((seg) => seg.trim() !== 'os=mcdn' && seg.trim() !== '');
      u.search = kept.length ? `?${kept.join('&')}` : '';
      return u.toString();
    })();
    plan.push({ label: '2c-mirror-os-stripped', url: stripped, who: 'pick' });
  }

  for (const step of plan) {
    process.stdout.write(`  → ${step.label} @ ${(() => { try { return new URL(step.url).hostname; } catch { return 'bad'; } })()} … `);
    const rec = await probeOnce(step.url, step.label);
    rec.who = step.who;
    rec.via = 'node';
    result.probes.push(rec);
    process.stdout.write(
      `${rec.status} ttfb=${rec.ttfbMs ?? '-'}ms bytes=${rec.totalBytesSeen ?? '-'} sha1=${rec.sha1_1k || '-'}\n`,
    );
    await nap(200);
  }

  /**
   * ── Node 直连失败的形态改用**浏览器发** ──
   *
   * ⚠️ `ENOENT` / `ENOTFOUND` 是 **Node 侧 DNS 解析不了**，不是"这条 URL 不可用"。
   * PCDN 边缘节点在公共 DNS 上常年无解析，而浏览器（走运营商 LocalDNS）能拿到。
   * 若不换浏览器重打，「形态 1 打不通」就会被误读成"原 PCDN 已经死了" —— 那是错的。
   */
  const failed = result.probes.filter((p) => isDnsFailure(p) || p.error);
  if (failed.length > 0) {
    const retryPlan = failed
      .map((p) => {
        const step = plan.find((s) => s.label === p.label);
        return step ? { label: `${step.label}@inpage`, url: step.url } : null;
      })
      .filter(Boolean);
    if (retryPlan.length > 0) {
      process.stdout.write(`\n  Node 侧失败 ${failed.length} 条（DNS），改用页面内 fetch 重打 …\n`);
      try {
        const inPage = ev(exprProbeInPage(retryPlan));
        for (const rec of inPage || []) {
          const baseLabel = rec.label.replace(/@inpage$/, '');
          const original = result.probes.find((p) => p.label === baseLabel);
          result.probes.push({
            ...rec,
            label: rec.label,
            who: original ? original.who : null,
            via: 'inpage',
            nodeFailure: original ? original.status : null,
          });
          process.stdout.write(
            `  → ${rec.label} … ${rec.status} ttfb=${rec.ttfbMs ?? '-'}ms ` +
              `bytes=${rec.totalBytesSeen ?? '-'} sha1=${rec.sha1_1k || '-'}\n`,
          );
        }
      } catch (e) {
        process.stdout.write(`  页面内重打也失败：${String(e.message).slice(0, 160)}\n`);
        result.notes.push('页面内重打失败：' + String(e.message).slice(0, 160));
      }
    }
  }

  // ── 判定 ──
  /**
   * 取某形态的**可用记录**：优先 `inpage`（Node DNS 失败后重打的那份），
   * 其次 `node` 里成功的那份。同一形态可能两条都在 `probes` 里。
   */
  const by = (label) => {
    const all = result.probes.filter(
      (p) => p.label === label || p.label === `${label}@inpage`,
    );
    const ok = all.find((p) => p.httpStatus !== null && !p.error);
    return ok || all[all.length - 1] || null;
  };
  const p1 = by('1-original-pcdn');
  const p2 = by('2-mirror-same-query');
  const p3 = by('3-proxy-wrapped');
  const p4 = by('4-baseline-clean-official');

  const mk = (p) => (p && p.headers ? p.headers['server'] || '' : '');
  const via = (p) => (p && p.headers ? p.headers['via'] || '' : '');
  const xc = (p) => (p && p.headers ? p.headers['x-cache'] || '' : '');
  const xcl = (p) => (p && p.headers ? p.headers['x-cache-lookup'] || '' : '');

  /**
   * `Via` 头是**最硬**的归属信号：B站 的边缘会在 `Via` 里写自己那一段 POP 链路名
   * （`CHN-YNkunming-SSPcctv2-CACHE1` 这种）。PCDN 的边缘与官方镜像是两套 POP。
   * 只取第一段，避免同一条 L2/L3 路径上多跳顺序差异把结论搅乱。
   */
  const viaHop = (p) => {
    const v = via(p);
    return v ? v.split(',')[0].trim() : '';
  };

  const cmp = (a, b) => {
    const fields = [];
    if (mk(a) !== mk(b)) fields.push(`server(${mk(a) || '空'}|${mk(b) || '空'})`);
    if (viaHop(a) !== viaHop(b)) fields.push(`via[0](${viaHop(a) || '空'}|${viaHop(b) || '空'})`);
    if (xc(a) !== xc(b)) fields.push(`x-cache(${xc(a) || '空'}|${xc(b) || '空'})`);
    if (xcl(a) !== xcl(b)) fields.push(`x-cache-lookup(${xcl(a) || '空'}|${xcl(b) || '空'})`);
    return fields;
  };

  const verdicts = {
    QA: (() => {
      if (!p2) return '未测（没生成形态 2）';
      if (p2.httpStatus === 206) return '是，返回 206（Range 请求被正常满足）';
      if (p2.httpStatus === 200) return '是，返回 200（忽略 Range 但拿到了内容）';
      if (p2.httpStatus === 403) return '否，返回 403 —— 签名跨 host 不认，改写本身是坏的';
      return `否，返回 ${p2.status}`;
    })(),
    QB: (() => {
      if (!p1 || !p2) return '未测（形态 1 或 2 缺）';
      const vsOriginal = cmp(p1, p2);
      const vsBaseline = p4 ? cmp(p4, p2) : null;
      if (!vsBaseline) return '无基线可比';
      if (vsBaseline.length === 0 && vsOriginal.length > 0) {
        return '更像基线（真官方）：形态 2 与基线在 Server/Via/X-Cache 上完全一致，' +
          `与原 PCDN 差 ${vsOriginal.length} 项（${vsOriginal.join(' , ')}）`;
      }
      if (vsOriginal.length === 0 && vsBaseline.length > 0) {
        return '更像形态 1（原 PCDN）：形态 2 与原 PCDN 头完全一致，' +
          `与基线差 ${vsBaseline.length} 项（${vsBaseline.join(' , ')}）—— 换 host 只是换入口，源站仍是 mcdn`;
      }
      if (vsOriginal.length === 0 && vsBaseline.length === 0) {
        return '三者头完全一致，无法用响应头区分归属';
      }
      return `两边都不完全一致：与基线差 ${vsBaseline.length} 项（${vsBaseline.join(' , ')}），` +
        `与原 PCDN 差 ${vsOriginal.length} 项（${vsOriginal.join(' , ')}）`;
    })(),
    QC: (() => {
      const a = p1 && p1.sha1_1k ? p1.sha1_1k : null;
      const b = p2 && p2.sha1_1k ? p2.sha1_1k : null;
      const c = p4 && p4.sha1_1k ? p4.sha1_1k : null;
      if (!a || !b) return '未测（有一侧没拿到首块字节）';
      if (a === b) return `相同（sha1(前 1KB)=${a}）—— 同一份资源${c === a ? '，且与基线也相同' : ''}`;
      return `不同（形态 1=${a} / 形态 2=${b}${c ? ' / 基线=' + c : ''}）—— 拿到的不是同一份字节`;
    })(),
    QD: (() => {
      if (!p3) return '未测';
      if (p3.httpStatus !== 206 && p3.httpStatus !== 200) {
        return `否，proxy 自己就失败（${p3.status}${p3.headers ? ' / ' + (p3.headers['content-type'] || '') : ''}）`;
      }
      if (!p4) return '无基线可比';
      const vsBase = cmp(p4, p3);
      const vsPcdn = p1 ? cmp(p1, p3) : null;
      if (vsBase.length === 0) return '是，proxy 的头与基线完全一致 —— proxy 才是真正脱离 mcdn 的路径';
      if (vsPcdn && vsPcdn.length === 0) return '否，proxy 的头仍与原 PCDN 完全一致';
      return `proxy 头两边都不同：与基线差 ${vsBase.length} 项，与原 PCDN 差 ${vsPcdn ? vsPcdn.length : '?'} 项`;
    })(),
  };
  result.verdicts = verdicts;

  process.stdout.write('\n── Q-A ~ Q-D ──\n');
  for (const [k, v] of Object.entries(verdicts)) process.stdout.write(`${k}: ${v}\n`);

  process.stdout.write('\n── 响应头对照（只列有差异的）──\n');
  const keys = ['server', 'via', 'x-cache', 'x-cache-lookup', 'content-length', 'content-range',
    'content-type', 'accept-ranges', 'age', 'x-tt-content-codec', 'x-bili-trace-id'];
  for (const k of keys) {
    const vals = result.probes.map((p) => `${p.label}=${(p.headers && p.headers[k]) || '-'}`);
    process.stdout.write(`  ${k}: ${vals.join(' | ')}\n`);
  }

  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`\n已写出 ${OUT}\n`);
}

await main();