/**
 * `os=mcdn` 归属实测 · 第二阶段 —— 补齐第一阶段测不到的三件事。
 *
 * 第一阶段（`pgc-osmcdn-attrib.mjs`）已经拿到两条硬结论：
 *
 * - 形态 2（官方镜像 + 原 query 含 `os=mcdn`）**返回 206**，首块 sha1 与基线
 *   （`os=estgoss` / `os=cosbv` 两条真官方）**完全相同**；
 * - 形态 3（proxy 包装）**返回 403**，但那条候选的 path 是 `/upgcxcode/…`，
 *   **不命中** `proxyPathPrefix = '/v1/resource/upgcxcode/'` —— 也就是说
 *   生产代码对这条候选根本不会走 proxy 分支（它走的是"只换 host"）。
 *   所以那 403 只能说明"proxy 不能用于这个 path"，不能说明 proxy 路线本身不行。
 *
 * 本阶段补：
 *
 * 1. **形态 1（原 PCDN host）的真实响应头**。
 *    Node 侧 `dns.lookup` 对该 host 返回 `ENOENT`、`nslookup` 给 `0.0.0.0`
 *    （运营商/本地 DNS 对 PCDN 边缘刻意不给解析）—— 所以 Node 直连必然失败，
 *    必须**在页面内发**。页面内 `fetch` 受 CORS 约束：先试 `cors`，
 *    失败再试 `no-cors` 只判"可达性"（opaque 响应拿不到头，但能证明 host 活着）。
 * 2. **形态 3 用一条真正命中 `/v1/resource/upgcxcode/` 的 PCDN 候选**再打一次。
 *    这才对应生产代码的 proxy 分支。
 * 3. **403 的响应体正文**（`content-type: text/html`，3800+ 字节）。
 *    B站 的 403 页通常会写明是"签名不匹配"还是"资源不存在"，这决定了
 *    「proxy 不可用」还是「proxy 用法不对」。只取前 600 字符并去掉 query。
 *
 * 复用第一阶段落盘的 `mcdn-candidates.json`（几分钟前的签名，仍在有效期内）。
 *
 * 用法：
 *   npx tsx poc/probe/pcdn-diag/pgc-osmcdn-attrib-phase2.mjs
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAND_FILE = path.join(HERE, 'mcdn-candidates.json');
const OUT = path.join(HERE, 'mcdn-attribution-phase2.json');

const EP = process.env.PL_EP || '3854824';
const MIRROR = 'upos-sz-mirrorhw.bilivideo.com';
const PROXY = 'proxy-tf-all-ws.bilivideo.com';
const PROXY_PREFIX = '/v1/resource/upgcxcode/';

const ENV = { ...process.env, BSK_AUTO_START: '0' };

function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, { encoding: 'utf8', env: ENV, maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`bsk ${args[0]} 失败：${(e.stdout || e.stderr || e.message).slice(0, 300)}`);
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
      sleep(1500);
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
        '--timeout', '90s',
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
      sleep(2000);
    }
  }
  throw last;
}

/** path 形态：只留前 3 段（不回传完整签名路径） */
function pathShape(p) {
  const segs = p.split('/').filter(Boolean);
  return `/${segs.slice(0, 3).join('/')}${segs.length > 3 ? '/…' : ''}`;
}

/**
 * 页面内跑一组测试。每种测试都自包含（自己 try/catch），一条失败不影响其它条。
 *
 * ## 为什么要分 cors / no-cors 两趟
 *
 * 页面内 `fetch` 走 CORS：PCDN 边缘常常**不回** `Access-Control-Allow-Origin`，
 * 于是拿到的是 `TypeError: Failed to fetch` —— **请求本身可能已经成功**，
 * 只是浏览器不让脚本读响应。这与"host 死了"是两件事，不能混。
 * 所以先 `cors`（能拿到头就最好），失败后 `no-cors`（能 resolve 即证明可达）。
 */
function exprPhase2(plan) {
  return `(async () => {
    const plan = ${JSON.stringify(plan)};
    const hex = (buf, n) => Array.from(new Uint8Array(buf).slice(0, n))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const sha1 = async (buf) => {
      const d = await crypto.subtle.digest('SHA-1', buf);
      return hex(d, 8);
    };
    const out = [];

    const one = async (step) => {
      const rec = { label: step.label, mode: step.mode || 'cors', targetHost: '',
        status: null, httpStatus: null, ttfbMs: null, headers: null, bodyHead: null,
        firstBytesLen: null, first16Hex: null, sha1_1k: null, totalBytesSeen: null,
        error: null, opaque: false };
      try { rec.targetHost = new URL(step.url).hostname; } catch (e) { rec.targetHost = 'bad'; }
      const t0 = performance.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      try {
        const res = await fetch(step.url, {
          headers: { Range: 'bytes=0-1023', Accept: '*/*' },
          credentials: 'omit',
          mode: rec.mode,
          signal: ac.signal,
          cache: 'no-store',
        });
        rec.ttfbMs = Math.round(performance.now() - t0);
        rec.httpStatus = res.status;
        rec.status = res.type === 'opaque' ? 'opaque(可达)' : String(res.status);
        rec.opaque = res.type === 'opaque';
        if (!rec.opaque) {
          const h = {};
          res.headers.forEach((v, k) => { h[k.toLowerCase()] = String(v).slice(0, 300); });
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
            // 文本响应（403 页）留前 600 字符正文，去掉 query 里的签名
            const ct = (rec.headers['content-type'] || '');
            if (ct.indexOf('text/') === 0) {
              let txt = '';
              try { txt = new TextDecoder().decode(head); } catch (e) { txt = ''; }
              rec.bodyHead = txt.replace(/[?&](upsig|uparams|deadline|e|os)=[^"'\\s<]*/gi, '…')
                .replace(/\\s+/g, ' ').slice(0, 600);
            }
          }
        }
      } catch (e) {
        rec.error = (e && e.name === 'AbortError') ? '超时' : ('失败:' + String(e && e.message).slice(0, 80));
        rec.status = rec.error;
      } finally {
        clearTimeout(timer);
      }
      out.push(rec);
      return rec;
    };

    for (const step of plan) {
      await one(step);
      if (step.thenNoCors && out[out.length - 1].error) {
        await one({ ...step, label: step.label + '(no-cors)', mode: 'no-cors' });
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return out;
  })()`;
}

async function main() {
  const result = { at: new Date().toISOString(), ep: EP, picks: {}, probes: [], notes: [] };

  if (!existsSync(CAND_FILE)) {
    process.stdout.write(`缺少 ${CAND_FILE}，先跑第一阶段\n`);
    return;
  }
  const cands = JSON.parse(readFileSync(CAND_FILE, 'utf8'));
  const enriched = cands.all
    .map((c) => {
      let u = null;
      try {
        u = new URL(c.url);
      } catch {
        return null;
      }
      return {
        url: c.url,
        host: u.hostname,
        os: u.searchParams.get('os') || '',
        path: u.pathname,
        search: u.search,
        cls: classifyCdn(u.hostname, u.search).cls,
        hitsProxyPrefix: u.pathname.includes(PROXY_PREFIX),
        height: c.h,
      };
    })
    .filter(Boolean);

  const pcd = enriched.filter((c) => c.cls === 'pcdn');
  const clean = enriched.filter((c) => c.cls === 'official' && c.os !== 'mcdn');
  /** 走 proxy 分支的候选（生产代码唯一会包 proxy 的形状） */
  const proxyEligible = pcd.filter((c) => c.hitsProxyPrefix);
  process.stdout.write(
    `候选 ${enriched.length} · PCDN ${pcd.length} · 其中命中 proxy 前缀 ${proxyEligible.length} · 干净官方 ${clean.length}\n`,
  );

  const pick = pcd.find((c) => !c.hitsProxyPrefix) || pcd[0] || null;
  if (!pick) {
    process.stdout.write('这轮候选里没有 PCDN —— 签名可能已过期，重跑第一阶段\n');
    return;
  }
  const tail = pick.path.split('/').pop();
  const base = clean.find((c) => c.path.split('/').pop() === tail) || clean[0] || null;

  result.picks = {
    pcdn: { host: pick.host, os: pick.os, pathShape: pathShape(pick.path), tail, height: pick.height },
    proxyEligible: proxyEligible[0]
      ? { host: proxyEligible[0].host, os: proxyEligible[0].os,
          pathShape: pathShape(proxyEligible[0].path), tail: proxyEligible[0].path.split('/').pop() }
      : null,
    baseline: base ? { host: base.host, os: base.os, tail: base.path.split('/').pop() } : null,
  };
  process.stdout.write(
    `主候选 ${pick.host} os=${pick.os} ${pathShape(pick.path)}\n`,
  );
  if (proxyEligible[0]) {
    process.stdout.write(
      `proxy 候选 ${proxyEligible[0].host} os=${proxyEligible[0].os} ${pathShape(proxyEligible[0].path)}\n`,
    );
  }

  const plan = [];
  // ① 形态 1 真身（页面内发；cors 失败自动补 no-cors）
  plan.push({ label: '1-original-pcdn', url: pick.url, thenNoCors: true });
  // ② 形态 2（对照：与第一阶段同一条，确认页面内与 Node 侧一致）
  plan.push({ label: '2-mirror-same-query', url: (() => {
    const u = new URL(pick.url);
    u.hostname = MIRROR;
    u.port = '';
    return u.toString();
  })() });
  // ③ 形态 3 —— 用**真正命中 proxy 前缀**的候选
  if (proxyEligible[0]) {
    plan.push({
      label: '3-proxy-eligible',
      url: `https://${PROXY}/?url=${encodeURIComponent(proxyEligible[0].url)}`,
    });
    plan.push({ label: '3x-direct-mirror-for-proxy-eligible', url: (() => {
      const u = new URL(proxyEligible[0].url);
      u.hostname = MIRROR;
      u.port = '';
      return u.toString();
    })() });
  } else {
    result.notes.push(
      '本集 19 条 PCDN 候选**没有一条**命中 proxyPathPrefix（`/v1/resource/upgcxcode/`）' +
        '——即生产代码对番剧这批候选全部走"只换 host"分支，proxy 分支在 PGC 上从未被触发',
    );
  }
  // ④ 基线
  if (base) plan.push({ label: '4-baseline-clean-official', url: base.url });

  process.stdout.write('\n页面内发请求 …\n');
  const recs = ev(exprPhase2(plan));
  for (const r of recs || []) {
    result.probes.push(r);
    process.stdout.write(
      `  ${r.label} @ ${r.targetHost} → ${r.status} ttfb=${r.ttfbMs ?? '-'} ` +
        `bytes=${r.totalBytesSeen ?? '-'} sha1=${r.sha1_1k || '-'}` +
        `${r.bodyHead ? ` body="${r.bodyHead.slice(0, 120)}"` : ''}\n`,
    );
  }

  // ── 判定 ──
  const by = (label) => (result.probes || []).find((p) => p.label === label) || null;
  const p1 = by('1-original-pcdn');
  const p1nc = by('1-original-pcdn(no-cors)');
  const p2 = by('2-mirror-same-query');
  const p3 = by('3-proxy-eligible');
  const p4 = by('4-baseline-clean-official');

  result.verdicts = {
    'Q-A_形态2可用性': p2
      ? p2.httpStatus === 206
        ? `是，206（页面内发与 Node 侧一致，说明不是客户端差异）`
        : `否，${p2.status}`
      : '未测',
    'Q-B_形态1归属': (() => {
      if (p1 && p1.headers) {
        return `拿到头：server=${p1.headers['server'] || '空'} / via[0]=${(p1.headers['via'] || '').split(',')[0] || '空'} / x-cache=${p1.headers['x-cache'] || '空'}`;
      }
      if (p1nc && p1nc.opaque) return '形态 1 请求**可达**（no-cors opaque），但 CORS 不回头，拿不到响应头';
      if (p1 && p1.error) return `形态 1 在页面内也失败：${p1.error}（DNS 被本地解析器给 0.0.0.0）`;
      return '未测';
    })(),
    'Q-C_形态1与2首块字节': (() => {
      const a = p1 && p1.sha1_1k;
      const b = p2 && p2.sha1_1k;
      if (!a || !b) return '未测（形态 1 拿不到字节）';
      return a === b ? `相同（${a}）—— 同一份资源` : `不同（${a} vs ${b}）`;
    })(),
    'Q-D_proxy是否更接近基线': (() => {
      if (!p3) return '未测（本集没有命中 proxy 前缀的候选）';
      if (p3.httpStatus !== 206 && p3.httpStatus !== 200) {
        return `否，proxy 返回 ${p3.status}${p3.bodyHead ? '；正文：' + p3.bodyHead.slice(0, 200) : ''}`;
      }
      return `是，proxy 返回 ${p3.httpStatus}（此时才算"proxy 路线可用"）`;
    })(),
  };

  process.stdout.write('\n── 判定 ──\n');
  for (const [k, v] of Object.entries(result.verdicts)) process.stdout.write(`${k}: ${v}\n`);

  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`\n已写出 ${OUT}\n`);
}

await main();