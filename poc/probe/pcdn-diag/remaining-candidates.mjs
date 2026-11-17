/**
 * 「屏蔽 PCDN」开关的**剩余候选数**实测（2026-11-17，批次 `pcdn-diag`）。
 *
 * ## 这个脚本回答什么
 *
 * 开关的硬规则（ADR 0038）：**某条轨的候选若全是 PCDN，整条原样保留**。
 * 于是「4K（2160p）那条轨剔除 PCDN 后还剩几条官方候选」直接决定开关在 4K 上
 * 有没有效果 —— 剩 0 就等于"开了也没用"，必须在 UI 上提前说明。
 *
 * 前一个探针 `probe.mjs` 只统计了 **host 全集**（Q8），没有"逐轨剩余数"这个口径。
 * 本脚本补的就是这个口径：**逐轨**数官方 / PCDN 候选。
 *
 * ## 为什么不用 Playwright，而用 bsk
 *
 * 4K 要大会员，大会员登录态只在**日常 profile** 里；Playwright 新 profile 没有 cookie。
 * 所以走 `bsk`（见 `docs/guides/browser-skill-setup.md`），复用用户当前登录态。
 * 页面侧的 `fetch(..., {credentials:'include'})` 还会被 Pluma 的 DNR 换上**播放账号**的
 * 凭据（`src/platform/http/dnr.ts`）—— 也就是说：**本脚本测到的就是播放器真正拿到的响应**。
 *
 * ## 分类不用"自家简化版"，直接 import 生产函数
 *
 * `classifyCdn` 的顺序即语义（PCDN 判据必须排在官方域兜底之前），自己在探针里
 * 复制一份就必然漂移。所以这里 `import` `src/core/cdn/classify.ts` 本体 ——
 * 必须用 `tsx` 跑（`node` 不认识 `.ts`）：
 *
 * ```bash
 * npx tsx poc/probe/pcdn-diag/remaining-candidates.mjs
 * npx tsx poc/probe/pcdn-diag/remaining-candidates.mjs --hook   # 额外抓 responseType
 * ```
 *
 * ## 两个阶段
 *
 * | 阶段 | 做法 | 产出 |
 * | --- | --- | --- |
 * | A · 候选抽样 | 页面里 `fetch` 三个 playurl 路径，展开逐轨候选 | 逐轨 official / pcdn 计数 |
 * | B · responseType | 页面里挂钩 `XMLHttpRequest` / `fetch`，再让播放器自己换画质 | 播放器真实请求的 `responseType` |
 *
 * ⚠️ **只读**：不登录登出、不改 `src/`、不写页面 DOM。
 * ⚠️ 输出 `remaining-candidates.json` 已 gitignore，**不提交**。
 *
 * @see poc/probe/pcdn-diag/REPORT-remaining.md
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

/** 跑在页面里的公共前缀：JSON fetch + 小睡 */
const PRELUDE = `
  const j = (u) => fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } }).then((r) => r.json());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

/**
 * 阶段 A 的页面表达式：抓一个视频的 playurl 并展开逐轨候选。
 *
 * 只回传 `host|os` 这样的紧凑串 —— 完整 URL 带签名，单个可达 400+ 字符，
 * 8 个视频会把 `evaluate` 的返回撑爆；而 `classifyCdn` 用到的查询串信息
 * **只有** `os=mcdn` 这一条，所以带上 `os` 的值就足以复现判定。
 *
 * @param bvid 视频号（仅用于回执核对）
 * @param aid av 号
 * @param cid 分 P id
 * @returns 页面表达式
 */
function exprPlayurl(bvid, aid, cid) {
  return `(async () => {${PRELUDE}
    const urlsOf = (s) => [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean);
    const pack = (s) => urlsOf(s).map((u) => {
      try { const x = new URL(u); return x.hostname + '|' + (x.searchParams.get('os') || ''); }
      catch { return 'INVALID_URL|'; }
    });
    const one = async (apiPath) => {
      const q = 'avid=${aid}&cid=${cid}&qn=120&fnval=4048&fourk=1';
      const p = await j('https://api.bilibili.com' + apiPath + '?' + q);
      const dash = p && p.data && p.data.dash;
      const track = (key) => (((dash && dash[key]) || [])).map((s) => ({
        id: s.id, codecid: s.codecid, w: s.width, h: s.height,
        bw: s.bandwidth, frameRate: s.frameRate || null, mime: s.mimeType || null,
        cands: pack(s), nBackup: ((s.backupUrl || s.backup_url) || []).length,
      }));
      return {
        path: apiPath, code: p && p.code, msg: p && p.message,
        acceptQuality: (p && p.data && p.data.accept_quality) || null,
        video: track('video'), audio: track('audio'),
        flac: dash && dash.flac && dash.flac.audio ? { cands: pack(dash.flac.audio) } : null,
        dolby: dash && dash.dolby && dash.dolby.audio
          ? ((dash.dolby.audio || []).map((a) => ({ id: a.id, cands: pack(a) }))) : null,
      };
    };
    const out = { bvid: '${bvid}', aid: ${aid}, cid: ${cid}, paths: [] };
    for (const p of ['/x/player/playurl', '/x/player/wbi/playurl', '/pgc/player/web/playurl']) {
      try { out.paths.push(await one(p)); } catch (e) { out.paths.push({ path: p, error: String(e) }); }
      await sleep(150);
    }
    return out;
  })()`;
}

/** 发现阶段：热门榜 → 预筛（dimension ≥ 2160 或标题含 4K）→ playurl 复核 */
function exprDiscover(limit) {
  return `(async () => {${PRELUDE}
    const pop = await j('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1');
    const list = (pop && pop.data && pop.data.list) || [];
    const pre = list.map((v) => ({
      bvid: v.bvid, aid: v.aid,
      title: String(v.title || '').slice(0, 44),
      dim: v.dimension ? v.dimension.width + 'x' + v.dimension.height : null,
      dh: v.dimension ? v.dimension.height : 0,
    })).filter((v) => v.dh >= 2160 || /4K|2160/i.test(v.title)).slice(0, ${limit});
    const out = [];
    for (const v of pre) {
      const view = await j('https://api.bilibili.com/x/web-interface/view?bvid=' + v.bvid);
      const cid = view && view.data && view.data.cid;
      if (!cid) { out.push({ ...v, cid: null, note: 'no cid' }); continue; }
      const p = await j('https://api.bilibili.com/x/player/playurl?avid=' + v.aid + '&cid=' + cid
        + '&qn=120&fnval=4048&fourk=1');
      const vids = (p && p.data && p.data.dash && p.data.dash.video) || [];
      out.push({ ...v, cid, accept: (p && p.data && p.data.accept_quality) || null,
        has4k: vids.some((s) => s.id === 120), nTracks: vids.length });
      await sleep(250);
    }
    return { nList: list.length, videos: out };
  })()`;
}

/**
 * 阶段 B 的页面表达式：**挂钩 + 逼播放器自己再要一次 playurl**。
 *
 * ## 为什么不能"换个画质"来触发
 *
 * 实测（本探针第一版）：一条 playurl 响应里**同时带全部画质**的轨
 * （18 条 = 6 档画质 × 3 编码），所以点「720P → 4K」播放器一次请求都不发。
 * 这与 `REPORT.md` Q9 的结论一致（播放 40 秒只发过 1 次 playurl）。
 *
 * 真正能让播放器重发的是 `window.player.connect()` —— 实测它触发了一次
 * `//api.bilibili.com/x/player/wbi/playurl`（**协议相对 URL**，注意匹配）。
 *
 * ## 为什么钩子必须和"逼请求"写在同一个 evaluate 里
 *
 * 钩子装在**当前 document** 上，页面一导航就全丢；而 `bsk` 0.5.0 没有
 * `Page.addScriptToEvaluateOnNewDocument`（无法在 document_start 注入）。
 * 所以只能：同一段脚本里先装钩子、再 `connect()`、再读回。
 *
 * @param bvid 4K 视频号（仅回执用）
 * @returns 页面表达式
 */
function exprHookConnect(bvid) {
  return `(async () => {${PRELUDE}
    const KEY = '__plumaProbeV2';
    const H = (window[KEY] = window[KEY] || { installed: true, at: Date.now(), hits: [], hooked: false });
    if (!H.hooked) {
      H.hooked = true;
      const isPlayurl = (u) => /\\/playurl/.test(String(u));
      const grab = (xhr) => {
        try {
          const rt = xhr.responseType;
          if (rt === '' || rt === 'text') return xhr.responseText || '';
          if (rt === 'json') return JSON.stringify(xhr.response);
          return '';
        } catch (e) { return ''; }
      };
      const openOrig = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) {
        try { this.__pu = isPlayurl(u) ? String(u) : null; } catch (e) {}
        return openOrig.apply(this, arguments);
      };
      const sendOrig = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        const self = this, u = self.__pu;
        self.__pu = null;  // 立刻消费，避免 XHR 对象复用导致串味
        if (u) {
          self.addEventListener('loadend', () => {
            H.hits.push({ via: 'xhr', url: u.split('?')[0], responseType: self.responseType,
              mime: (self.getResponseHeader && self.getResponseHeader('content-type')) || null,
              status: self.status, bodyLen: (grab(self) || '').length, at: Date.now() - H.at, body: grab(self) });
          });
        }
        return sendOrig.apply(this, arguments);
      };
      const fOrig = window.fetch;
      if (typeof fOrig === 'function') {
        window.fetch = function (input, init) {
          const u = typeof input === 'string' ? input : (input && input.url) || '';
          const p = fOrig.apply(this, arguments);
          if (isPlayurl(u)) {
            p.then((r) => r.clone().text().then((t) => {
              H.hits.push({ via: 'fetch', url: u.split('?')[0], responseType: 'fetch (无 responseType 属性)',
                mime: r.headers.get('content-type'), status: r.status, bodyLen: t.length, at: Date.now() - H.at, body: t });
            }).catch(() => {})).catch(() => {});
          }
          return p;
        };
      }
    }
    let trigger = 'none';
    const steps = [];
    // 等播放器实例就绪（导航刚到页面时 window.player 还没建好）
    let waited = 0;
    while (!(window.player && typeof window.player.connect === 'function') && waited < 20000) {
      await sleep(500);
      waited += 500;
    }
    /**
     * 逼播放器**自己**再要一次 playurl。
     *
     * 实测结论（本探针调试记录）：单叫 connect 不会重发（连接已在，播放器认为
     * 手里那份 playurl 还有效 —— 它一次请求就带全部画质）。必须让它先断开。
     * 所以按下面的顺序试，**记录哪一步真的产生了请求**，不猜。
     */
    const fire = async (name, fn) => {
      const before = H.hits.length;
      let err = null;
      try { fn(); } catch (e) { err = String(e).slice(0, 80); }
      await sleep(3000);
      const gained = H.hits.length - before;
      steps.push({ step: name, err, gained });
      return gained > 0;
    };
    const P = window.player;
    if (P && typeof P.connect === 'function') {
      if (await fire('connect', () => P.connect())) trigger = 'connect';
      else if (await fire('disconnect', () => P.disconnect())) trigger = 'disconnect';
      else if (await fire('connect(after disconnect)', () => P.connect())) trigger = 'connect(after disconnect)';
      else if (await fire('recreateVideoBuffer', () => P.recreateVideoBuffer())) trigger = 'recreateVideoBuffer';
    }
    const pack = (s) => [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean)
      .map((u) => { try { const x = new URL(u); return x.hostname + '|' + (x.searchParams.get('os') || ''); }
                    catch (e) { return 'INVALID_URL|'; } });
    return { bvid: '${bvid}', trigger, steps,
      hits: (window[KEY].hits || []).map((h) => {
        let d = null;
        try { d = JSON.parse(h.body || ''); } catch (e) {
          return { via: h.via, url: h.url, responseType: h.responseType, status: h.status,
                   bodyLen: h.bodyLen, parseError: String(e).slice(0, 60) };
        }
        const dash = d && d.data && d.data.dash;
        return { via: h.via, url: h.url, responseType: h.responseType, mime: h.mime, status: h.status,
          bodyLen: h.bodyLen, code: d && d.code,
          acceptQuality: (d && d.data && d.data.accept_quality) || null,
          video: ((dash && dash.video) || []).map((s) => ({ id: s.id, codecid: s.codecid, w: s.width, h: s.height,
            bw: s.bandwidth, frameRate: s.frameRate || null, cands: pack(s) })),
          audio: ((dash && dash.audio) || []).map((s) => ({ id: s.id, bw: s.bandwidth, cands: pack(s) })) };
      }) };
  })()`;
}

/**
 * 番剧（PGC）路径：`/pgc/player/web/playurl` 要用 `ep_id`，普通 UGC 视频传 avid/cid
 * 只会拿到 `-404 啥都木有` —— 所以番剧必须**另外**取一次。
 *
 * 番剧 4K 稀少（本次 6 部里 2 部有 2160p 轨），有就照同一口径数候选。
 */
function exprPgc() {
  return `(async () => {${PRELUDE}
    const pack = (s) => [s.baseUrl || s.base_url, ...((s.backupUrl || s.backup_url) || [])].filter(Boolean)
      .map((u) => { try { const x = new URL(u); return x.hostname + '|' + (x.searchParams.get('os') || ''); }
                    catch (e) { return 'INVALID_URL|'; } });
    const rank = await j('https://api.bilibili.com/pgc/web/rank/list?day=3&season_type=1');
    const seasons = ((rank && rank.result && rank.result.list) || []).slice(0, 6);
    const out = [];
    for (const s of seasons) {
      const season = await j('https://api.bilibili.com/pgc/view/web/season?season_id=' + s.season_id);
      const eps = ((season && season.result && season.result.episodes) || []).slice(0, 1);
      if (!eps.length) { out.push({ seasonId: s.season_id, title: String(s.title || '').slice(0, 24), note: 'no ep' }); continue; }
      const p = await j('https://api.bilibili.com/pgc/player/web/playurl?ep_id=' + eps[0].id
        + '&qn=120&fnval=4048&fourk=1');
      const dash = p && p.result && p.result.dash;
      const vids = (dash && dash.video) || [];
      out.push({
        seasonId: s.season_id, title: String(s.title || '').slice(0, 24), epId: eps[0].id,
        code: p && p.code, msg: p && p.message,
        accept: (p && p.result && p.result.accept_quality) || null,
        nTracks: vids.length,
        video: vids.map((t) => ({ id: t.id, codecid: t.codecid, w: t.width, h: t.height,
          bw: t.bandwidth, frameRate: t.frameRate || null, cands: pack(t) })),
      });
      await sleep(300);
    }
    return { nSeasons: seasons.length, out };
  })()`;
}

// ─────────────────────────── bsk 调用 ───────────────────────────

/** 跑一条 bsk 命令，返回 stdout（自动剥 JSON） */
function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, {
      encoding: 'utf8',
      env: { ...process.env, BSK_AUTO_START: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // bsk 的报错都在 stderr / stdout 里；包一层好让调用点看见原始原因，而不是 JSON.parse 崩
    throw new Error(`bsk ${args[0]} 失败：\n${e.stderr || e.stdout || e.message}`);
  }
  if (!json) return out.trim();
  // 0.5.0 的 `--json` 输出是单个 JSON 对象；前面可能有提示行，故从第一个 `{` 起截
  const i = out.indexOf('{');
  return JSON.parse(out.slice(i));
}

/** 当前会话/标签页（取自 `bsk sync`）+ 一个可用的 ctx */
function current() {
  const s = bsk(['sync', '--json'], { json: true });
  return { session: s.session_id, tab: s.tab_id, ctx: s.ctx };
}

/** 在页面里跑一段表达式（单元素 argv，绝不过 shell） */
function evaluate(expression) {
  const cur = current();
  const out = bsk([
    'evaluate',
    '--session', cur.session,
    '--tab-id', String(cur.tab),
    '--context', cur.ctx,
    '--expect', '[{"target":"body","field":"exists","equals":true}]',
    expression,
  ]);
  const parsed = JSON.parse(out.slice(out.indexOf('{')));
  return parsed && parsed.value !== undefined ? parsed.value : parsed;
}
// ─────────────────────────── 分析 ───────────────────────────

/**
 * 把 `host|os` 串判成线路。
 *
 * `os` 是唯一需要回传的查询参数：`classifyCdn` 的第 5 条判据
 * （`os=mcdn` → pcdn，对任何 host 生效）只依赖它。**必须传第二个参数**，
 * 不传就会把"官方镜像代理的 mcdn 资源"判成官方 —— 是本探针最容易漏的一处。
 *
 * @param packed `host|os` 形态的紧凑串
 * @returns 分类结果
 */
function classifyPacked(packed) {
  const [host, os] = packed.split('|');
  const search = os ? `os=${os}` : undefined;
  return classifyCdn(host, search);
}

/** 逐轨统计：总数 / 各类数 / 剔除 PCDN 后剩下的官方候选数 */
function summarizeTrack(track) {
  const per = track.cands.map(classifyPacked);
  const count = { official: 0, pcdn: 0, 'third-party': 0, unknown: 0 };
  for (const c of per) count[c.cls] += 1;
  const hosts = track.cands.map((p) => p.split('|')[0]);
  const officialHosts = Array.from(
    new Set(per.map((c, i) => (c.cls === 'official' ? hosts[i] : null)).filter(Boolean)),
  );
  return {
    ...track,
    total: track.cands.length,
    count,
    /** 剔除 PCDN 后剩下的官方候选数 —— ADR 0038 关心的就是这个数 */
    officialAfterFilter: count.official,
    /**
     * 同上，但按 **distinct host** 去重。
     *
     * 番剧实测：同一条轨的 baseUrl 和 backupUrl 会**指向同一个 host**
     * （`upos-sz-mirrorcos.bilivideo.com` 出现两次），按条数数会高估冗余 ——
     * 那个 host 挂了，两条一起挂。
     */
    officialAfterFilterDistinct: officialHosts.length,
    /** 这条轨是否"全是 PCDN"（真 → 整条原样保留） */
    allPcdn: count.official === 0 && count.pcdn > 0,
    officialHosts,
    pcdnHosts: Array.from(
      new Set(per.map((c, i) => (c.cls === 'pcdn' ? hosts[i] : null)).filter(Boolean)),
    ),
  };
}

/** 画质分桶：按 quality id 归，不按 height（竖屏 4K 的 height 是 3840） */
const BUCKETS = [
  { name: '2160p', ids: [120, 125] },
  { name: '1080p', ids: [80, 112, 116, 74] },
  { name: '720p', ids: [64] },
];

/**
 * 汇总裁剪：每个视频 → 每个画质桶 → 逐轨剩余官方候选数。
 *
 * @param videos 阶段 A 的原始结果数组
 */
function aggregate(videos) {
  const rows = [];
  for (const v of videos) {
    const path0 = (v.paths || []).find((p) => p.path === '/x/player/playurl') || {};
    const tracks = (path0.video || []).map(summarizeTrack);
    const audios = (path0.audio || []).map(summarizeTrack);
    for (const b of BUCKETS) {
      const inBucket = tracks.filter((t) => b.ids.includes(t.id));
      rows.push({
        bvid: v.bvid,
        title: v.title,
        quality: b.name,
        nTracks: inBucket.length,
        zeroOfficial: inBucket.filter((t) => t.officialAfterFilter === 0).length,
        tracks: inBucket.map((t) => ({
          id: t.id, codecid: t.codecid, wh: `${t.w}x${t.h}`, frameRate: t.frameRate,
          total: t.total, official: t.count.official, pcdn: t.count.pcdn,
          third: t.count['third-party'], unknown: t.count.unknown,
          officialAfterFilter: t.officialAfterFilter, allPcdn: t.allPcdn,
          officialAfterFilterDistinct: t.officialAfterFilterDistinct,
          officialHosts: t.officialHosts, pcdnHosts: t.pcdnHosts,
        })),
      });
    }
    auditAudio(rows, v, audios);
  }
  return rows;
}

/** 音频轨也照同一口径记一份（`flac` / `dolby` 单独成条） */
function auditAudio(rows, v, audios) {
  for (const t of audios) {
    rows.push({
      bvid: v.bvid, title: v.title, quality: `audio:id=${t.id}`,
      nTracks: 1, zeroOfficial: t.officialAfterFilter === 0 ? 1 : 0,
      tracks: [{
        id: t.id, codecid: t.codecid, wh: `${t.w}x${t.h}`, frameRate: null,
        total: t.total, official: t.count.official, pcdn: t.count.pcdn,
        third: t.count['third-party'], unknown: t.count.unknown,
        officialAfterFilter: t.officialAfterFilter, allPcdn: t.allPcdn,
        officialAfterFilterDistinct: t.officialAfterFilterDistinct,
        officialHosts: t.officialHosts, pcdnHosts: t.pcdnHosts,
      }],
    });
  }
}

/**
 * 打开一个页面 —— 用**新标签页**，不用 `navigate`/`open`。
 *
 * `navigate` / `open` 都要求一份**未被消费的 strict observation**（视频页 VOM 因弹幕
 * 一直在变，实测 3 次重试全 `observation_changed`）；`tab create` 是"标签页动作"，
 * 给 `--expect` 就够，**不需要**严格观测。新建标签页顺带保证"从零加载"，
 * 播放器实例是干净的。
 */
function openPage(url) {
  const cur = current();
  bsk([
    'tab', 'create',
    '--url', url,
    '--session', cur.session,
    '--context', cur.ctx,
    '--expect', '[{"target":"body","field":"exists","equals":true}]',
    '--json',
  ]);
  return current();
}

/** 控制台里直接能读的报告体（≤20 行，与回传给主理人的口径一致） */
function printReport(rows, hook) {
  const line = (s) => process.stdout.write(`${s}\n`);
  const dist = (sel, key) => {
    const o = {};
    for (const r of sel) for (const t of r.tracks) o[t[key]] = (o[t[key]] || 0) + 1;
    return JSON.stringify(o);
  };
  line('');
  for (const bucket of ['2160p', '1080p', '720p']) {
    const sel = rows.filter((r) => r.quality === bucket);
    const nTracks = sel.reduce((a, r) => a + r.nTracks, 0);
    const zero = sel.reduce((a, r) => a + r.zeroOfficial, 0);
    line(
      `${bucket}: 轨 ${nTracks} 条，official=0 的 ${zero} 条；` +
        `剩余官方候选（按条）${dist(sel, 'officialAfterFilter')}（按 host 去重）${dist(sel, 'officialAfterFilterDistinct')}`,
    );
  }
  const allPcdnTracks = rows.flatMap((r) => r.tracks.filter((t) => t.allPcdn));
  line(`全 PCDN 的轨：${allPcdnTracks.length} 条`);
  for (const h of hook?.hits || []) {
    line(`播放器自身请求：${h.via} ${h.url} → responseType=${JSON.stringify(h.responseType)} code=${h.code}`);
  }
  line(`逼播放器重发的那一步：${hook?.trigger ?? '—'}`);
}

// ─────────────────────────── 主流程 ───────────────────────────

const wantHook = process.argv.includes('--hook');
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'remaining-candidates.json');

const discovery = evaluate(exprDiscover(8));
process.stdout.write(`热门 ${discovery.nList} 条 → 预筛 ${discovery.videos.length} 条\n`);

const picked = discovery.videos.filter((v) => v.cid && v.has4k);
const videos = [];
for (const v of picked) {
  const r = evaluate(exprPlayurl(v.bvid, v.aid, v.cid));
  r.title = v.title;
  r.dim = v.dim;
  videos.push(r);
  const p0 = (r.paths || []).find((p) => p.path === '/x/player/playurl') || {};
  process.stdout.write(`  ${v.bvid} ${v.title} → code=${p0.code} 轨=${(p0.video || []).length}\n`);
}

const rows = aggregate(videos);

// ── 番剧（PGC）路径 ──────────────────────────────────────────
const pgcRaw = evaluate(exprPgc());
const pgc = {
  ...pgcRaw,
  rows: (pgcRaw.out || [])
    .filter((s) => s.video)
    .map((s) => {
      const t4 = s.video.filter((t) => t.id === 120).map(summarizeTrack);
      return {
        seasonId: s.seasonId, title: s.title, epId: s.epId,
        nTracks4k: t4.length,
        tracks: t4.map((t) => ({
          codecid: t.codecid, wh: `${t.w}x${t.h}`, total: t.total,
          official: t.count.official, pcdn: t.count.pcdn,
          officialAfterFilter: t.officialAfterFilter,
          officialAfterFilterDistinct: t.officialHosts.length,
          allPcdn: t.allPcdn, officialHosts: t.officialHosts, pcdnHosts: t.pcdnHosts,
        })),
      };
    }),
};
for (const s of pgc.rows) {
  if (s.nTracks4k === 0) continue;
  process.stdout.write(
    `PGC 2160p ${s.title}：${s.tracks.map((t) => `${t.codecid}→官方${t.officialAfterFilter}(去重${t.officialAfterFilterDistinct})`).join(' ')}\n`,
  );
}

// ── 阶段 B：播放器自己那次请求的 responseType + wbi 路径的候选 ----
let hook = null;
if (wantHook && picked.length > 0) {
  const target = picked[0];
  process.stdout.write(`\n阶段 B：在 ${target.bvid} 上挂钩并逼播放器重发 playurl…\n`);
  openPage(`https://www.bilibili.com/video/${target.bvid}/`);
  const raw = evaluate(exprHookConnect(target.bvid));
  hook = {
    ...raw,
    tracks: (raw.hits || [])
      .filter((h) => h.video)
      .flatMap((h) => (h.video || []).map((t) => summarizeTrack(t))),
  };
  for (const h of raw.hits || []) {
    process.stdout.write(
      `  ${h.via} ${h.url} → responseType=${JSON.stringify(h.responseType)} code=${h.code} bodyLen=${h.bodyLen}\n`,
    );
  }
}

const result = {
  at: new Date().toISOString(),
  note: 'PCDN 开关的剩余候选数实测；classifyCdn 为 src/core/cdn/classify.ts 本体',
  discovery,
  videos,
  rows,
  hook,
  pgc,
};
printReport(rows, hook);
writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
process.stdout.write(`\n已写出 ${OUT}\n`);
if (!wantHook) process.stdout.write('（加 --hook 可额外抓播放器自身请求的 responseType）\n');
