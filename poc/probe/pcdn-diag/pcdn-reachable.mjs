/**
 * 形态 1（原 PCDN host）可达性补测 —— 绕开 `Range` 头这个 CORS 陷阱。
 *
 * ## 为什么还要再测一次
 *
 * 上一阶段页面内 `no-cors` 也失败了。但**播放器确实成功请求过 mountaintoys 分片**
 * （`REPORT-pgc-pcdn` 那一轮的采样里有 `mv0b973m.edge.mountaintoys.cn:4483 ×2`）——
 * 所以"页面内 fetch 失败"与"host 不可达"是两件事。
 *
 * 最可能的原因：`Range` 是 **CORS-unsafe request header**，
 * 在 `mode: 'no-cors'` 下被浏览器直接拒绝（请求根本没发出，抛 TypeError）。
 * 而 `<video>` 的 media 请求不受这条限制，所以播放器能拿到。
 *
 * 所以本脚本按三种组合各试一次，**逐条记录到底卡在哪一层**：
 *
 * | # | mode | Range | 期望 |
 * | --- | --- | --- | --- |
 * | a | `no-cors` | 无 | 若 resolve（opaque）→ **host 可达**，只是不回头 |
 * | b | `cors` | 无 | 若 resolve → 能读头和字节 |
 * | c | `cors` | 有 | 上一阶段那条（已失败） |
 *
 * 再加一条**对照**：同 path 换到官方镜像，同样 `no-cors` 无 Range。
 * 若官方镜像 resolve 而 PCDN 不 resolve，说明差异不在"浏览器能不能发"，而在 host 本身。
 *
 * 用法：
 *   npx tsx poc/probe/pcdn-diag/pcdn-reachable.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAND = path.join(HERE, 'mcdn-candidates.json');
const OUT = path.join(HERE, 'mcdn-reachable.json');
const MIRROR = 'upos-sz-mirrorhw.bilivideo.com';

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
        '--expect', '[{"target":"body","field":"exists","equals":true}]', expression, '--timeout', '90s',
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

/** 三种 mode/Range 组合 + 官方镜像对照 */
function exprReach(plan) {
  return `(async () => {
    const plan = ${JSON.stringify(plan)};
    const out = [];
    for (const step of plan) {
      const rec = { label: step.label, mode: step.mode, withRange: step.withRange,
        targetHost: '', ok: false, type: null, httpStatus: null, ttfbMs: null,
        error: null, errorName: null, headers: null };
      try { rec.targetHost = new URL(step.url).hostname; } catch (e) {}
      const t0 = performance.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      const init = { mode: step.mode, credentials: 'omit', signal: ac.signal, cache: 'no-store' };
      if (step.withRange) init.headers = { Range: 'bytes=0-1023', Accept: '*/*' };
      try {
        const res = await fetch(step.url, init);
        rec.ok = true;
        rec.type = res.type;
        rec.httpStatus = res.status;
        rec.ttfbMs = Math.round(performance.now() - t0);
        if (res.type !== 'opaque') {
          const h = {};
          res.headers.forEach((v, k) => { h[k.toLowerCase()] = String(v).slice(0, 200); });
          rec.headers = h;
        }
        try { await res.arrayBuffer(); } catch (e) {}
      } catch (e) {
        rec.errorName = e && e.name;
        rec.error = String(e && e.message).slice(0, 100);
        rec.ttfbMs = Math.round(performance.now() - t0);
      } finally {
        clearTimeout(timer);
      }
      out.push(rec);
      await new Promise((r) => setTimeout(r, 250));
    }
    return out;
  })()`;
}

async function main() {
  const result = { at: new Date().toISOString(), probes: [], notes: [] };
  if (!existsSync(CAND)) {
    process.stdout.write(`缺少 ${CAND} —— 先跑 pgc-osmcdn-attrib.mjs\n`);
    return;
  }
  const cands = JSON.parse(readFileSync(CAND, 'utf8'));
  const pcdn = cands.all
    .map((c) => {
      try {
        const u = new URL(c.url);
        return { url: c.url, host: u.hostname, os: u.searchParams.get('os') || '', path: u.pathname };
      } catch {
        return null;
      }
    })
    .filter((c) => c && c.os === 'mcdn');
  if (pcdn.length === 0) {
    process.stdout.write('候选里没有 os=mcdn —— 签名可能过期，重跑第一阶段\n');
    return;
  }
  const pick = pcdn[0];
  const mirrorUrl = (() => {
    const u = new URL(pick.url);
    u.hostname = MIRROR;
    u.port = '';
    return u.toString();
  })();

  result.picks = {
    pcdnHost: pick.host,
    pcdnPathShape: `/${pick.path.split('/').filter(Boolean).slice(0, 3).join('/')}/…`,
    mirrorHost: MIRROR,
  };

  const plan = [
    { label: 'pcdn · no-cors · 无 Range', url: pick.url, mode: 'no-cors', withRange: false },
    { label: 'pcdn · cors · 无 Range', url: pick.url, mode: 'cors', withRange: false },
    { label: 'pcdn · cors · 有 Range', url: pick.url, mode: 'cors', withRange: true },
    { label: 'mirror · no-cors · 无 Range', url: mirrorUrl, mode: 'no-cors', withRange: false },
  ];

  process.stdout.write(`PCDN host ${pick.host}\n页面内四种组合 …\n`);
  const recs = ev(exprReach(plan));
  for (const r of recs || []) {
    result.probes.push(r);
    process.stdout.write(
      `  ${r.label}\n    → ok=${r.ok} type=${r.type} status=${r.httpStatus ?? '-'} ` +
        `ttfb=${r.ttfbMs ?? '-'}${r.error ? ` 错误=${r.errorName}:${r.error}` : ''}` +
        `${r.headers && r.headers.server ? ` server=${r.headers.server}` : ''}\n`,
    );
  }

  const pcdnOk = (result.probes || []).some((p) => p.targetHost === pick.host && p.ok);
  const pcdnOpaque = (result.probes || []).some(
    (p) => p.targetHost === pick.host && p.ok && p.type === 'opaque',
  );
  result.verdicts = {
    形态1可达性: pcdnOk
      ? pcdnOpaque
        ? '可达（no-cors opaque resolve）—— host 活着，只是不返 CORS 头，所以读不到响应头'
        : '可达且可读头（cors 成功）'
      : '不可达：三种组合全部抛错 —— 请求根本没发出（DNS 被解析成 0.0.0.0）',
  };

  process.stdout.write('\n── 判定 ──\n');
  for (const [k, v] of Object.entries(result.verdicts)) process.stdout.write(`${k}: ${v}\n`);

  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`\n已写出 ${OUT}\n`);
}

await main();