/**
 * 候选过滤：从每一条轨的候选 URL 里**剔除 PCDN**（只减不增）。
 *
 * 分层：`core/` 纯函数，零 IO、零浏览器 API，可在 Node 里全覆盖
 * （`chrome` / `window` / `document` / `fetch(` 一律不许出现，
 * ESLint 与 `scripts/check-boundaries.ts` 两道都会红）。
 *
 * ## 这个模块守的是什么
 *
 * 守的是 **ADR 0038 的五条硬边界**。那一类改写与项目里前六类都不同：
 * 前六类**一个字节都不许碰 URL**，这一类**只**动 URL。所以它的失败方向是新的：
 *
 * - 少删一条 PCDN → 用户照旧走 PCDN，**界面上一切正常**（静默失败，与 classify 同源）；
 * - **多删**一条官方 / 认不出的候选 → 用户少一条备份线路，真出故障时无处可退，
 *   而且这个损失**只在故障那天**才被发现。
 *
 * 第二种比第一种更贵，因为它是"为了优化反而变差"。所以本模块的每一条判据都偏向
 * **保留**：判不了就留（见下面第 4 条）。
 *
 * ## 五条不许商量的写法
 *
 * 1. **只剔除 `cls === 'pcdn'`。** `official` / `third-party` / **`unknown` 全保留**。
 *    `unknown` 的含义是"我们认不出这个域" —— 把它删掉等于**拿未知换更少的备份**，
 *    而 ADR 0038 的立法目的是"少走 PCDN"，不是"只留白名单里的域"。
 * 2. **剔除后一条不剩 → 整条轨原样返回**（ADR 0038 硬边界第 5 条）。
 *    删掉那条轨 = 用户点了 4K 却没有 4K，会直接黑屏/切换失败 —— 宁可照旧走 PCDN。
 * 3. **不许新增任何 URL。** 只做减法：`removed` 只减不增，候选条数只能不变或减少。
 *    凭空拼 URL 等于编数据，而且签名（`upsig` / `deadline`）多半不对。
 * 4. **`new URL()` 抛错的候选一律保留。** 判不了就别删 —— 与 `classify.ts` 第 3 条
 *    "认不出就不猜"同一条纪律，只是这里连"猜"的后果都是删东西。
 * 5. **分类必须传两个参数**：`classifyCdn(host, search)`。`search` 是 `os=mcdn` 那条
 *    判据的唯一输入（官方镜像也会代理 mcdn 资源）。本次实测的 PCDN 域名没依赖它，
 *    但那是**判据没被触发**，不是"不用传"。
 *
 * ## 字段命名风格必须跟着输入走
 *
 * B站 两种形态都出现过：`base_url` / `backup_url`（下划线）与 `baseUrl` / `backupUrl`
 * （驼峰）。**输出必须与输入同风格** —— 混用的后果是播放器按另一个名字读，
 * 读到 `undefined`，表现为"某条轨没有流"。
 *
 * ## ⚠️ 一个未验证的前提，接线前必须知道
 *
 * 过滤之后 `backup_url` 很可能是 **`[]`**：实测 24 条 2160p 轨里，剔完 PCDN 有
 * **15 条只剩 1 条官方候选**（62%）。而**"播放器接不接受 `backup_url: []`"没有测过** ——
 * ADR 0038「未定」表第 2 项写的就是它：「若播放器索引 `backupUrl[0]`，会不播」。
 *
 * 已实测的只有两件相邻的事：① 播放器**确实**有 backupUrl 自动回退且生效
 * （计划 F1：两条 PCDN 全 `ERR_TIMED_OUT`，视频仍流畅播完）；② `backupUrl` 在
 * 本项目类型里就是 `string[]`（`src/shared/types/playinfo.ts`），空数组是合法值。
 * 这两条都**不构成**"空数组一定没事"的证据。接线那轮必须先在真机上验：
 * 构造一条只剩 `base_url` 的轨，看 `readyState` / `error` / 是否仍发起请求。
 *
 * @see docs/decisions/0038-filter-pcdn-candidates.md
 */

import { classifyCdn } from './classify';

/**
 * 一条轨里与本模块有关的四个字段。
 *
 * 其余字段（`quality` / `height` / `codecid` / `bandwidth` / `duration` / …）
 * **一律透传、一个都不改** —— 那是 ADR 0038 硬边界第 3 条的原文。
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

/** 本次过滤做了什么（诊断与测试都靠它，别省） */
export interface FilterStats {
  /** 被剔掉的候选 URL 条数（**只减不增**） */
  removed: number;
  /** 因为"剔完就没了"而**原样保留**的轨数（ADR 0038 边界 5 触发了几次） */
  keptIntact: number;
}

/** 过滤结果：轨列表 + 统计 */
export interface FilterResult<T extends CandidateTrack> {
  tracks: T[];
  stats: FilterStats;
}

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
 * 这条 URL 是不是 PCDN。
 *
 * ## 三条边界（每一条都对应一个真实失败方向）
 *
 * - **解析不出 host → 返回 `false`（保留）**：`new URL()` 抛错说明这个串不是我们能
 *   判断的东西（相对路径、被截断的串）。删掉它等于把"未知"当成"坏"。
 * - **必须传 `search`**：`os=mcdn` 是官方镜像代理 mcdn 时唯一的信号。
 * - **只看 `cls`**：`flavor` 不参与 —— 屏蔽逻辑从不问"官方是哪一种"。
 *
 * @param url 候选 URL 原文
 */
function isPcdnCandidate(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 判不了就别删（ADR 0038 边界 1 的保守方向；见文件头第 4 条）
    return false;
  }
  const { cls } = classifyCdn(parsed.host, parsed.search);
  return cls === 'pcdn';
}

/**
 * 把过滤后的候选写回一条**新**轨。
 *
 * ## 为什么是"展开 + 显式覆盖"而不是 `delete` + 赋值
 *
 * - `delete` 会改变键顺序，而这份数据会被 `JSON.stringify` 回响应体 ——
 *   键顺序变了虽不影响解析，但会让真机 diff 变成一片红，掩盖真正的改动；
 * - 显式写这四个键，下一轮接线时静态检查（`check-patch-scope.mjs` 的写集断言）
 *   看得见"到底改了哪几个字段"。
 *
 * 其它键由展开原样带过来，**一个都不动**。
 *
 * @param track 原轨（**不会被修改**）
 * @param naming 命名风格
 * @param kept 过滤后剩下的候选（至少 1 条）
 */
function withCandidates<T extends CandidateTrack>(
  track: T,
  naming: Naming,
  kept: readonly string[],
): T {
  const first = kept[0] ?? '';
  const rest = kept.slice(1);

  if (naming === 'snake') {
    return { ...track, base_url: first, backup_url: rest };
  }
  return { ...track, baseUrl: first, backupUrl: rest };
}

/**
 * 剔除每一条轨里**属于 PCDN** 的候选 URL。
 *
 * ## 算法（与 ADR 0038「决定」一节逐步对应）
 *
 * 1. 把该轨的 `[baseUrl, ...backupUrl]` 展开；
 * 2. 逐条分类（**必须传 `search`**）；
 * 3. 若剩余 ≥ 1 条：`base = 第一条`、`backup = 其余`，**官方之间不重排**；
 * 4. 若剩余 0 条：**整条轨原样保留**，一个字段都不动。
 *
 * ## 两个额外的保守规则（都不是 ADR 原文，是为了"不制造无谓 diff"）
 *
 * - **一条都没删的轨返回原对象**（引用相等）：接线那轮可以把"过滤后"的响应与
 *   原始响应逐字节比对，改动面等于 `stats.removed`，不会出现一堆"值没变但对象是新的"。
 * - **顺序完全不动**：第 1 条是播放器最初选中的那条，重排会改变首选。
 *   所以"剩下 2 条官方"时，第 1 条仍是原来的第 1 条官方（如果它没被删）。
 *
 * ## 纯函数
 *
 * 入参**不被修改**（不 `delete`、不 `push`、不排序）。测试里有一条就专门断言这件事：
 * 调用前后 `deepEqual` 原对象。
 *
 * @param tracks 一批轨（`dash.video` 或 `dash.audio`）
 * @returns 过滤后的轨（未改动的轨是**原对象**）+ 统计
 */
export function filterPcdnCandidates<T extends CandidateTrack>(
  tracks: readonly T[],
): FilterResult<T> {
  let removed = 0;
  let keptIntact = 0;

  const out: T[] = tracks.map((track) => {
    const naming = detectNaming(track);
    if (naming === null) return track;

    const candidates = candidatesOf(track, naming);
    if (candidates.length === 0) return track;

    const kept = candidates.filter((url) => !isPcdnCandidate(url));

    // 边界 5：剔完就没了 → 整条轨原样保留（不删轨、不换 host、不降级）
    if (kept.length === 0) {
      keptIntact += 1;
      return track;
    }

    // 一条都没删 → 原对象（不制造无谓 diff）
    if (kept.length === candidates.length) return track;

    removed += candidates.length - kept.length;
    return withCandidates(track, naming, kept);
  });

  return { tracks: out, stats: { removed, keptIntact } };
}
