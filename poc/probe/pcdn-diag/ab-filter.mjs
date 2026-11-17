/**
 * 「屏蔽 PCDN」开关的 A/B 实测（2026-11-17，批次 `pcdn-diag`）。
 *
 * ## 要回答什么
 *
 * 1. 开关打开后，**实际请求的 host 真的从 PCDN 换到官方了吗**（= 有效性）；
 * 2. **播放体验变好还是变差**（卡顿次数、起播耗时、换线次数）。
 *
 * ## 设计（照主理人的要求，不许改）
 *
 * | 项 | 做法 |
 * | --- | --- |
 * | 样本 | 8 个有 2160p 的视频（沿用 `REPORT-remaining.md` 那批） |
 * | 每 run | 固定手动 2160p，播 **120 秒** |
 * | 分组 | A=开关关，B=开关开 |
 * | 顺序 | **交替** `A1 B1 A2 B2 …` —— 半小时里网络会漂，分组跑会把"晚高峰"错算成"开关副作用" |
 * | 每 run 新页面 | 换开关后必须重载：`cfg` 随页面下发 |
 *
 * ## 闸门（缺一条这组数据就没意义）
 *
 * - B 组必须看到 `pcdn-filter-stats` 的 `applied === true`
 * - 起播位置都是 0、同一画质（2160p）
 * - 每 run 全新页面
 *
 * ## 两个"没料到"的设计约束（都是实测踩出来的）
 *
 * ### 1. `filter.applied` 不是"开关开着"，是"这次真的改动了候选"
 *
 * `main-world.js` 的 `reportPcdnFilter()` 里是 `applied: stats.changed === true`。
 * 所以**一条候选都不需要剔除时 `applied` 会是 `false`** —— 那是"没东西可剔"，
 * 不是"规则没下发"。本脚本把 `reason` 一起记下来区分这两种：
 * `rulesMissing` 才是闸门失败，`applied:false + 无 reason` 是"该视频本来就没 PCDN"。
 *
 * ### 2. 单次 `evaluate` 必须短，采样放页面里
 *
 * 长阻塞的 evaluate 会饿死扩展心跳，daemon 把浏览器判失联、会话全丢
 * （daemon 日志 `reaping unresponsive browser`）。所以：页面里挂
 * `PerformanceObserver` + 事件监听，Node 侧每 2 秒短读一次。
 *
 * ## 数据来源：自己量，不靠面板
 *
 * | 指标 | 来源 |
 * | --- | --- |
 * | 分片 host 分布 | 页面 `PerformanceObserver`（`resource` 条目，逐条） |
 * | 卡顿次数 | `<video>` 的 `waiting` 事件 |
 * | 起播耗时 | 第一条 `canplay` 的 `performance.now()` |
 * | 换线次数 | 媒体请求的 host 序列里"相邻不同"的次数（与 `detectSwitches` 同口径） |
 * | `filter.applied` / `removed` | 主世界 `postMessage` 的 `pcdn-filter-stats` |
 *
 * 用法：
 *
 * ```bash
 * npx tsx poc/probe/pcdn-diag/ab-filter.mjs            # 全量 8 个视频
 * npx tsx poc/probe/pcdn-diag/ab-filter.mjs --videos 1 --seconds 30   # 冒烟（1 个视频 30 秒）
 * ```
 *
 * 产出：stdout 进度 + `ab-filter.json`（gitignored）+ `REPORT-ab-filter.md` 由人读。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { classifyCdn } from '../../../src/core/cdn/classify.ts';

/** 实测样本（`REPORT-remaining.md` §2 那 8 个，全部确认有 2160p 轨） */
const VIDEOS = [
  'BV1oFsW6oEs5',
  'BV1avsP6wE8H',
  'BV1Z7sp6xEUn',
  'BV1wZWX6mEr9',
  'BV1PisN6nEF2',
  'BV1UcsP6sEzD',
  'BV1wasc6qEjc',
  'BV1jisJ62ERd',
];

const OUT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  'ab-filter.json',
);

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const RUN_SECONDS = argOf('--seconds', 120);
/** 冒烟用：跳过开关（构建未生效时也能验采集链路） */
const SKIP_SWITCH = process.argv.includes('--no-switch');
/** 只跑某一组（自检用，例：`--groups A`）；正式跑不要给 */
const GROUPS = (() => {
  const i = process.argv.indexOf('--groups');
  return i >= 0 ? String(process.argv[i + 1] || 'AB').toUpperCase() : 'AB';
})();
const VIDEO_LIMIT = argOf('--videos', VIDEOS.length);

// ───────────────────────── bsk 封装 ─────────────────────────

function bsk(args, { json = false } = {}) {
  let out = '';
  try {
    out = execFileSync('bsk', args, {
      encoding: 'utf8',
      env: { ...process.env, BSK_AUTO_START: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`bsk ${args[0]} 失败：\n${e.stderr || e.stdout || e.message}`);
  }
  if (!json) return out.trim();
  return JSON.parse(out.slice(out.indexOf('{')));
}

let cached = null;

/** 会话/标签页/ctx：缓存，失败才重新 sync（`sync` 很重，会饿死心跳） */
function current() {
  if (cached) return cached;
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      const s = bsk(['sync', '--json'], { json: true });
      cached = { session: s.session_id, tab: s.tab_id, ctx: s.ctx };
      return cached;
    } catch (e) {
      last = e;
      try {
        bsk(['wait-ms', '2000']);
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

function evaluate(expression) {
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      const cur = current();
      const out = bsk([
        'evaluate', '--session', cur.session, '--tab-id', String(cur.tab), '--context', cur.ctx,
        '--expect', '[{"target":"body","field":"exists","equals":true}]', expression,
      ]);
      const parsed = JSON.parse(out.slice(out.indexOf('{')));
      return parsed && parsed.value !== undefined ? parsed.value : parsed;
    } catch (e) {
      last = e;
      cached = null;
      try {
        bsk(['wait-ms', '1500']);
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

/**
 * 代理窗口里还活着的标签页 id 列表。
 *
 * ⚠️ **代理窗口里至少得留一个标签页**：`bsk tab create` 是从"当前可见文档"出发的动作，
 * 一个都不剩时报 `No observable document in this tab`，此后连新标签页都开不出来。
 * 所以实验期间常驻一个**控制页**（首页），只关 run 页。
 */
function agentTabs() {
  try {
    const out = bsk(['tab', 'list']);
    return out
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c[1] === 'agent')
      .map((c) => Number(c[0]));
  } catch {
    return [];
  }
}

/** 确保还有可操作的标签页；一个都没有就重开一个会话（`open` 只能从零开） */
function ensureControlTab() {
  if (agentTabs().length > 0) return;
  try {
    bsk(['close']);
  } catch {
    /* 没有会话也无所谓 */
  }
  cached = null;
  bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '80']);
  cached = null;
}

function ensureSession() {
  try {
    return current();
  } catch {
    for (let i = 0; i < 3; i += 1) {
      try {
        bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '80']);
        cached = null;
        return current();
      } catch {
        /* 再试 */
      }
    }
    throw new Error('无法建立 bsk 会话');
  }
}

/** 新建标签页加载页面（`tab create` 不需要严格观测） */
function openPage(url) {
  ensureSession();
  ensureControlTab();
  let created = null;
  /**
   * 退避重试：B站 首页常驻几个第三方 iframe（广告 / 消息 / header_sync），
   * 它们偶尔"忙"，`tab create` 会报 `A page frame is not responding:<id>`。
   * 这类是**可恢复**的（文档：a busy frame can recover），等一两秒再来即可。
   */
  for (let i = 0; i < 4; i += 1) {
    const cur = current();
    try {
      created = bsk(
        [
          'tab', 'create', '--url', url, '--session', cur.session, '--context', cur.ctx,
          '--expect', '[{"target":"body","field":"exists","equals":true}]', '--json',
        ],
        { json: true },
      );
      break;
    } catch (e) {
      const msg = String(e.message || e);
      process.stdout.write(`    · tab create 失败（第${i + 1}次）：${msg.split('\n')[1] || msg.slice(0, 60)}\n`);
      cached = null;
      bsk(['wait-ms', String(2500 + i * 1500)]);
      if (i === 2) {
        // 兜底：整段会话重开（`open` 只能从零开），控制页随后由 setSwitch 重新开面板
        try {
          bsk(['close']);
        } catch {
          /* ignore */
        }
        cached = null;
        bsk(['open', '--no-focus', 'https://www.bilibili.com/', '--json', '--max-tokens', '80']);
        cached = null;
      }
    }
  }
  if (!created) throw new Error(`tab create 连续失败，无法加载 ${url}`);
  const tabId = Number(created.tab_id);
  const s = bsk(['sync', '--json'], { json: true });
  cached = { session: s.session_id, tab: tabId, ctx: s.ctx };
  return cached;
}

function closeTab(tabId) {
  try {
    bsk(['tab', 'close', String(tabId), '--json']);
  } catch {
    /* 关不掉不影响数据 */
  }
  cached = null;
  // 关掉之后活动页会落回控制页；万一这是最后一个标签页，下一次 openPage 会重建会话
  if (agentTabs().length === 0) ensureControlTab();
}

// ───────────────────── 开关：走面板 VOM（closed shadow 只能 ref） ─────────────────────

/**
 * 在面板 VOM 里按**角色 + 引号内的文案**找控件。
 *
 * ⚠️ 两个必须做对的地方，都是实测踩出来的：
 *
 * 1. **必须带角色**：`显示` 同时出现在「显示」Tab、`页内显示` 分组、弹幕设置的
 *    `显示区域 25%` 里，只按文案找会点错控件。
 * 2. **必须匹配引号内的文案**（`@eN checkbox "屏蔽 PCDN 线路…"`），不能用
 *    `line.includes(label)`：VOM 里每个控件的 `[ctx: …]` 会把**整页文案**重复一遍，
 *    于是「页内角标」那个 checkbox 的行里也含「屏蔽 PCDN 线路」。
 *    本轮实测因此点错了开关（把用户的「页内角标」关掉了，已恢复）。
 *
 * @param role VOM 角色（`checkbox` / `tab` / `button`）
 * @param label 引号内文案的前缀
 */
function findByRole(role, label) {
  const text = bsk(['snapshot']);
  const pat = new RegExp(`(@e\\d+)\\s+${role}\\s+"${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  for (const line of text.split('\n')) {
    const m = pat.exec(line);
    if (m) {
      return {
        ref: m[1],
        checked: role === 'checkbox' ? /\[checked\]/.test(line) : null,
        line: line.trim().slice(0, 140),
      };
    }
  }
  return null;
}

/** 兼容旧调用：读某个开关（checkbox 优先） */
function panelControl(label) {
  return findByRole('checkbox', label);
}

/** 点一个 ref（target policy：`--expect` 声明事实即可，不需要严格观测） */
function clickRef(ref) {
  /**
   * ⚠️ **每次点击前强制重新 sync**：`click` 消费 ctx，而且点开面板本身会改变
   * 控制状态（`cooperation_sync_required`）。用缓存 ctx 会稳定失败 ——
   * 本轮实测：入口点开之后，「显示」Tab 连点 5 次全是 `permission_denied`。
   * 拨开关都在控制页（首页）上做，sync 很便宜。
   */
  cached = null;
  const cur = current();
  let out = '';
  try {
    out = bsk([
      'click', '--context', cur.ctx,
      '--expect', JSON.stringify([{ target: ref, field: 'exists', equals: true }]),
      ref, '--json',
    ]);
  } catch (e) {
    // `target_moved` 之类是可重试的：把错误码原样返回，让 setSwitch 再拨一轮
    const msg = String(e.message || e);
    const code = (msg.match(/"code": "([^"]+)"/) || [])[1] || 'error';
    const reason = (msg.match(/"reason": "([^"]+)"/) || [])[1] || '';
    return { code, reason };
  } finally {
    cached = null; // 点完状态变了，下次重新取 ctx
  }
  try {
    return JSON.parse(out.slice(out.indexOf('{')));
  } catch {
    return { code: 'ok' };
  }
}

/**
 * 把「屏蔽 PCDN 线路」拨到想要的状态。
 *
 * 开关是**全局 storage**，所以在固定的控制页（首页 + 面板打开）上反复拨即可，
 * 不必每次开视频页。拨完等 1 秒再开新页面（避免与 storage 写入竞态）。
 *
 * @param want true = 开（B 组），false = 关（A 组）
 */
function setSwitch(want) {
  for (let i = 0; i < 8; i += 1) {
    let ctl = findByRole('checkbox', '屏蔽 PCDN');
    if (!ctl) {
      const entry = findByRole('button', '打开 Pluma 面板');
      process.stdout.write(`    · 第${i + 1}轮：面板未开（入口 ref=${entry ? entry.ref : 'null'}）\n`);
      if (entry) {
        const r = clickRef(entry.ref);
        process.stdout.write(`      click 入口 → ${r.code || 'ok'}${r.reason ? '/' + r.reason : ''}\n`);
        bsk(['wait-ms', '900']);
      }
      ctl = findByRole('checkbox', '屏蔽 PCDN');
    }
    if (!ctl) {
      const tab = findByRole('tab', '显示');
      process.stdout.write(`    · 切「显示」Tab：ref=${tab ? tab.ref : 'null'}\n`);
      if (tab) {
        const r = clickRef(tab.ref);
        process.stdout.write(`      click Tab → ${r.code || 'ok'}\n`);
        bsk(['wait-ms', '700']);
        ctl = findByRole('checkbox', '屏蔽 PCDN');
      }
    }
    if (!ctl) {
      process.stdout.write(`    · 还是找不到「屏蔽 PCDN 线路」这一行\n`);
      continue;
    }
    process.stdout.write(`    · 读到 checked=${ctl.checked}（目标 ${want}）\n`);
    if (ctl.checked === want) return { ok: true, state: want, read: ctl.checked, line: ctl.line };
    const r = clickRef(ctl.ref);
    process.stdout.write(`      click 开关 → ${r.code || 'ok'}\n`);
    bsk(['wait-ms', '900']);
    const after = findByRole('checkbox', '屏蔽 PCDN');
    if (after && after.checked === want) {
      return { ok: true, state: want, read: after.checked, line: after.line };
    }
    process.stdout.write(`    · 拨后读到 ${after ? after.checked : 'null'}，重试\n`);
  }
  return { ok: false, state: want };
}

// ───────────────────── 页面侧探针（装得越早越好） ─────────────────────

/** 装探针：媒体请求 + video 事件 + 主世界过滤统计 */
const exprInstallProbe = `(() => {
  const KEY = '__abProbe';
  if (window[KEY] && window[KEY].installed) return { reused: true };
  const P = (window[KEY] = { installed: true, at: Math.round(performance.now()),
    media: [], events: [], stats: [], video: null, attached: false,
    readyAt: null, readyAt4: null, installAt: Math.round(performance.now()),
    ctStart: null });
  const MEDIA_RE = /bilivideo|mcdn|mountaintoys|akamaized|szbdyd|zhenidc|qrstuvwxyzab/;
  /** 分片文件名后缀（dash 是 .m4s；durl 老格式是 .flv/.mp4；HLS 是 .ts） */
  const SEG_RE = /\.(m4s|mp4|flv|ts)$/;

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        let u = null;
        try { u = new URL(e.name); } catch (x) { u = null; continue; }
        /**
         * 只认**分片请求**：host 命中取流域 **且** pathname 以分片后缀结尾。
         *
         * 只按 host 匹配会把 data.bilibili.com/log/web?... 收进来 ——
         * 那是埋点上报，它的 query 里恰好嵌着 bilivideo 的完整 URL，
         * 于是按整个 name 匹配 MEDIA_RE 会命中，实测 25/47 条请求被算成 unknown，
         * 直接把"PCDN 占比"稀释掉一半。
         */
        if (!MEDIA_RE.test(u.host)) continue;
        if (!SEG_RE.test(u.pathname)) continue;
        P.media.push({
          name: e.name.split('?')[0],
          host: u ? u.host : 'bad',
          search: u ? u.search : '',
          os: u ? (u.searchParams.get('os') || '') : '',
          t: Math.round(e.startTime),
        });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { P.observerError = String(e); }

  // video 元素可能还没建好 → 轮询挂事件（一次挂上就停）
  P.timer = setInterval(() => {
    const v = document.querySelector('video');
    if (!v) return;
    if (P.video !== v) {
      P.video = v;
      P.attached = true;
      for (const type of ['canplay', 'playing', 'waiting', 'error', 'stalled']) {
        v.addEventListener(type, () => {
          P.events.push({ type, t: Math.round(performance.now()), readyState: v.readyState,
            height: v.videoHeight, err: v.error ? v.error.code : null });
        });
      }
    }
    // 能播时刻：以 performance.now() 为轴，它就是"相对 navigationStart"的毫秒数
    // （performance.timeOrigin = 本文档导航开始）。轮询比事件稳：探针装得晚也能补上。
    if (P.readyAt === null && v.readyState >= 3) P.readyAt = Math.round(performance.now());
    if (P.readyAt4 === null && v.readyState === 4) P.readyAt4 = Math.round(performance.now());

    /**
     * ## 保活：后台标签页会停
     *
     * 实测（2026-11-17，本脚本第一版）：120 秒窗口跑完 video.currentTime 只有 **2 秒** ——
     * 播放器起来后自己停了（agent 窗口不在前台），于是"120 秒里 0 次卡顿"是因为
     * **根本没在播**。stall 数在这种 run 里毫无意义，必须单独判死。
     * 这里每 150ms 检查一次，停了就静音续播。
     */
    if (P.keepAlive !== false) {
      try {
        /**
         * ⚠️ **不要静音**。实测（同日）：静音 + 后台标签页会让 Chrome 把媒体管线挂起 ——
         * 45 秒窗口里 currentTime 只在 0→2.3 秒之间反复，13.5 秒一次
         * 每 13.5 秒一次 waiting → canplay → playing，看着像"网络卡"，其实是标签页被节流。
         * 保留页面原本的静音状态，只在 paused 时续播。
         */
        if (v.paused && v.readyState >= 2) {
          const pr = v.play();
          if (pr && pr.catch) pr.catch(() => {});
          P.resumes = (P.resumes || 0) + 1;
        }
      } catch (e) { P.keepAliveError = String(e); }
    }
    // 播放起点：页面内自己记，避免 Node 侧"起点读晚了/读错标签页"导致算不出实播秒
    if (P.ctStart === null && v.readyState >= 2 && v.currentTime > 0) P.ctStart = v.currentTime;
    P.ct = v.currentTime;
  }, 150);

  // 主世界的过滤统计（ADR 0038）：一次播放最多几条
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__ns !== '__PLUMA__' || d.type !== 'pcdn-filter-stats') return;
    P.stats.push({ applied: d.applied === true, removed: d.removed || 0,
      keptIntact: d.keptIntact || 0, where: d.where || null, reason: d.reason || null,
      at: Math.round(performance.now()) });
  });
  return { installed: true };
})()`;

const exprEnv = `(() => {
  const v = document.querySelector('video');
  return { video: !!v, player: !!(window.player && window.player.getMediaInfo),
    readyState: v ? v.readyState : null, height: v ? v.videoHeight : null };
})()`;

/** 强制 2160p（画质菜单在 DOM 里，JS 直接点比 bsk click 稳） */
const exprForce4k = `(() => {
  const cur = window.player && window.player.getQuality ? window.player.getQuality() : null;
  if (cur && cur.nowQ === 120) return { already4k: true };
  const item = Array.from(document.querySelectorAll('.bpx-player-ctrl-quality-menu-item'))
    .find((e) => (e.textContent || '').includes('4K'));
  if (!item) return { clicked: false, reason: 'no 4K item', cur };
  item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return { clicked: true, before: cur };
})()`;

/** 读当前累计数据（短，可反复调） */
const exprRead = `(() => {
  const P = window.__abProbe;
  if (!P) return { missing: true };
  const v = document.querySelector('video');
  const hosts = {};
  for (const m of P.media) hosts[m.host] = (hosts[m.host] || 0) + 1;
  // 换线次数：媒体 host 序列里"相邻不同"的次数
  let switches = 0;
  for (let i = 1; i < P.media.length; i += 1) if (P.media[i].host !== P.media[i - 1].host) switches += 1;
  const first = (type) => { const e = P.events.find((x) => x.type === type); return e ? e.t : null; };
  const nav = (performance.getEntriesByType('navigation') || [])[0] || null;
  return {
    at: Math.round(performance.now()),
    navStart: 0,
    navResponseEnd: nav ? Math.round(nav.responseEnd) : null,
    // 相对量：performance.now() 本身就是"相对 navigationStart"的毫秒数
    readyAt: P.readyAt,
    readyAt4: P.readyAt4,
    ctStart: P.ctStart,
    ct: P.ct === undefined ? null : P.ct,
    installAt: P.installAt,
    // 探针装得比 readyAt 还晚 ⇒ 这一 run 的起播时刻不可信，直接标出来
    canplayMissed: P.readyAt !== null && P.installAt > P.readyAt,
    mediaCount: P.media.length,
    hosts,
    seq: P.media.map((m) => m.host + '|' + m.os),
    events: P.events.slice(),
    stats: P.stats.slice(),
    switches,
    canplayT: first('canplay'),
    playingT: first('playing'),
    canplayCount: P.events.filter((e) => e.type === 'canplay').length,
    stalls: P.events.filter((e) => e.type === 'waiting' || e.type === 'stalled').length,
    errors: P.events.filter((e) => e.type === 'error').map((e) => e.err),
    video: v ? { readyState: v.readyState, height: v.videoHeight, width: v.videoWidth,
      currentTime: v.currentTime, paused: v.paused, muted: v.muted,
      error: v.error ? v.error.code : null } : null,
    resumes: P.resumes || 0,
    quality: window.player && window.player.getQuality ? window.player.getQuality() : null,
    attached: P.attached,
    media: P.media.slice(),
  };
})()`;

/** run 末尾若一条 `pcdn-filter-stats` 都没抓到，逼播放器重发一次 playurl 补抓闸门 */
const exprForcePlayurl = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try { window.player.disconnect(); } catch (e) {}
  await sleep(800);
  try { window.player.connect(); } catch (e) {}
  await sleep(2500);
  const P = window.__abProbe;
  return { stats: P ? P.stats.slice() : [], forced: true };
})()`;

// ───────────────────────── 单次 run ─────────────────────────

/**
 * 一个 run：新页面 → 装探针 → 强制 4K → 播 N 秒 → 收数据。
 *
 * @param bvid 视频号
 * @param group 'A'（开关关）| 'B'（开关开）
 * @returns run 结果
 */
function runOne(bvid, group) {
  const tab = openPage(`https://www.bilibili.com/video/${bvid}/`);
  const startedAt = new Date().toISOString();

  // 装探针尽量早（首屏 playurl 约在 1.4s，赶不上也没关系：本脚本主要看 120 秒里的分片）
  evaluate(exprInstallProbe);

  let env = null;
  for (let i = 0; i < 20; i += 1) {
    env = evaluate(exprEnv);
    if (env && env.readyState !== null && env.video) break;
    bsk(['wait-ms', '1200']);
  }

  const q4k = evaluate(exprForce4k);

  // 等到真正能播（readyState>=3），最多 30 秒
  for (let i = 0; i < 15; i += 1) {
    const e = evaluate(exprEnv);
    if (e && e.readyState >= 3) break;
    bsk(['wait-ms', '2000']);
  }

  // 播放窗口：先记下起点播放进度，末尾算"真的播了多少秒"
  const pre = evaluate(exprRead);
  const ctStart = pre && pre.video ? pre.video.currentTime : null;
  const playStart = Date.now();
  while (Date.now() - playStart < RUN_SECONDS * 1000) {
    bsk(['wait-ms', '4000']);
  }

  let snap = evaluate(exprRead);
  const c0 = snap && snap.ctStart !== undefined && snap.ctStart !== null ? snap.ctStart : ctStart;
  const c1 = snap && snap.ct !== undefined && snap.ct !== null ? snap.ct : null;
  snap.playedSeconds = c0 === null || c1 === null ? null : Math.round((c1 - c0) * 10) / 10;
  let gate = { forced: false };
  const hasStats = (snap.stats || []).length > 0;
  if (!hasStats) {
    gate = evaluate(exprForcePlayurl);
    snap = evaluate(exprRead);
  }

  closeTab(tab.tab);

  return {
    bvid, group, startedAt, seconds: RUN_SECONDS,
    env, q4k, forcedGate: gate.forced === true,
    ...snap,
  };
}

// ───────────────────────── 汇总裁剪 ─────────────────────────

/** 把 `host|os` 判成线路（用生产函数，第二参数别漏） */
function classify(host, os) {
  return classifyCdn(host, os ? `os=${os}` : undefined).cls;
}

/**
 * 一个 run 的观测量：PCDN / 官方请求占比、stall、canplay、换线次数。
 *
 * ⚠️ 占比按**分片请求条数**算，不是按候选数 —— 这才是"流量去了哪"。
 *
 * @param run `runOne()` 的返回
 */
function summarize(run) {
  const per = { pcdn: 0, official: 0, 'third-party': 0, unknown: 0 };
  const detail = [];
  const byHost = {};
  for (const m of run.media || []) {
    const cls = classify(m.host, m.search || (m.os ? `os=${m.os}` : ''));
    per[cls] += 1;
    const h = (byHost[m.host] ||= { host: m.host, cls, n: 0, sampleSearch: (m.search || '').slice(0, 60) });
    h.n += 1;
    if (detail.length < 6) detail.push({ host: m.host, cls, search: (m.search || '').slice(0, 60) });
  }
  const hostsDetail = Object.values(byHost).sort((a, b) => b.n - a.n);
  const total = per.pcdn + per.official + per['third-party'] + per.unknown;
  const stats = run.stats || [];
  return {
    bvid: run.bvid,
    group: run.group,
    requests: total,
    pcdnShare: total ? per.pcdn / total : null,
    officialShare: total ? per.official / total : null,
    per,
    hostsDetail,
    classifiedSample: detail,
    pcdnHosts: hostsDetail.filter((h) => h.cls === 'pcdn').map((h) => h.host),
    stalls: run.stalls || 0,
    /** 这个窗口里视频**真的播了多少秒**（ctEnd - ctStart）。远小于窗口 ⇒ 这一 run 作废 */
    playedSeconds: run.playedSeconds === undefined ? null : run.playedSeconds,
    playOk: run.playedSeconds !== null && run.playedSeconds !== undefined
      ? run.playedSeconds >= RUN_SECONDS * 0.8
      : false,
    resumes: run.resumes || 0,
    /** 相对 navigationStart 的"能播"时刻（ms）—— 跨 run 可比，不是绝对时间戳 */
    readyAt: run.readyAt === null || run.readyAt === undefined ? null : run.readyAt,
    readyAt4: run.readyAt4 === null || run.readyAt4 === undefined ? null : run.readyAt4,
    navResponseEnd: run.navResponseEnd === undefined ? null : run.navResponseEnd,
    canplayMissed: run.canplayMissed === true,
    canplayCount: run.canplayCount === undefined ? null : run.canplayCount,
    canplayT: run.canplayT,
    switches: run.switches || 0,
    height: run.video ? run.video.height : null,
    readyState: run.video ? run.video.readyState : null,
    error: run.video ? run.video.error : null,
    /** 闸门：B 组必须 applied；`reason==='rulesMissing'` 才是真的失败 */
    filterApplied: stats.some((s) => s.applied === true),
    /**
     * 闸门判定。**A 组必须 `applied:false`，B 组必须 `applied:true`** ——
     * 不满足就说明开关没拨到位（或规则没下发），这一 run 直接作废，不许进汇总。
     */
    gateOk:
      (run.group === 'A'
        ? !stats.some((s) => s.applied === true)
        : stats.some((s) => s.applied === true)) &&
      // 没真的播起来 ⇒ stall / 占比都不可比，直接作废
      (run.playedSeconds !== undefined && run.playedSeconds !== null
        ? run.playedSeconds >= RUN_SECONDS * 0.8
        : false),
    filterRemoved: stats.reduce((a, s) => a + (s.removed || 0), 0),
    filterKeptIntact: stats.reduce((a, s) => a + (s.keptIntact || 0), 0),
    filterReason: (stats.find((s) => s.reason) || {}).reason || null,
    statsCount: stats.length,
    forcedGate: run.forcedGate === true,
    /** 我方采集没有环形缓冲 ⇒ 窗口永远是完整的（与扩展采集器的 truncated 不是一回事） */
    windowTruncated: false,
  };
}

// ───────────────────────── 主流程 ─────────────────────────

ensureSession();
const result = {
  at: new Date().toISOString(),
  runSeconds: RUN_SECONDS,
  videos: VIDEOS.slice(0, VIDEO_LIMIT),
  order: [],
  runs: [],
  summary: [],
};

/** 先把面板打开（放在控制页上，整个实验只开一次） */
openPage('https://www.bilibili.com/');
bsk(['wait-ms', '2500']);
const opened = SKIP_SWITCH ? { ok: true, skipped: true } : setSwitch(false); // A 组基线：先确保开关是关的
result.switchInit = opened;
process.stdout.write(`开关初始化：${JSON.stringify(opened)}\n`);

for (const bvid of result.videos) {
  for (const group of ['A', 'B']) {
    if (!GROUPS.includes(group)) continue;
    const sw = SKIP_SWITCH ? { ok: true, skipped: true } : setSwitch(group === 'B');
    process.stdout.write(`\n[${bvid} ${group}] 开关=${group === 'B' ? '开' : '关'} → ${JSON.stringify(sw)}\n`);
    /**
     * ⚠️ **开关没拨到位就停下，不许跳过。**
     *
     * 跳过 = A/B 里少一个对照组，而这组实验唯一想量化的是"开关造成的差"。
     * 上一版把跳过当成"继续下一个"，结果 A 组跑的其实也是"过滤开着"，
     * 两组变成同一个状态 —— 那不是 A/B，是两次 B。
     */
    if (!sw.ok) {
      throw new Error(
        `开关拨不到「${group === 'B' ? '开' : '关'}」—— 面板里找不到「屏蔽 PCDN 线路」这一行。` +
          '这条实验没有对照组就没有意义，已停止。',
      );
      // eslint-disable-next-line no-unreachable
      continue;
    }
    bsk(['wait-ms', '1000']);
    let run = null;
    try {
      run = runOne(bvid, group);
    } catch (e) {
      process.stdout.write(`  ⚠️ run 失败：${String(e.message || e).slice(0, 160)}\n`);
      result.order.push({ bvid, group, error: String(e.message || e).slice(0, 200) });
      cached = null;
      continue;
    }
    result.runs.push(run);
    const sum = summarize(run);
    result.summary.push(sum);
    result.order.push({ bvid, group, ok: true });
    process.stdout.write(
      `  请求 ${sum.requests} 条 · per=${JSON.stringify(sum.per)}` +
        ` · stall ${sum.stalls} · 起播 ${sum.readyAt === null ? '—' : (sum.readyAt / 1000).toFixed(2) + 's'}` +
        ` · 换线 ${sum.switches} · 高度=${sum.height} · 实播=${sum.playedSeconds}s` +
        ` · applied=${sum.filterApplied}` +
        ` · gate=${sum.gateOk ? 'OK' : '**作废**'}` +
        `${sum.canplayMissed ? ' (探针装晚了)' : ''}${sum.forcedGate ? ' (补抓)' : ''}\n`,
    );
    if (!sum.gateOk) {
      process.stdout.write(
        `  ⚠️ 闸门失败：${group} 组 applied=${sum.filterApplied}（A 组必须 false、B 组必须 true）\n`,
      );
    }
    // 每跑完一条就落盘：跑不完也有数据
    writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    bsk(['wait-ms', '1500']);
  }
}

writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
process.stdout.write(`\n已写出 ${OUT}\n`);
