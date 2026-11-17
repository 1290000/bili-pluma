/**
 * ADR 0039 验证门 #1 · 阶段 A：登录态取 8 个视频的 2160p 候选（含签名）。
 *
 * 复用 `remaining-candidates.mjs` 的口径：热门榜预筛 → view 取 cid →
 * `/x/player/playurl?qn=120&fnval=4048&fourk=1` → 抽 `dash.video[]` 中
 * `height === 2160` 的轨。区别是**本脚本保留完整带签名的候选 URL**，
 * 只落在 gitignored 的 `rewrite-4k-candidates.json` 里，不进报告正文。
 *
 * 逐视频调用 `evaluate`（一次只回传一个视频的 ~9 条 URL），避免把
 * 8 个视频的签名 URL 塞进同一次 evaluate 返回被撑爆（旧探针踩过）。
 *
 * 只读：不点登录登出、不改 `src/`、不写页面 DOM。
 *
 * 跑法：
 *   node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/collect-4k-candidates.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'rewrite-4k-candidates.json');

/** bsk 需要的本机环境（见 AGENTS-TOOLS.md §4） */
const ENV = {
  ...process.env,
  BSK_HOME: process.env.BSK_HOME || 'C:/Users/i1290/.bsk',
  BSK_AUTO_START: '0',
  PATH: `/c/Users/i1290/.local/bin:${process.env.PATH || ''}`,
};

/** 跑一条 bsk 命令，返回 stdout */
function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, {
      encoding: 'utf8',
      env: ENV,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`bsk ${args[0]} 失败：${error.stderr || error.stdout || error.message}`);
  }
  if (!json) return out.trim();
  const index = out.indexOf('{');
  if (index < 0) throw new Error(`bsk ${args[0]} 没有返回 JSON：${out.slice(0, 200)}`);
  return JSON.parse(out.slice(index));
}

/** 当前 bsk 会话 / 标签页 / context（带几次重试：B站页面 VOM 常在变） */
function current(attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const sync = bsk(['sync', '--json'], { json: true });
      if (sync.session_id && sync.ctx) {
        return { session: sync.session_id, tab: sync.tab_id, ctx: sync.ctx };
      }
      last = new Error(`sync 无 session/ctx：${JSON.stringify(sync).slice(0, 160)}`);
    } catch (error) {
      last = error;
    }
  }
  throw last || new Error('bsk sync 失败');
}

/** 在页面里跑一段表达式，返回 JS 值 */
function evaluate(expression) {
  const cur = current();
  const raw = bsk([
    'evaluate',
    '--session', cur.session,
    '--tab-id', String(cur.tab),
    '--context', cur.ctx,
    '--expect', '[{"target":"body","field":"exists","equals":true}]',
    expression,
  ]);
  const index = raw.indexOf('{');
  if (index < 0) throw new Error(`evaluate 没有返回 JSON：${raw.slice(0, 200)}`);
  const parsed = JSON.parse(raw.slice(index));
  return parsed && parsed.value !== undefined ? parsed.value : parsed;
}

/** 页面侧公共前缀 */
const PRELUDE = `
  const j = (u) => fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } }).then((r) => r.json());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

/**
 * 发现阶段：热门榜预筛（与 `remaining-candidates.mjs` 完全一致），
 * 再逐个 playurl 复核是否真有 height=2160 的轨。
 */
function exprDiscover(limit) {
  return `(async () => {${PRELUDE}
    const nav = await j('https://api.bilibili.com/x/web-interface/nav');
    const pop = await j('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1');
    const list = (pop && pop.data && pop.data.list) || [];
    const pre = list.map((v) => ({
      bvid: v.bvid, aid: v.aid,
      title: String(v.title || '').slice(0, 60),
      dim: v.dimension ? v.dimension.width + 'x' + v.dimension.height : null,
      dh: v.dimension ? v.dimension.height : 0,
    })).filter((v) => v.dh >= 2160 || /4K|2160/i.test(v.title)).slice(0, ${limit});
    const out = [];
    for (const v of pre) {
      try {
        const view = await j('https://api.bilibili.com/x/web-interface/view?bvid=' + v.bvid);
        const cid = view && view.data && view.data.cid;
        if (!cid) { out.push({ ...v, cid: null, n2160: 0, note: 'no cid' }); continue; }
        const p = await j('https://api.bilibili.com/x/player/playurl?avid=' + v.aid + '&cid=' + cid
          + '&qn=120&fnval=4048&fourk=1');
        const vids = (p && p.data && p.data.dash && p.data.dash.video) || [];
        out.push({ ...v, cid, code: p && p.code,
          accept: (p && p.data && p.data.accept_quality) || null,
          n2160: vids.filter((t) => t.height === 2160).length,
          nTracks: vids.length });
      } catch (e) { out.push({ ...v, cid: null, n2160: 0, note: String(e).slice(0, 80) }); }
      await sleep(220);
    }
    return { nList: list.length, nav: { isLogin: !!(nav && nav.data && nav.data.isLogin),
        vipType: (nav && nav.data && nav.data.vipType) || 0,
        uname: (nav && nav.data && nav.data.uname) || null },
      videos: out };
  })()`;
}

/**
 * 单视频取数：只回传 height=2160 的轨 + 完整签名 URL。
 * 一次 evaluate 只处理一个视频，控制返回体积。
 */
function exprOne(bvid, aid, cid) {
  return `(async () => {${PRELUDE}
    const p = await j('https://api.bilibili.com/x/player/playurl?avid=${aid}&cid=${cid}'
      + '&qn=120&fnval=4048&fourk=1');
    const dash = p && p.data && p.data.dash;
    const urlsOf = (s) => [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean);
    const tracks = ((dash && dash.video) || [])
      .filter((t) => t.height === 2160)
      .map((t, ti) => ({
        trackIndex: ti, id: t.id, codecid: t.codecid,
        width: t.width, height: t.height, bandwidth: t.bandwidth,
        frameRate: t.frameRate || null, mimeType: t.mimeType || null,
        candidates: urlsOf(t).map((u, ci) => ({ index: ci, url: u })),
      }));
    return { bvid: '${bvid}', aid: ${aid}, cid: ${cid}, code: p && p.code,
      message: p && p.message, accept: (p && p.data && p.data.accept_quality) || null,
      ua: navigator.userAgent, tracks };
  })()`;
}

// ─────────────────────────── 主流程 ───────────────────────────

/** 确保有一个 bsk 会话；idle timeout 后重新 open */
function ensureSession() {
  try {
    current(1);
    return;
  } catch {
    // 会话过期：新开一个（复用当前 profile 的登录态）
    bsk([
      'open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '80',
    ], { json: true });
    current(3);
  }
}

ensureSession();
const discovery = evaluate(exprDiscover(14));
process.stdout.write(
  `热门 ${discovery.nList} 条，预筛 ${discovery.videos.length} 条；` +
    `nav login=${discovery.nav.isLogin} vipType=${discovery.nav.vipType}\n`,
);

const picked = discovery.videos.filter((v) => v.cid && v.n2160 >= 1).slice(0, 8);
process.stdout.write(`有 2160p 轨的视频：${picked.length} 条\n`);

const videos = [];
for (const video of picked) {
  const result = evaluate(exprOne(video.bvid, video.aid, video.cid));
  result.title = video.title;
  result.dim = video.dim;
  videos.push(result);
  const nCands = result.tracks.reduce((sum, track) => sum + track.candidates.length, 0);
  process.stdout.write(
    `  ${video.bvid} ${video.title} → code=${result.code} 2160p轨=${result.tracks.length} 候选=${nCands}\n`,
  );
}

if (videos.length < 8) {
  process.stdout.write(`⚠️ 只拿到 ${videos.length}/8 个视频，样本不足，报告必须如实标注\n`);
}

const payload = {
  at: new Date().toISOString(),
  note: 'ADR 0039 验证门 #1 阶段 A：登录态 2160p 候选原始取数；含签名 URL，gitignored',
  discovery,
  videos,
};
writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
process.stdout.write(`已写出 ${OUT}\n`);
