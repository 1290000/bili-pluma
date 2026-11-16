/**
 * PCDN 诊断：ISOLATED world 的加载观测采集器（T3）
 *
 * ## 它回答什么问题
 *
 * 「这一次播放，分片到底从哪条线路来的？」—— `core/cdn/classify.ts` 只回答
 * 「某个 host 属于哪条线路」，`core/loading/timeline.ts` 只回答「这堆事件怎么排」。
 * 两个纯函数都不会自己去看页面。**这个模块是它们唯一的浏览器侧入口**：
 * 在 content script 的 ISOLATED world 里观察真实的网络与 `<video>` 事件，
 * 把结果喂给那两个纯函数。
 *
 * ## ⚠️ 为什么必须在**真扩展**里验，而不是 CDP 造的隔离世界
 *
 * `poc/probe/pcdn-diag/probe.mjs` 用的是 CDP `Page.createIsolatedWorld` ——
 * 它也"读到了"媒体请求。但**它不等于 content script 的隔离世界**：
 * 两者的生命周期、注入时机、`performance` 缓冲的可视范围都不同。
 * 上一轮的探针之所以只能当参考而不能当结论，就是因为这一点。
 *
 * ## 三条硬约束（改代码前读完）
 *
 * 1. **`host` 是唯一允许留下的字符串，且必须是纯 hostname。**
 *    取 flow URL 的 query 里有 `upsig` / `uparams` —— 那是**取流凭据**，
 *    泄露等同于把别人的播放权借出去。所以 URL 只被解析一次，
 *    之后**只有 hostname 进入任何内存结构**。
 *    事件里也只写 `host`（`LoadEvent.host` 的注释写的是同一条）。
 *
 *    ⚠️ **边界是"不存"，不是"不许读"**（T3 后按 Lead 裁决修订）：
 *    `classifyCdn(host, search)` 的第 5 条判据是 query 里的 `os=mcdn`，
 *    而官方镜像代理 mcdn 资源时只有这一个信号能识破。所以 `URL.search` 与
 *    `URL.pathname`（后者用于"是不是媒体分片"的布尔判断）**各被判读一次**、
 *    用完随局部变量消失 —— 都不进 `hosts` / `events` / 快照 / 存储 / console。
 *    禁止的是**留存**，不是**判读**。
 * 2. **事件驱动，绝不轮询。** 没有 `setInterval`，也没有"每 N 毫秒看一眼"的
 *    `setTimeout`。`<video>` 的出现靠 `MutationObserver` 等，播放靠浏览器自己的
 *    `canplay` / `playing` / `waiting` / `error`。
 * 3. **不打印、不存储、不发消息。** 采集器只往内存里放；谁来读、读到之后怎么用
 *    是上层的事。（真机取证时临时加过一行 `console.info` 探针，取证完已删除。）
 *
 * ## 只采**媒体分片**：host 与 path 两道判据
 *
 * - host：只走 `classifyCdn()` 的结果，**不另写域名表**——
 *   「哪些 host 算媒体域」若抄一份清单，与 `core/cdn/classify.ts` 必然漂移：
 *   那边新增一个 PCDN 供应商域，这边就会安静地采不到（`cls === 'unknown'` 被过滤），
 *   诊断页显示"没有 PCDN" —— 又是一个"界面一切正常"的失败方向。
 * - path：必须是媒体分片（`isMediaPath()`）。同域下的静态资源
 *   （`bvc.bilivideo.com/pbp/data`、`upos-sz-staticcos-cmask/…/*.webmask`）
 *   会被判成"官方线路"混进线路表，**而且一旦它们落在 pcdn 域上就是假警报**。
 *   实测依据写在那两个常量的注释里。
 */

import { classifyCdn, type CdnKind, type OfficialFlavor } from '@core/cdn/classify';
import { buildTimeline, type LoadEvent } from '@core/loading/timeline';

/** 采集侧环形缓冲上限：与 `buildTimeline()` 的默认 `limit` 一致（200） */
const EVENT_LIMIT = 200;

/** `actual` / `hosts` 里只认这三类；`unknown` 不算线路 */
const REAL_KINDS: readonly CdnKind[] = ['official', 'pcdn', 'third-party'];

/**
 * 置信度。
 *
 * - `measured`：真的看到了 resource 条目（有 host 就有分片请求，是测出来的）
 * - `inferred`：**当前不用**。留给将来"只有 playurl 候选、没有分片"的场景
 * - `none`：什么都没看到（hosts 为空）
 */
export type LoadingConfidence = 'measured' | 'inferred' | 'none';

/** 一个 host 的累计统计 */
export interface HostStat {
  /** 线路大类（来自 `classifyCdn`，本模块不重算） */
  cls: CdnKind;
  /** 官方线路的二级分类；非 `official` 恒为 `null` */
  flavor: OfficialFlavor;
  /** 这个 host 上观测到的 resource 条目数（**每次真实累加**） */
  count: number;
}

/** 诊断面板要的轻量快照（不含任何 URL / query / 凭据） */
export interface LoadingSnapshotLite {
  /** 是否观测到任何加载活动（有 host 或有事件） */
  present: boolean;
  /** 置信度。见 `LoadingConfidence` */
  confidence: LoadingConfidence;
  /** 实际在用的那条线路：`hosts` 里 `count` 最大的真实线路；为空时 `null` */
  actual: { host: string; cls: CdnKind; flavor: OfficialFlavor } | null;
  /** 全部 host 的统计，按 `count` 降序（同 count 按 host 升序，保证稳定） */
  hosts: Array<{ host: string; cls: CdnKind; flavor: OfficialFlavor; count: number }>;
  /** 归一后的时间轴（来自 `core/loading/buildTimeline`） */
  events: LoadEvent[];
  /** 是否因超出 200 条上限而丢过较早的事件 */
  truncated: boolean;
  /** `<video>` 的即时状态；页面上还没有 video 时为 `null` */
  video: { readyState: number; durationSec: number; height: number; errorCode: number } | null;
}

/**
 * 采集器唯一需要的 resource 条目形状。
 *
 * 只声明这三个字段而不是直接用 `PerformanceResourceTiming`：
 * 单测里不必造一整个 PerformanceEntry（那需要一整个浏览器）。
 */
export interface ResourceEntryLike {
  /** 完整 URL —— **只在这里被解析一次**，解析后只有 hostname 留下（见文件头第 1 条） */
  name: string;
  /** 相对 `performance.timeOrigin` 的毫秒数 */
  startTime: number;
  /** 同上 */
  responseEnd: number;
}

/** 采集器的可变状态（纯数据，`snapshotOf()` 只读它） */
export interface LoadingTraceState {
  /** 环形缓冲，长度 ≤ `EVENT_LIMIT` */
  events: LoadEvent[];
  /** host → 统计。用 Map 而不是遍历事件算：事件会被环形截断，计数不能跟着丢 */
  hosts: Map<string, HostStat>;
  /** 是否丢过较早的事件 */
  truncated: boolean;
  /**
   * **上一条已发出的 `seg-req` 的线路类别**（`null` = 还没发过）。
   *
   * ## 这是"要不要发事件"的闸门，判据是**类别变化**，不是 host 变化
   *
   * 「换线」在用户那里指的是**换了来源类型**（"被切到 P2P 了"），不是"换了机器"。
   * 2026-11-19 真机实测给出了这条判据的依据：一段 12 秒的播放里，
   * `cn-jsnt-ct-01-06` 与 `cn-jsnt-ct-01-01`（同一条官方自建 CDN 的两个边缘）
   * **逐片来回轮转** —— 按 host 变化计数会得出 26 条 `seg-req` / 23 次"换线"，
   * 而其中只有 4 次真的换了 `cls`。让用户看到"12 秒换了 23 次线"，
   * 他只会认为这个功能在胡说；真正要看见的是那 4 次里的 `official → pcdn`。
   *
   * ## 为什么仍用"上一条"而不是"见过的类别集合"
   *
   * 类别只有三种，用集合当闸门时 `official → pcdn → official` 的第三段会被吃掉，
   * 而 `core/loading/detectSwitches()` 正是靠 `seg-req` 的序列推切换的 ——
   * 于是真实发生的**两次**切换会被显示成一次。
   */
  lastSegReqCls: CdnKind | null;
}

/** 造一份空状态 */
export function createTraceState(): LoadingTraceState {
  return { events: [], hosts: new Map<string, HostStat>(), truncated: false, lastSegReqCls: null };
}

/**
 * 解析 URL，失败返回 `null`。
 *
 * 单独抽出来是为了让 `hostFromUrl()` 与 `resolveMediaHost()` **共用同一次解析**：
 * 两处各 `new URL()` 一遍不只是浪费，还会让"哪里读过 query"变得说不清。
 */
function parseUrl(url: string): URL | null {
  const raw = url.trim();
  if (raw.length === 0) return null;
  try {
    return new URL(raw);
  } catch {
    // 相对 URL / 非 URL 字符串：没有主机名可言
    return null;
  }
}

/**
 * 从 URL 取**纯 hostname**。
 *
 * `upsig` / `uparams` 这类取流凭据只可能出现在 query 里，`URL.hostname` 天然
 * 不含 query、path、port，所以从源头上就进不来。本函数是"能留存什么"的定义。
 *
 * @param url 资源条目的完整 URL（可能是 `blob:` / `data:`，那时没有主机名）
 * @returns 小写 hostname；不是带主机名的 URL 时返回 `null`
 */
export function hostFromUrl(url: string): string | null {
  const parsed = parseUrl(url);
  if (parsed === null) return null;

  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return null;
  return host;
}

/** `resolveMediaHost()` 的结果 */
export interface MediaHost {
  host: string;
  cls: CdnKind;
  flavor: OfficialFlavor;
}

/** 媒体分片的扩展名（实测 20 个视频的 `.m4s` 全集；`.mp4` / `.flv` 兜住非 DASH 场景） */
const MEDIA_EXT_RE = /\.(?:m4s|mp4|flv)$/i;

/**
 * B站 取流路径标识。
 *
 * 实测媒体分片**全部**落在 `/upgcxcode/` 下；加这一条是为了兜住"将来出现无扩展名
 * 分片"的情况 —— 只看扩展名的话，那种分片会被整类漏掉，而漏掉的又恰好是主流量。
 */
const MEDIA_PATH_MARKER = '/upgcxcode/';

/**
 * 这个 pathname 是不是一个**媒体分片**。
 *
 * ⚠️ **必须按路径过滤，不能只按 host**（2026-11-19 真机实测的假阳性）：
 *
 * ```
 * bvc.bilivideo.com                    /pbp/data                          ← 播放器数据接口
 * upos-sz-staticcos-cmask.bilivideo.com /cmaskboss/137649199_25_2.webmask  ← 水印遮罩
 * ```
 *
 * 两者 host 都是 `bilivideo.com`，会被判成"官方线路"计入 `hosts`。后果有两层：
 * 线路表里出现两个不是线路的东西；**更危险的是**若哪天这类静态资源落在 pcdn 域上，
 * 我们会显示"被切到 P2P"—— 假警报，而这正是本功能唯一要报的东西。
 *
 * @param pathname `parsed.pathname`（**只用来算这个布尔，不存**）
 */
function isMediaPath(pathname: string): boolean {
  return MEDIA_EXT_RE.test(pathname) || pathname.includes(MEDIA_PATH_MARKER);
}

/**
 * URL → 「这条请求算不算媒体分片、属于哪条线路」。
 *
 * 两道判据，缺一不可：
 *   1. **路径**是媒体分片（`isMediaPath`）—— 挡掉同域下的静态资源（见那里的实测）
 *   2. **host** 命中分类（`classifyCdn`，`cls !== 'unknown'`）
 *
 * **不要**在这里加 `initiatorType` 判断 —— MSE 分片走 `xmlhttprequest`，
 * PGC 可能走 `fetch`，按类型过滤会把其中一类整体漏掉。
 *
 * ## 为什么把 `search` 传进去（T3 后按 Lead 裁决修订）
 *
 * `classifyCdn()` 的第 5 条判据看的是 query 里有没有整段 `os=mcdn` ——
 * 官方镜像也会代理 mcdn 资源，只看域名会漏判。不传它，那条规则在生产里
 * 就是死代码，而代价是我们会对用户**陈述错误事实**（"这是官方线路"）。
 *
 * ⚠️ 边界是「**不存**」不是「**不许读**」：`parsed.search` 与 `parsed.pathname`
 * 各自只在本函数里被判读一次（前者进 `classifyCdn`，后者进 `isMediaPath`），
 * 回来的是 `{cls, flavor}` 与一个布尔值，`parsed` 随即作为局部变量消失。
 * **`host` 仍是唯一被保留下来的字符串** —— query 与 path 都不进任何结构。
 *
 * @param url resource 条目的 `name`
 * @returns 媒体分片则返回 host + 线路；不是媒体分片（或解析不出 host）返回 `null`
 */
export function resolveMediaHost(url: string): MediaHost | null {
  const parsed = parseUrl(url);
  if (parsed === null) return null;

  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return null;

  // 路径判据先做：同域下大量静态资源（`/pbp/data`、`*.webmask`）在这里就被挡掉
  if (!isMediaPath(parsed.pathname)) return null;

  // query 在这一行被判读，之后不再被任何结构引用（见上面的边界说明）
  const { cls, flavor } = classifyCdn(host, parsed.search);
  if (cls === 'unknown') return null;
  return { host, cls, flavor };
}

/**
 * 往环形缓冲里追加一条事件。
 *
 * 非法时间戳（`NaN` / `±Infinity` / 负数）**直接丢**，不修正成 0 ——
 * 修正会凭空造出一个"页面刚开始就发生了"的假节点（与 `buildTimeline()` 同一条原则）。
 * 这里先丢是为了不让它占掉环形位：200 个位置很贵。
 *
 * @param state 采集器状态（就地修改）
 * @param event 待追加的事件
 */
export function pushEvent(state: LoadingTraceState, event: LoadEvent): void {
  if (!Number.isFinite(event.t) || event.t < 0) return;

  state.events.push(event);
  if (state.events.length > EVENT_LIMIT) {
    state.events.splice(0, state.events.length - EVENT_LIMIT);
    state.truncated = true;
  }
}

/**
 * 处理一条 resource 条目。
 *
 * ## 闸门：**线路类别变化**才产出事件
 *
 * 一次播放会有几百条分片请求，逐条进时间轴会把 `<video>` 的那几个关键事件
 * （`canplay` / `stall` / `error`）挤出 200 条窗口 —— **被淹掉的恰好是最有用的**。
 * 所以只有 `cls` 与上一条已发出的 `seg-req` **不同**时才打一对
 * `seg-req` + `seg-res`（"从这一刻起换了来源类型"）。
 *
 * ### 为什么不按 host 变化（2026-11-19 真机数据推翻了 host 判据）
 *
 * 实测：B站 播放器会在同一条官方 CDN 的**两个边缘之间逐片轮转**
 * （`cn-jsnt-ct-01-06` ↔ `cn-jsnt-ct-01-01`），12 秒内交替 20 多次。
 * 按 host 变化发事件的话，`seg-req` 从个位数涨到 26 条、
 * `detectSwitches()` 报出 23 次"换线"，其中 19 次同属 `official` ——
 * 用户看到的是"12 秒换了 23 次线"，只会认为功能在胡说。
 *
 * 而"换线"要回答的其实只有一件事：**有没有被切到 P2P / 第三方**。
 * 所以闸门看 `cls`。代价是 `official A → official B` 这种同类别的线路迁移
 * 不进时间轴 —— 但 `hosts[]` 里有这两个 host 各自的真实计数，需要追究时仍在。
 *
 * ## 计数为什么不能靠遍历事件算，也不能被闸门影响
 *
 * 事件会被环形截断；更重要的是，闸门一收紧，事件就不再是"每个 host 一条" ——
 * 想从事件反推"到底用了哪几个 host、各发了多少请求"已经不可能。
 * 所以 `hosts[].count` **每条真实累加**，与事件是否发出完全解耦。
 *
 * @param state 采集器状态（就地修改）
 * @param entry 一条 resource 条目
 * @returns 本次是否**换了线路类别**（产出了一条新的 `seg-req`）
 */
export function recordResource(state: LoadingTraceState, entry: ResourceEntryLike): boolean {
  const resolved = resolveMediaHost(entry.name);
  if (resolved === null) return false;

  // 计数先记，且与闸门无关：它是"用过哪些 host"的唯一证据
  const known = state.hosts.get(resolved.host);
  if (known !== undefined) {
    known.count += 1;
  } else {
    state.hosts.set(resolved.host, { cls: resolved.cls, flavor: resolved.flavor, count: 1 });
  }

  // 同一线路类别的连续分片（含同类别内换机器）：计数已加过，事件不再发
  if (resolved.cls === state.lastSegReqCls) return false;
  state.lastSegReqCls = resolved.cls;

  pushEvent(state, {
    t: entry.startTime,
    stage: 'seg-req',
    host: resolved.host,
    kind: resolved.cls,
  });
  pushEvent(state, {
    t: entry.responseEnd,
    stage: 'seg-res',
    host: resolved.host,
    kind: resolved.cls,
  });
  return true;
}

/** `<video>` 事件 → 时间轴阶段。`error` 的 `note` 另带 `MediaError.code` */
export type VideoStage = 'canplay' | 'playing' | 'stall' | 'error';

/**
 * 记录一条 `<video>` 阶段事件。
 *
 * @param state 采集器状态（就地修改）
 * @param stage 归一后的阶段（`waiting` 映射为 `stall`，由调用方做映射）
 * @param t 毫秒（`performance.now()`）
 * @param note 可选说明；`error` 时是 `MediaError.code`
 */
export function recordVideoStage(
  state: LoadingTraceState,
  stage: VideoStage,
  t: number,
  note?: string,
): void {
  const event: LoadEvent = note === undefined ? { t, stage } : { t, stage, note };
  pushEvent(state, event);
}

/**
 * 状态 → 快照（纯函数，不碰 DOM）。
 *
 * @param state 采集器状态（**不修改**）
 * @param video `<video>` 的即时状态；页面上没有 video 时传 `null`
 * @returns 诊断面板可直接渲染的轻量快照
 */
export function snapshotOf(
  state: LoadingTraceState,
  video: LoadingSnapshotLite['video'],
): LoadingSnapshotLite {
  const hosts = Array.from(state.hosts.entries())
    .map(([host, stat]) => ({ host, cls: stat.cls, flavor: stat.flavor, count: stat.count }))
    .sort((a, b) => (a.count === b.count ? (a.host < b.host ? -1 : 1) : b.count - a.count));

  // 排序后第一条真实线路就是 count 最大的那条；`unknown` 不参与（它没有线路）
  const top = hosts.find((h) => REAL_KINDS.includes(h.cls));
  const timeline = buildTimeline(state.events, EVENT_LIMIT);

  return {
    present: hosts.length > 0 || timeline.events.length > 0,
    confidence: hosts.length > 0 ? 'measured' : 'none',
    actual: top === undefined ? null : { host: top.host, cls: top.cls, flavor: top.flavor },
    hosts,
    events: timeline.events,
    truncated: state.truncated || timeline.truncated,
    video,
  };
}

/** `<video>` 上的事件名 → 时间轴阶段（声明顺序即监听器安装顺序，不影响语义） */
const VIDEO_EVENT_MAP: ReadonlyArray<readonly [string, VideoStage]> = [
  ['canplay', 'canplay'],
  ['playing', 'playing'],
  ['waiting', 'stall'],
  ['error', 'error'],
];

/** 读 `<video>` 的即时状态。`duration` 在元数据到位前是 `NaN`，按 0 报 */
function readVideoLite(video: HTMLVideoElement | null): LoadingSnapshotLite['video'] {
  if (video === null) return null;
  const duration = video.duration;
  return {
    readyState: video.readyState,
    durationSec: Number.isFinite(duration) ? duration : 0,
    height: video.videoHeight,
    errorCode: video.error === null ? 0 : video.error.code,
  };
}

/**
 * 模块级单例：一个页面一份
 */
let state: LoadingTraceState = createTraceState();

/** 已安装的卸载函数；`null` = 当前没装 */
let disposeCurrent: (() => void) | null = null;

/** 当前挂上的 `<video>` */
let boundVideo: HTMLVideoElement | null = null;

/** 解绑当前 `<video>` 上所有监听器；`null` = 没挂 */
let unbindVideo: (() => void) | null = null;

/**
 * 把监听器挂到页面上那个 `<video>` 上（若还没有就什么都不做，等 `MutationObserver`）。
 *
 * ## 为什么要单独导出
 *
 * `<video>` 可能晚于本脚本出现（`document_start` 注入时页面还是一片空白）。
 * 正常路径是 `MutationObserver` 等它出现；但**如果页面把整个播放器重建了**
 * （PGC 换集、番剧切线路都可能），旧元素被换掉，而观察器在第一次挂上时就已断开 ——
 * 这时允许调用方在 `play` 之后 / 换集时再调一次本函数补齐。这是兜底，不是主路径。
 *
 * 幂等且**自适应**：
 *   - 已经挂在**同一个**元素上 → 直接返回
 *   - 页面换了新元素 → 解绑旧的，挂到新的
 */
export function attachLoadingTraceVideo(): void {
  const video = document.querySelector('video');
  if (video === null) return;

  if (boundVideo === video && unbindVideo !== null) return;
  // 元素被换掉了：先解绑旧的，避免监听器留在已卸载的节点上（那里的事件永远不会再来）
  if (unbindVideo !== null) unbindVideo();

  const handlers: Array<{ type: string; handler: EventListener }> = [];
  for (const [type, stage] of VIDEO_EVENT_MAP) {
    const handler: EventListener = () => {
      // `error` 带上 MediaError.code：`stall` 与 `error` 在时间轴上长得很像，
      // 没有 code 就分不清"网慢"与"被拦"
      const note =
        stage === 'error' && video.error !== null ? `code=${String(video.error.code)}` : undefined;
      recordVideoStage(state, stage, performance.now(), note);
    };
    video.addEventListener(type, handler);
    handlers.push({ type, handler });
  }

  boundVideo = video;
  const detach = (): void => {
    for (const { type, handler } of handlers) video.removeEventListener(type, handler);
    if (boundVideo === video) boundVideo = null;
    if (unbindVideo === detach) unbindVideo = null;
  };
  unbindVideo = detach;
}

/**
 * 安装采集器。
 *
 * ## `buffered: true` 不是可选项
 *
 * `PerformanceObserver` 默认只报**安装之后**发生的条目。本脚本在 `document_start`
 * 跑，但播放器经常在它之前就已经开始拉分段（预加载、`__playinfo__` 里的首片）——
 * 不带 `buffered` 会安静地漏掉开头那几段，而那几段恰恰是判断"开头走的哪条线路"
 * 的关键。实测过：去掉 `buffered` 后首个 host 从 3 条掉到 1 条。
 *
 * ## 为什么先 `type: 'resource'` 再自己按 host 过滤
 *
 * 不按 `initiatorType` 过滤：MSE 分片是 `xmlhttprequest`，PGC 可能走 `fetch`，
 * 按类型过滤等于按浏览器实现细节过滤，会整类漏掉。
 *
 * @returns 卸载函数（幂等，可重复调用）
 */
export function installLoadingTrace(): () => void {
  if (disposeCurrent !== null) return disposeCurrent;

  const Observer = globalThis.PerformanceObserver;
  let resourceObserver: PerformanceObserver | null = null;

  if (typeof Observer === 'function') {
    resourceObserver = new Observer((list) => {
      for (const entry of list.getEntries()) {
        const timing = entry as PerformanceResourceTiming;
        recordResource(state, {
          name: timing.name,
          startTime: timing.startTime,
          responseEnd: timing.responseEnd,
        });
      }
    });

    try {
      resourceObserver.observe({ type: 'resource', buffered: true });
    } catch {
      // 极老的内核不认 `type` 形式：退回"全部条目"，不因此让采集器整段失效
      try {
        resourceObserver.observe({ entryTypes: ['resource'] });
      } catch {
        resourceObserver = null;
      }
    }
  }

  /**
   * `<video>` 晚于脚本出现：用 `MutationObserver` 等它，挂上即断开。
   *
   * 不用定时器轮询 —— 项目里唯一一次"挂后台白屏"事故的根因就是常驻定时器。
   * `document` 在 `document_start` 阶段可能还没有 `documentElement`，
   * 所以直接观察 `document`（`Document` 本身是 `Node`，可以观察）。
   */
  let videoObserver: MutationObserver | null = null;
  attachLoadingTraceVideo();
  if (unbindVideo === null && typeof MutationObserver === 'function') {
    videoObserver = new MutationObserver(() => {
      attachLoadingTraceVideo();
      if (unbindVideo !== null) {
        videoObserver?.disconnect();
        videoObserver = null;
      }
    });
    try {
      videoObserver.observe(document, { childList: true, subtree: true });
    } catch {
      videoObserver = null;
    }
  }

  const dispose = (): void => {
    resourceObserver?.disconnect();
    resourceObserver = null;
    videoObserver?.disconnect();
    videoObserver = null;
    unbindVideo?.();
    disposeCurrent = null;
    // 页面没了，数据也没有意义：下一次安装应当是干净的
    resetLoadingTrace();
  };

  disposeCurrent = dispose;
  return dispose;
}

/**
 * 取当前快照。
 *
 * 只读：不安装、不清空、不改状态。
 */
export function getLoadingSnapshot(): LoadingSnapshotLite {
  // 尚未挂上（`<video>` 还没出现，或观察器没跑到）时按只读方式补看一眼 ——
  // 不在这里挂监听器，`get` 不该有副作用。
  //
  // `typeof document` 的守卫只为"非 DOM 宿主"（如单测的 node 环境）不抛，
  // content script 里 `document` 必然存在，这条不会走到。
  const found =
    boundVideo ?? (typeof document === 'undefined' ? null : document.querySelector('video'));
  return snapshotOf(state, readVideoLite(found));
}

/**
 * 清空已采集的数据（换页 / 换集调用），**保留**观察器。
 *
 * 为什么必须清：PGC 是 SPA，切集不会重新加载页面，content script 也不会重跑。
 * 不清的话上一集的 host 统计会算进新一集 —— 诊断页会指着一个这一集根本没用的
 * 线路说"当前线路"，而它连一条分片都没发过。
 */
export function resetLoadingTrace(): void {
  state = createTraceState();
}
