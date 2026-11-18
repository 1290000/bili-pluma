/**
 * 候选改写：把每一条轨里**属于 PCDN 的候选 authority 换成官方镜像**（ADR 0039）。
 *
 * 分层：`core/` 纯函数，零 IO、零浏览器 API，可在 Node 里全覆盖
 * （`chrome` / `window` / `document` / `fetch(` 一律不许出现，
 * ESLint 与 `scripts/check-boundaries.ts` 两道都会红）。
 *
 * ## 这个模块守的是什么
 *
 * 守的是 **ADR 0039 的八条硬边界**。它升级了 ADR 0038 的"删除"路线：
 * 那一类只做减法，这一类**换 authority 但一条候选都不增删**。所以失败方向变了：
 *
 * - 该换没换 → 用户照旧走 PCDN，**界面上一切正常**（静默失败，与 classify 同源）；
 * - 换错（动了 path / 凭空拼签名 / 改了条数）→ 403 或"少一条备份"，
 *   后者**只在故障那天**才被发现。
 *
 * 第二种仍更贵，所以本模块的每一条判据都偏向**保守**：判不了就别改。
 *
 * ## 不许商量的写法（对应 ADR 0039「决定」与八条边界）
 *
 * 1. **只换 `cls === 'pcdn'`。** `official` / `third-party` / **`unknown` 全原样**
 *    （边界 3）。ADR 0039 的立法目的是"让流量不走 PCDN"，不是"只留白名单"。
 * 2. **只换 authority**（`host` 含 port，`protocol` 保持）；`pathname` / `search` /
 *    `hash` **一字不动**（边界 1）。同路径可互换是换 host 成立的全部前提。
 * 3. **唯一允许改变 URL 结构的例外**：path 命中 `proxyPathPrefix` 的 PCDN 候选，
 *    改成 `https://<proxyHost>?url=<encodeURIComponent(原 URL)>`（边界 7）。
 *    扩大这个前缀就等于"任意 URL 重写"。
 * 4. **候选条数严格不变**（边界 2）：`base` + `backups` 展开后逐条原位写回，
 *    不删、不排、不增。这正是相对"删除"路线的核心收益（备份全留）。
 * 5. **换不了的候选原样保留**（边界 5）：`new URL()` 抛错、规则缺项，
 *    一律 `fallbackKept++` 并返回原串。制造坏 URL 比静默不换更糟。
 * 6. **镜像清单与 proxy 模板经 `cfg` 下发**（边界 6）：本文件只提供默认值供 ISOLATED
 *    下发，主世界裸 JS 里一个域名都不许写死。漂移的表现是"开关开着仍走 PCDN"。
 * 7. **分类必须传两个参数**：`classifyCdn(host, search)`。`search` 是 `os=mcdn`
 *    那条判据的唯一输入（官方镜像也会代理 mcdn 资源）。
 * 8. **其余字段一字不动**（边界 3/4）：`quality` / `height` / `codecid` / 带宽 /
 *    轨数 / 权益字段全部透传；本模块只写四个候选字段。
 *
 * ## 字段命名风格必须跟着输入走
 *
 * B站 两种形态都出现过：`base_url` / `backup_url`（下划线）与 `baseUrl` / `backupUrl`
 * （驼峰）。**输出必须与输入同风格** —— 混用会让播放器按另一个名字读到 `undefined`，
 * 表现为"某条轨没有流"。
 *
 * ## 默认值的性质
 *
 * `DEFAULT_REWRITE_RULES` 只是**下发用的种子值**，不是主世界的判据来源；
 * 主世界只认 `cfg` 带来的运行时值（`pcdnRewriteRules === null` 时一条都不改）。
 *
 * @see docs/decisions/0039-rewrite-pcdn-authority.md
 */

import { classifyCdn } from './classify';

/**
 * 一条轨里与本模块有关的四个字段。
 *
 * 其余字段（`quality` / `height` / `codecid` / `bandwidth` / `duration` / …）
 * **一律透传、一个都不改** —— 那是 ADR 0039 边界 3/4 的原文。
 */
export interface CandidateTrack {
  /** 首选候选（下划线风格） */
  base_url?: string;
  /** 首选候选（驼峰风格） */
  baseUrl?: string;
  /** 备选候选（下划线风格） */
  backup_url?: string[];
  /** 备选候选（驼峰风格） */
  backupUrl?: string[];
}

/**
 * 换 authority 需要的三条规则（与 `PCDN_RULES` 一样经 `cfg` 下发到主世界）。
 *
 * 三个字段都是非空字符串才生效；缺任何一项 → 该条原样保留（`fallbackKept`）。
 */
export interface RewriteRules {
  /** PCDN 候选换到的官方镜像 host（含 port 时一并替换原 host） */
  mirrorHost: string;
  /** 命中 `proxyPathPrefix` 的候选改走这个官方代理 */
  proxyHost: string;
  /** 只有 path 含此前缀的 PCDN 才走 proxy 包装（ADR 0039 边界 7） */
  proxyPathPrefix: string;
}

/**
 * 默认规则 —— ADR 0039「决定」节实测过的那一组。
 *
 * ⚠️ 这是**唯一**允许出现镜像 / proxy 域名的地方（`core/cdn`，纯数据）；
 * 主世界不得复制，只经 `cfg` 收到它。`verifier-rewrite` 的命中率验证若改了
 * 默认镜像选择，改这里 + ADR，不要在主世界加第二份。
 */
export const DEFAULT_REWRITE_RULES: RewriteRules = {
  mirrorHost: 'upos-sz-mirrorhw.bilivideo.com',
  proxyHost: 'proxy-tf-all-ws.bilivideo.com',
  proxyPathPrefix: '/v1/resource/upgcxcode/',
};

/** 本次改写做了什么（诊断与测试都靠它，别省） */
export interface FilterStats {
  /** 真正换了 authority 的候选条数（`proxied` 的也计在这里） */
  rewritten: number;
  /** 其中走 proxy 包装的条数（ADR 0039 边界 7 的唯一例外） */
  proxied: number;
  /** 想换但换不了、原样保留的条数（解析失败 / 规则缺项） */
  fallbackKept: number;
}

/** 改写结果：轨列表 + 统计 */
export interface FilterResult<T extends CandidateTrack> {
  tracks: T[];
  stats: FilterStats;
}

/**
 * 过滤**没有生效**的原因（唯一一处定义，别处一律 `import type` 引用）。
 *
 * | 值 | 含义 |
 * | --- | --- |
 * | `'off'` | 用户没打开开关（默认状态） |
 * | `'rulesMissing'` | 开关开着，但判据规则没下发到主世界 —— 判定不了就不动响应体 |
 *
 * 定义在这里而不是各自内联：加新值时靠 tsc 找得到所有需要更新的地方，
 * 而三处手抄的联合类型加值时不会报错（`check-messages` 会红，但那只是兜底）。
 */
export type FilterSkipReason = 'rulesMissing' | 'off';

/** 候选字段用的是哪一套命名 */
type Naming = 'snake' | 'camel';

/**
 * 这条轨用的是哪套命名。
 *
 * 判据是"**哪个字段真的存在**"，不是"哪个更常见"：两种形态都出现过，
 * 认错了就会往一个播放器不读的键上写。
 *
 * 两套同时存在时（理论上不该发生）取**下划线**：`core/playinfo/parse.ts` 读的也是
 * `o.base_url ?? o.baseUrl`（先下划线），这里与它保持同一优先级。
 *
 * @returns 命名字段存在则返回风格；一条候选都没有则 `null`（调用方原样返回）
 */
function detectNaming(track: CandidateTrack): Naming | null {
  if (typeof track.base_url === 'string' || Array.isArray(track.backup_url)) return 'snake';
  if (typeof track.baseUrl === 'string' || Array.isArray(track.backupUrl)) return 'camel';
  return null;
}

/**
 * 把一条轨的候选摊平成数组（`[base, ...backups]`）。
 *
 * 空串不算候选（`parse.ts` 的 `str()` 也是这个口径：空串等于没有）。
 *
 * @param track 一条轨
 * @param naming 已判定的命名风格
 */
function candidatesOf(track: CandidateTrack, naming: Naming): string[] {
  const base = naming === 'snake' ? track.base_url : track.baseUrl;
  const backups = naming === 'snake' ? track.backup_url : track.backupUrl;

  const out: string[] = [];
  if (typeof base === 'string' && base.length > 0) out.push(base);
  if (Array.isArray(backups)) {
    for (const url of backups) {
      if (typeof url === 'string' && url.length > 0) out.push(url);
    }
  }
  return out;
}

/**
 * 规则是否完整可用（三个字段都是非空字符串）。
 *
 * `proxyPathPrefix` 也要求非空：空前缀会让**每一条** PCDN 都命中 proxy 分支，
 * 那就把"唯一例外"放大成了"默认行为"（ADR 0039 边界 7）。
 */
function rulesUsable(rules: RewriteRules | null | undefined): rules is RewriteRules {
  return (
    rules !== null &&
    rules !== undefined &&
    typeof rules.mirrorHost === 'string' &&
    rules.mirrorHost.length > 0 &&
    typeof rules.proxyHost === 'string' &&
    rules.proxyHost.length > 0 &&
    typeof rules.proxyPathPrefix === 'string' &&
    rules.proxyPathPrefix.length > 0
  );
}

/**
 * 改写一条候选 URL 的 authority。
 *
 * 顺序与主世界 `rewriteCandidateUrl()` 一一对应（接线测试逐条对账）：
 *
 * 1. `new URL()` 抛错 → `fallbackKept++`，原串返回；
 * 2. 非 PCDN（**必须传 `search`**）→ 原串返回，不计数；
 * 3. 规则缺项 → `fallbackKept++`，原串返回；
 * 4. path 含 `proxyPathPrefix` → proxy 包装（`proxied++` / `rewritten++`）；
 * 5. 其余 → 只改 `host`（含 port 一起换），`href` 序列化保留 path/search/hash。
 *
 * @param url 候选 URL 原文
 * @param rules 已下发的规则
 * @param stats 就地累加的统计
 * @returns 改写后的 URL；换不了时返回**原串**
 */
function rewriteOne(
  url: string,
  rules: RewriteRules | null | undefined,
  stats: FilterStats,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 边界 5：判不了就别改
    stats.fallbackKept += 1;
    return url;
  }

  // 只换 PCDN；search 必须传（os=mcdn 是官方镜像代理 mcdn 的唯一信号）
  if (classifyCdn(parsed.host, parsed.search).cls !== 'pcdn') return url;

  if (!rulesUsable(rules)) {
    stats.fallbackKept += 1;
    return url;
  }

  try {
    if (parsed.pathname.indexOf(rules.proxyPathPrefix) >= 0) {
      // 边界 7：唯一允许改变 URL 结构的例外
      stats.proxied += 1;
      stats.rewritten += 1;
      return `https://${rules.proxyHost}?url=${encodeURIComponent(url)}`;
    }
    // 边界 1：authority 整体换成 mirrorHost。⚠️ 只赋 `host` 会**保留原 port**
    // （`https://a:8082/x` → `.host='b'` 得到 `https://b:8082/x`），所以先用
    // mirrorHost 自身解析出目标 hostname/port，再分别赋值，port 为空时一并清掉。
    const target = new URL(`https://${rules.mirrorHost}/`);
    parsed.hostname = target.hostname;
    parsed.port = target.port;
    stats.rewritten += 1;
    return parsed.href;
  } catch {
    stats.fallbackKept += 1;
    return url;
  }
}

/**
 * 把改写后的候选写回一条**新**轨。
 *
 * ## 为什么是"展开 + 显式覆盖"而不是原地改
 *
 * - 入参不可变：调用前后 `deepEqual` 有测试钉着；
 * - 显式写这四个键，接线时静态检查（`check-patch-scope.mjs` 的写集断言）
 *   看得见"到底改了哪几个字段"；
 * - 条数由 `[first, ...rest]` 保证恒等于输入，不会删候选。
 *
 * 其它键由展开原样带过来，**一个都不动**。
 *
 * @param track 原轨（**不会被修改**）
 * @param naming 命名风格
 * @param candidates 改写后的候选（长度恒等于输入）
 */
function withCandidates<T extends CandidateTrack>(
  track: T,
  naming: Naming,
  candidates: readonly string[],
): T {
  const first = candidates[0] ?? '';
  const rest = candidates.slice(1);

  if (naming === 'snake') {
    return { ...track, base_url: first, backup_url: rest };
  }
  return { ...track, baseUrl: first, backupUrl: rest };
}

/**
 * 把每一条轨里**属于 PCDN** 的候选 authority 换成官方镜像（ADR 0039）。
 *
 * ## 算法（与 ADR 0039「决定」一节逐步对应）
 *
 * 1. 展开 `[baseUrl, ...backupUrl]`；
 * 2. 逐条分类（**必须传 `search`**），只有 `cls === 'pcdn'` 的才改写；
 * 3. path 命中 `proxyPathPrefix` → proxy 包装；否则只改 `host`；
 * 4. 解析失败 / 规则缺项 → 原样保留（`fallbackKept++`），**条数恒不变**；
 * 5. 其余字段原样透传；一条都没改写的轨返回**原对象**（引用相等，避免无谓 diff）。
 *
 * ## 纯函数
 *
 * 入参**不被修改**。统计在同一个 `stats` 对象上累加后一并返回。
 *
 * @param tracks 一批轨（`dash.video` 或 `dash.audio`）
 * @param rules 经 `cfg` 下发的规则
 * @returns 改写后的轨（未改动的轨是**原对象**）+ 统计
 */
export function rewritePcdnCandidates<T extends CandidateTrack>(
  tracks: readonly T[],
  rules: RewriteRules | null | undefined,
): FilterResult<T> {
  const stats: FilterStats = { rewritten: 0, proxied: 0, fallbackKept: 0 };

  const out = tracks.map((track) => {
    const naming = detectNaming(track);
    if (naming === null) return track;

    const candidates = candidatesOf(track, naming);
    if (candidates.length === 0) return track;

    const rewrittenCandidates = candidates.map((url) => rewriteOne(url, rules, stats));

    // 一条都没改 → 原对象（不制造无谓 diff；幂等性也靠它）
    for (let i = 0; i < candidates.length; i += 1) {
      if (rewrittenCandidates[i] !== candidates[i]) {
        return withCandidates(track, naming, rewrittenCandidates);
      }
    }
    return track;
  });

  return { tracks: out, stats };
}

/**
 * 旧名字的薄封装 —— **语义已按 ADR 0039 升级为"替换 authority"**，不再是删除。
 *
 * 保留它是为了避免接线处大改；默认规则用 `DEFAULT_REWRITE_RULES`（真实链路仍由
 * ISOLATED 经 `cfg` 下发运行时值）。新代码请直接用 `rewritePcdnCandidates()`。
 */
export function filterPcdnCandidates<T extends CandidateTrack>(
  tracks: readonly T[],
  rules: RewriteRules | null | undefined = DEFAULT_REWRITE_RULES,
): FilterResult<T> {
  return rewritePcdnCandidates(tracks, rules);
}

/** `rewriteDashOf()` 的结果：三个计数 + 「这一次到底改没改」 */
export interface DashFilterStats extends FilterStats {
  /** 真的动过至少一条候选（`false` = 整份 `dash` 原样，`holder.dash` 引用不变） */
  changed: boolean;
}

/**
 * 把一份 **`dash` 容器**（不是一个轨数组）里的 PCDN 候选换成官方镜像。
 *
 * ## 为什么要有这一层：容器有四个，形状各不一样
 *
 * `rewritePcdnCandidates()` 只认「一个轨数组」，而 B站 的 `dash` 里带候选地址的
 * 容器有**四个**，形状还不一致：
 *
 * | 容器 | 形状 | 外层的非候选字段 |
 * | --- | --- | --- |
 * | `dash.video` | track 数组 | — |
 * | `dash.audio` | track 数组 | — |
 * | `dash.flac.audio` | **单个** track 对象 | `dash.flac.display` 是布尔 |
 * | `dash.dolby.audio` | track 数组 | `dash.dolby.vision` 是布尔 |
 *
 * 只覆盖前两个的后果是**静默失败**：Hi-Res / 杜比全景声那几轨照旧走 PCDN，
 * 而开关是开着的、面板上一切正常 —— 正是 `classify.ts` 点名的「最坏失败方向」。
 *
 * ## 与主世界 `filterDashOf()` **逐条等价**，靠测试钉住
 *
 * 主世界（`src/content/main-world.js`）有一份自己的 `filterDashOf()`：它是裸 JS，
 * 不能 `import` 本文件。于是**同一套容器遍历存在两份实现**，这是既定现实
 * （ADR 0039 的决定：判据下沉 `core/`，主世界只经 `cfg` 收运行时值）。
 *
 * 两份必然漂移的那一天，表现是"开关开着却有一条路没过滤"。所以
 * `tests/unit/content/pcdn-filter-wiring.test.ts` 用同一批 fixture 同时喂两个实现，
 * 断言 `dash` 深相等 + 四个统计数相等 —— **任何一边单独动都会红**。
 *
 * ## 就地替换 `holder.dash`（与主世界一致）
 *
 * 调用点因此只需一行（见 `entrypoints/content.ts` 的 `prepareFullStream()`）。
 * 语义与边界（与主世界实现一字不差）：
 *
 * - **条数严格不变、只换 authority**，`pathname` / `search` / `hash` 不动（ADR 0039 边界 1/2）；
 * - 没改动的**轨返回原对象**；整份 `dash` 一条都没改时 `changed: false` 且
 *   **不碰 `holder.dash`**（不制造无谓 diff，也让"幂等"可断言）；
 * - 形状不对（缺 `dash` / `dash` 非对象 / `flac.audio` 非对象 / `dolby.audio` 非数组）
 *   → 该容器整块跳过，**不抛错**（边界 5：判不了就别改）；
 * - **`durl` / `durls` 一个字节都不碰**（FLV 那条路本轮不做，扩了要另写 ADR）；
 * - `flac.display` / `dolby.vision` / `dash.duration` 等非候选字段原样带过。
 *
 * @param holder 形如 `{ dash: {...} }` 的对象（**就地替换** `holder.dash`）
 * @param rules 改写规则（ISOLATED 侧直接传 `DEFAULT_REWRITE_RULES`）
 * @returns 三个计数 + `changed`（形状不对时全 0、`changed: false`）
 */
export function rewriteDashOf(
  holder: { dash?: unknown } | null | undefined,
  rules: RewriteRules | null | undefined,
): DashFilterStats {
  const none: DashFilterStats = { changed: false, rewritten: 0, proxied: 0, fallbackKept: 0 };
  if (!holder || typeof holder !== 'object') return none;

  const dashRaw: unknown = holder.dash;
  if (!dashRaw || typeof dashRaw !== 'object') return none; // 纯 durl 响应 → 原样
  const dash = dashRaw as Record<string, unknown>;

  const video = Array.isArray(dash.video) ? (dash.video as unknown[]) : null;
  const audio = Array.isArray(dash.audio) ? (dash.audio as unknown[]) : null;

  // flac 是**对象**、里面装**单个** track；`display` 等键原样带过
  let flacHolder: Record<string, unknown> | null = null;
  const flacRaw: unknown = dash.flac;
  if (flacRaw && typeof flacRaw === 'object' && !Array.isArray(flacRaw)) {
    const flacAudio: unknown = (flacRaw as Record<string, unknown>).audio;
    if (flacAudio && typeof flacAudio === 'object' && !Array.isArray(flacAudio)) {
      flacHolder = flacRaw as Record<string, unknown>;
    }
  }

  // dolby 是**对象**、里面的 `audio` 是**数组**；`vision` 等键原样带过
  let dolbyHolder: Record<string, unknown> | null = null;
  const dolbyRaw: unknown = dash.dolby;
  if (dolbyRaw && typeof dolbyRaw === 'object' && !Array.isArray(dolbyRaw)) {
    if (Array.isArray((dolbyRaw as Record<string, unknown>).audio)) {
      dolbyHolder = dolbyRaw as Record<string, unknown>;
    }
  }

  // 四个容器一个都没认出来（如 `{ dash: { duration: 1 } }`）→ 整块跳过
  if (video === null && audio === null && flacHolder === null && dolbyHolder === null) {
    return none;
  }

  const stats: DashFilterStats = { changed: false, rewritten: 0, proxied: 0, fallbackKept: 0 };

  const nextVideo = video === null ? null : rewriteTrackList(video, rules, stats);
  const nextAudio = audio === null ? null : rewriteTrackList(audio, rules, stats);

  // flac：单个 track —— 只在真的改了时才复制外层对象（不制造无谓 diff）
  let nextFlac: Record<string, unknown> | null = null;
  if (flacHolder !== null) {
    const before = flacHolder.audio;
    const after = rewriteTrackKeep(before, rules, stats);
    if (after !== before) nextFlac = { ...flacHolder, audio: after };
  }

  // dolby：track 数组 —— 逐条过滤，只在真的改了时才复制外层对象
  let nextDolby: Record<string, unknown> | null = null;
  if (dolbyHolder !== null) {
    const listBefore = dolbyHolder.audio as unknown[];
    const listAfter = rewriteTrackList(listBefore, rules, stats);
    // `rewriteTrackList()` 恒返回新数组，所以要另比一次元素身份才知道该不该复制外层
    const dolbyChanged = listAfter.some((t, i) => t !== listBefore[i]);
    if (dolbyChanged) nextDolby = { ...dolbyHolder, audio: listAfter };
  }

  // 一条都没改 → 计数照样返回（`fallbackKept` 可能是非零），但**不碰 holder.dash**
  if (!stats.changed) return stats;

  const nextDash: Record<string, unknown> = { ...dash };
  if (nextVideo !== null) nextDash.video = nextVideo;
  if (nextAudio !== null) nextDash.audio = nextAudio;
  if (nextFlac !== null) nextDash.flac = nextFlac;
  if (nextDolby !== null) nextDash.dolby = nextDolby;
  holder.dash = nextDash;
  return stats;
}

/**
 * 过滤一个轨数组，逐条走 `rewritePcdnCandidates()` 并把统计累加进 `stats`。
 *
 * @param tracks 轨数组（元素可能是任意形状，交给 `rewriteTrackKeep()` 兜底）
 * @param rules 改写规则
 * @param stats 就地累加（含 `changed`）
 * @returns 同长度的新数组（未改动的元素是**原引用**）
 */
function rewriteTrackList(
  tracks: readonly unknown[],
  rules: RewriteRules | null | undefined,
  stats: DashFilterStats,
): unknown[] {
  return tracks.map((track) => rewriteTrackKeep(track, rules, stats));
}

/**
 * 过滤**一条**轨，非对象原样返回。
 *
 * 主世界 `filterOneTrack()` 开头就有这道守卫（`!track || typeof track !== 'object'`）：
 * `rewritePcdnCandidates()` 没有，因为它声明成"一批轨"。容器遍历必须自己补上 ——
 * 否则 `dash.video: [null]` 这种畸形输入会在 `detectNaming()` 里抛 TypeError，
 * 而"不抛错"是 ADR 0039 边界 5 的硬要求。
 *
 * @param track 任意形状的元素
 * @param rules 改写规则
 * @param stats 就地累加
 * @returns 过滤后的轨；非对象 / 未改动时返回**原引用**
 */
function rewriteTrackKeep(
  track: unknown,
  rules: RewriteRules | null | undefined,
  stats: DashFilterStats,
): unknown {
  // ⚠️ 只挡"非对象"。**不挡数组**：主世界那份守卫写的是 `typeof track !== 'object'`，
  // 数组同样会进到 `filterOneTrack()`（然后在 `detectNaming()` 拿不到候选字段、
  // 原样返回）。这里若多挡一层，两实现在这种畸形输入下就分道扬镳了。
  if (track === null || typeof track !== 'object') return track;

  const single = rewritePcdnCandidates([track as CandidateTrack], rules);
  stats.rewritten += single.stats.rewritten;
  stats.proxied += single.stats.proxied;
  stats.fallbackKept += single.stats.fallbackKept;

  const out: unknown = single.tracks[0];
  if (out !== track) stats.changed = true;
  return out;
}
