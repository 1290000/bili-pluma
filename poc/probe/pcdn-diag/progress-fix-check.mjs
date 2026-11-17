/**
 * 验「进度还原只用一次」（commit c4ea5c6，2026-11-17 真机）。
 *
 * ## 要证的闭环
 *
 * 旧实现每次 playurl 都可能写回 `progressCache` 里那个**冻结的** `last_play_time`，
 * 闸门只看 `video.currentTime > 3`；而播放器重开流时 MediaSource 重建、`currentTime`
 * 先归 0 → 闸放行 → 写回冻结值 → seek 回去 → 再重开 → 观察到的就是
 * `13.33 → 5.98` 这种**往回跳**（"视频反复从头几秒开始"）。
 *
 * 修复后：进度机会**用过就作废**（`markProgressUsed`），所以重开流不该再把位置拽回去。
 *
 * ## 判据（主理人给的）
 *
 * 每个动作前后各读一次 `{t, paused, readyState, height}`：
 *
 * | # | 动作 | 判据 |
 * | --- | --- | --- |
 * | 1 | 播到 ≥10s → 切清晰度 4K→1080→4K | 切换后 `t` 不得小于切换前（允许 -1s） |
 * | 2 | seek 到 600s → 播 30s → 再切一次 | 同上 |
 * | 3 | 切分 P 再切回（有的话） | 同上 |
 *
 * ⚠️ **前置**：必须先制造"历史进度"（播到 60s + 等 5s + 刷新），
 * 否则那份冻结值根本没被写进服务端，测不出任何东西。
 *
 * 用法：
 *
 * ```bash
 * npx tsx poc/probe/pcdn-diag/progress-fix-check.mjs --prepare   # 造历史进度（播 60s 后刷新）
 * npx tsx poc/probe/pcdn-diag/progress-fix-check.mjs            # 三个动作 + 判定
 * ```
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const BVID = process.env.PL_BVID ?? 'BV1oFsW6oEs5';
const OUT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  'progress-fix-check.json',
);

function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, {
      encoding: 'utf8',
      env: { ...process.env, BSK_AUTO_START: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`bsk ${args[0]} 失败：${(e.stderr || e.stdout || e.message).slice(0, 300)}`);
  }
  if (!json) return out.trim();
  return JSON.parse(out.slice(out.indexOf('{')));
}

let cached = null;
function current() {
  if (cached) return cached;
  const s = bsk(['sync', '--json'], { json: true });
  cached = { session: s.session_id, tab: s.tab_id, ctx: s.ctx };
  return cached;
}

/** 跑一段短表达式（每次点完/切完都会失效，所以失败就重 sync 一次） */
function ev(expression) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const cur = current();
      const out = bsk([
        'evaluate', '--session', cur.session, '--tab-id', String(cur.tab), '--context', cur.ctx,
        '--expect', '[{"target":"body","field":"exists","equals":true}]', expression,
      ]);
      const parsed = JSON.parse(out.slice(out.indexOf('{')));
      return parsed && parsed.value !== undefined ? parsed.value : parsed;
    } catch (e) {
      cached = null;
      try {
        bsk(['wait-ms', '1200']);
      } catch {
        /* ignore */
      }
      if (i === 2) throw e;
    }
  }
  return null;
}

const READ = `(() => {
  const v = document.querySelector('video');
  if (!v) return { t: null, note: 'no video' };
  return { t: +v.currentTime.toFixed(2), paused: v.paused, readyState: v.readyState,
    height: v.videoHeight, width: v.videoWidth, error: v.error ? v.error.code : null,
    now: Math.round(performance.now()) };
})()`;

const sleep = (ms) => bsk(['wait-ms', String(ms)]);

/** 探一下播放器暴露了哪些画质相关方法（能走 API 就不去点菜单） */
const PROBE_API = `(() => {
  const p = window.player;
  if (!p) return { hasPlayer: false };
  const names = Object.keys(p).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(p) || {}));
  return { hasPlayer: true,
    quality: p.getQuality ? p.getQuality() : null,
    candidates: names.filter((k) => /quality|qualitySwitch|switch/i.test(k)).slice(0, 20),
    hasRecreate: typeof p.recreateVideoBuffer === 'function' };
})()`;

/**
 * 切清晰度：优先用播放器 API，没有就走画质菜单（JS 派发 click）。
 *
 * ⚠️ 菜单项按 `textContent` 匹配，且**只点画质菜单容器里的项** ——
 * 上一次按 VOM 文案找控件的教训：别用"包含"匹配整页文本。
 *
 * @param label 菜单项文案前缀（`4K` / `1080P`）
 */
function switchQualityExpr(label) {
  return `(() => {
    const P = window.player;
    if (P && typeof P.requestQuality === 'function') { P.requestQuality(${label === '4K' ? 120 : 80}); return { via: 'api', ok: true }; }
    const items = Array.from(document.querySelectorAll('.bpx-player-ctrl-quality-menu-item'));
    const hit = items.find((e) => (e.textContent || '').trim().startsWith('${label}'));
    if (!hit) return { via: 'menu', ok: false, items: items.map((e) => (e.textContent || '').trim().slice(0, 12)) };
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { via: 'menu', ok: true, clicked: (hit.textContent || '').trim().slice(0, 12) };
  })()`;
}

const prepare = process.argv.includes('--prepare');

const result = { at: new Date().toISOString(), bvid: BVID, steps: [], api: null, prepared: null };

if (prepare) {
  // ── 造历史进度：seek 到 45s 让播放器继续播到 ≈60s，等 5 秒让服务端记下，再刷新 ──
  ev(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = 45; return { seeked: !!v }; })()`);
  sleep(16000);
  const t1 = ev(READ);
  sleep(5000);
  const t2 = ev(READ);
  result.prepared = { afterSeek: t1, afterWait: t2 };
  process.stdout.write(`造历史进度：t=${t2 && t2.t}s（等 5 秒后）\n`);
  // `reload` 是"视觉动作"，必须带一份未被消费的 strict observation（`--expect` 不够）
  const fresh = bsk(['sync', '--json'], { json: true });
  bsk(['reload', '--session', fresh.session_id, '--context', fresh.ctx,
       '--observation', fresh.observation_id, '--json']);
  cached = null;
  sleep(8000);
  const afterReload = ev(READ);
  result.prepared.afterReload = afterReload;
  process.stdout.write(`刷新后 t=${afterReload && afterReload.t}s\n`);
  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`已写出 ${OUT}\n`);
} else {
  result.api = ev(PROBE_API);
  process.stdout.write(`player: ${JSON.stringify(result.api)}\n`);

  /** 一次"切换"，前后各读一次 t */
  const doSwitch = (step, label) => {
    const before = ev(READ);
    const sw = ev(switchQualityExpr(label));
    sleep(5000);
    const after = ev(READ);
    const row = {
      step, label, before, after, switch: sw,
      delta: before && after && before.t !== null && after.t !== null ? +(after.t - before.t).toFixed(2) : null,
    };
    row.pass = row.delta !== null ? row.delta >= -1 : false;
    result.steps.push(row);
    process.stdout.write(
      `${step} ${label}: ${before && before.t}s → ${after && after.t}s ` +
        `(Δ=${row.delta}) ${row.pass ? 'PASS' : '**FAIL**'} via=${(sw && sw.via) || '?'}\n`,
    );
    return row;
  };

  // 动作 1：播到 ≥10s 后切换 4K → 1080P → 4K
  for (let i = 0; i < 20; i += 1) {
    const r = ev(READ);
    if (r && r.t >= 10) break;
    sleep(1000);
  }
  doSwitch('1a', '1080P');
  doSwitch('1b', '4K');

  // 动作 2：seek 到 600s → 播 30 秒 → 再切一次
  ev(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = 600; return { seeked: !!v }; })()`);
  sleep(31000);
  const at600 = ev(READ);
  result.at600 = at600;
  process.stdout.write(`seek 600 后播 30 秒：t=${at600 && at600.t}s\n`);
  doSwitch('2', '1080P');

  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`\n已写出 ${OUT}\n`);
}
