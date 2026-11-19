/**
 * 列出番剧 season 的集号 → epId 映射（页面内取，带登录态）。
 *
 * 用法：
 *   PL_SEASON=28747 npx tsx poc/probe/pcdn-diag/pgc-season-eps.mjs
 */

import { execFileSync } from 'node:child_process';

const SEASON = process.env.PL_SEASON ?? '28747';
const ENV = { ...process.env, BSK_AUTO_START: '0' };

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

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => {
  Atomics.wait(sleepBuf, 0, 0, Math.max(0, Math.round(ms)));
};

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
      sleep(1200);
    }
  }
  throw last;
}

function main() {
  try {
    current();
  } catch {
    bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '60']);
    cached = null;
    current();
  }
  const r = ev(`(async () => {
    const u = 'https://api.bilibili.com/pgc/view/web/season?season_id=' + ${JSON.stringify(SEASON)};
    const res = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
    const j = await res.json();
    const root = j && (j.result || (j.data && j.data.result));
    if (!root) return { err: 'no result', code: j && j.code };
    const eps = (root.episodes || []).map((e) => ({
      ep: e.ep_id, idx: e.index, title: String(e.title || '').slice(0, 24),
      cid: e.cid, aid: e.aid, dur: e.duration, badge: e.badge || '',
    }));
    return { code: j.code, title: root.title, total: root.total, episodes: eps };
  })()`);
  if (!r || r.err) {
    process.stdout.write(`失败 ${JSON.stringify(r)}\n`);
    return;
  }
  process.stdout.write(`${r.title} · total=${r.total} · 共 ${r.episodes.length} 集\n`);
  const tail = r.episodes.slice(-24);
  for (const e of tail) {
    process.stdout.write(`  idx=${e.idx}\tep=${e.ep}\tcid=${e.cid}\tdur=${e.dur}\t${e.badge}\t${e.title}\n`);
  }
  process.stdout.write(`\n最后 6 集 epId：${tail.slice(-6).map((e) => e.ep).join(',')}\n`);
  process.stdout.write(`最后 10 集 epId：${tail.slice(-10).map((e) => e.ep).join(',')}\n`);
}

main();