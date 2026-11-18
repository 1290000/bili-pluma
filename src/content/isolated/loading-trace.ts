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
 *
 *    2026-11-18（ADR 0042）起还多问一次 `classifyCdn(host)`（**不传 search**），
 *    得到 `hostCls`：枚举，不是 query，所以仍未留下任何 query 内容。
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
 *   那边新增一个 PCDN 供应商域，这边就会安静地采不到。
 *   ⚠️ 2026-11-17（P0-1）修的就是这条漂移的后果：`unknown` 现在**照常计数**，
 *   只是不参与"当前线路"的结论（见 `resolveMediaHost()` 的表格）。
 * - path：必须是媒体分片（`isMediaPath()`）。同域下的静态资源
 *   （`bvc.bilivideo.com/pbp/data`、`upos-sz-staticcos-cmask/…/*.webmask`）
 *   会被判成"官方线路"混进线路表，**而且一旦它们落在 pcdn 域上就是假警报**。
 *   实测依据写在那两个常量的注释里。
 */

import { classifyCdn, type CdnKind, type OfficialFlavor } from '@core/cdn/classify';
import type { FilterSkipReason } from '@core/cdn/filter';
import { buildTimeline, type LoadEvent } from '@core/loading/timeline';

/** 采集侧环形缓冲上限：与 `buildTimeline()` 的默认 `limit` 一致（200） */
const EVENT_LIMIT = 200;

/**
 * 能进 `actual`（结论大字 / 「当前线路」）的类别。
 *
 * ⚠️ **`hosts` 不受这个数组限制**：`unknown` 的 host 照样在里面计数
 * （2026-11-17，P0-1）。这里只回答"能不能拿来当结论" —— 认不出来源的线路
 * 不能替用户下"你在用哪条线"的结论，但**必须**能被看见。
 */
const REAL_KINDS: readonly CdnKind[] = ['official', 'pcdn', 'third-party'];

/**
 * 置信度。
 *
 * - `measured`：真的看到了 resource 条目（有 host 就有分片请求，是测出来的）
 * - `none`：什么都没看到（`hosts` 为空）
 *
 * ## 2026-11-17（T13）：删掉 `inferred`
 *
 * 它从加进来到删掉**没有任何生产者**（导出层早已收窄成 `measured | none`）。
 * 类型里留着一个永远不出现的值，就是空承诺 —— 读代码的人会以为"只有 playurl
 * 候选、没有分片"这种情况已经在处理了，实际上没有任何代码算过它。
 */
export type LoadingConfidence = 'measured' | 'none';

/** 一个 host 的累计统计 */
export interface HostStat {
  /** 线路大类（来自 `classifyCdn`，本模块不重算） */
  cls: CdnKind;
  /** 官方线路的二级分类；非 `official` 恒为 `null` */
  flavor: OfficialFlavor;
  /**
   * 只看主机时的类别（`classifyCdn(host)`，不传 search）—— ADR 0042。
   *
   * 与 `cls` 的差异只有一个含义：`hostCls === 'official' && cls === 'pcdn'` 就是
   * 「主机是官方镜像，只因资源标记 `os=mcdn` 被判成 pcdn」。语义见 `MediaHost.hostCls`。
   */
  hostCls: CdnKind;
  /** 这个 host 上观测到的 resource 条目数（**每次真实累加**） */
  count: number;
}

/** 诊断面板要的轻量快照（不含任何 URL / query / 凭据） */
export interface LoadingSnapshotLite {
  /** 是否观测到任何加载活动（有 host 或有事件） */
  present: boolean;
  /** 置信度。见 `LoadingConfidence` */
  confidence: LoadingConfidence;
  /**
   * 实际在用的那条线路：`hosts` 里 `count` 最大的真实线路；为空时 `null`
   *
   * ⚠️ 带 `hostCls`（ADR 0042）：面板靠 `hostCls === 'official' && cls === 'pcdn'`
   * 分辨"主机是官方镜像、只因 `os=mcdn` 被判 pcdn"，从而不再把它画成橙色 P2P。
   */
  actual: {
    host: string;
    cls: CdnKind;
    flavor: OfficialFlavor;
    /** 只看主机时的类别。见下面的「为什么可选」 */
    hostCls?: CdnKind;
  } | null;
  /** 全部 host 的统计，按 `count` 降序（同 count 按 host 升序，保证稳定） */
  hosts: Array<{
    host: string;
    cls: CdnKind;
    flavor: OfficialFlavor;
    /** 只看主机时的类别。见下面的「为什么可选」 */
    hostCls?: CdnKind;
    count: number;
  }>;
  /**
   * ## 为什么 `hostCls` 在**快照**里是可选的（而在 `HostStat` 里是必填的）
   *
   * 这份快照要跨 world 传输（`page: loading-snapshot` → `panel-data.ts`），
   * 而且被**几十个测试**当作 fixture 手工构造。做成必填会让所有与 `hostCls`
   * 无关的断言（时间轴行、换线次数、导出白名单……）因为一个缺字段而全部变红 ——
   * 那会让"契约没变"的证据被淹没在噪音里。同一条理由写在上面 `filter?` 那里。
   *
   * 分工因此是：
   *
   * | 结构 | 必填？ | 谁填 |
   * | --- | --- | --- |
   * | `HostStat`（采集侧内部） | **必填** | `recordResource()` —— 漏存会让面板永远退回橙色 P2P |
   * | `MediaHost`（`resolveMediaHost` 产出） | **必填** | `classifyCdn(host)` 多问一次 |
   * | `LoadingSnapshotLite`（跨 world DTO） | 可选 | `snapshotOf()` 恒填；fixture 可不填 |
   *
   * 消费方**必须自己兜底**：`renderedKind(cls, hostCls)` 在 `hostCls` 缺席时
   * 按 `cls` 处理 —— 也就是保留旧行为（宁可显示橙色 P2P：误报"官方"才是静默失败）。
   */
  /** 归一后的时间轴（来自 `core/loading/buildTimeline`） */
  events: LoadEvent[];
  /** 是否因超出 200 条上限而丢过较早的事件 */
  truncated: boolean;
  /** `<video>` 的即时状态；页面上还没有 video 时为 `null` */
  video: { readyState: number; durationSec: number; height: number; errorCode: number } | null;
  /**
   * 时间轴的**输出原点**：`0` = 相对页面 `timeOrigin`（首屏，原样），
   * `> 0` = 已换过集，`events[].t` 已经**减掉**这个值（时间轴从本集 0.00s 起算）。
   *
   * ## 为什么既要下发这个字段，又要它可选
   *
   * 下发：面板要靠它决定「尾注第一句说哪个时基」「还要不要补『本集开始于页面加载后 X』」
   * —— 归零之后那句锚点是**自相矛盾**的（见 `loading-pane.ts` 的 `pageOriginAnchor()`）。
   *
   * 可选：这份快照被几十个测试当作 fixture 手工构造（理由同上面 `filter` / `hostCls`
   * 那两段），做成必填会让与"时基"无关的断言全部变红。消费方**必须兜底**：
   * `undefined` 与 `0` 同义（= 没换过集，时间从页面加载算起）。
   */
  originT?: number;
  /**
   * 候选过滤（ADR 0038）这一次做了什么（2026-11-17 接线）。
   *
   * ## 为什么是可选字段
   *
   * 这份快照的形状被几十个测试当作 fixture 手工构造；做成必填会让它们**全部**
   * 因为一个与各自断言无关的字段而变红。所以是可选的，**消费方必须自己兜底**
   * （导出侧 `buildLoadingExport()` 会补 `{applied:false, rewritten:0, proxied:0, fallbackKept:0}`）。
   *
   * ⚠️ `applied` 回答的是"**这一次页面里改写真的生效过**"（真的换过至少一条候选），
   * 不是"开关开着"。开关开着但没有 PCDN 候选时，它仍然是 `false` ——
   * 那正是"未生效"，与"剔了 0 条"是两件事（后者不需要报告）。
   */
  filter?: PcdnFilterStats;
}

/** 候选过滤的累计结果（主世界每处调用点各报一条，采集侧累加） */
export interface PcdnFilterStats {
  /** 是否**真的**改动过响应体（换过至少一条候选的 authority） */
  applied: boolean;
  /** 真正换了 authority 的候选条数（含走 proxy 的） */
  rewritten: number;
  /** 其中走 proxy 包装的条数（ADR 0039 边界 7） */
  proxied: number;
  /** 想换但换不了、原样保留的条数（解析失败 / 规则缺项） */
  fallbackKept: number;
  /**
   * 为什么**没**生效（2026-11-17，Lead 约束 ②）。
   *
   * | 值 | 含义 |
   * | --- | --- |
   * | `'off'` | 用户没打开开关（默认状态） |
   * | `'rulesMissing'` | 开关开着，但 ISOLATED 侧没把判据规则下发过来 —— 主世界判定不了就不动响应体 |
   *
   * 有 `applied: true` 时不应带 reason。
   */
  reason?: FilterSkipReason;
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
  /**
   * 这一次页面生命周期里**是否已经记过一条 `ext-patch`**（2026-11-17，T11）。
   *
   * ## 为什么要记这个
   *
   * 主世界每次真改写 playurl 响应都会上报一条（`reportExtPatch()`）。
   * 切清晰度 / 换轨会重新拉一次 playurl，于是**可能连着报好几条** ——
   * 而"扩展介入了"这件事在一次页面里只发生一次，重复打点会让时间轴出现
   * 一长串同名节点，把真正有用的分片事件挤下去。
   *
   * 所以采集侧只收第一条，后面的直接丢弃（主世界那边不做判断：
   * 它的职责是"我改了就说"，"只显示一次"是显示层的事）。
   */
  extPatchRecorded: boolean;
  /**
   * **本页的取流是否由扩展代理**（2026-11-17，T13，P0-3）。
   *
   * ## 值从哪来，为什么可信
   *
   * `entrypoints/content.ts` 收到 `page/activate:ok` 后调
   * `setLoadingTraceProxied(res.activated === true)` —— `activated` 是
   * **background 的回报**（DNR 规则真的装上了），不是"用户配了账号"的推断。
   * 默认 `false`：回包之前我们**不知道**，而"不知道"必须表现得像"没有"。
   *
   * ## 用它做什么
   *
   * `recordPlayurl()` 命中时，若本页由扩展代理，就补一条 `ext-patch`
   * （`note: '接管取流'`）。这样**首次观看**（没有历史进度要还原，主世界那条
   * `reportExtPatch()` 不会发）也能在时间轴上看到「扩展介入」。
   *
   * ## 为什么它不会在 `page` 身份下误报
   *
   * `page` 身份时 background 回 `activated: false`（reason `page-identity`），
   * 这个字段就是 `false`，一条 `ext-patch` 都不会补 —— 那是**正确的不出现**：
   * 用户自己就是大会员，扩展确实没有参与取流。
   */
  streamingProxied: boolean;
  /**
   * 候选改写（ADR 0039）的**累计**结果（2026-11-17 接线）。
   *
   * 主世界三个调用点各自上报一次（`playurl` / `playinfo` / `playview`），这里
   * **累加**而不是覆盖：一次播放可能先整页注入、再切一集，三个数都要算进去。
   */
  filter: PcdnFilterStats;
  /**
   * 时间轴的**输出原点**（毫秒，相对页面 `timeOrigin`）。`0` = 尚未换过集。
   *
   * ## 这不是事件，绝不进 `events`
   *
   * `events` 是"发生过什么"，原点是"从哪一刻开始算"——把原点写成一条事件会
   * 让时间轴上凭空多出一个节点，而且它长得和 `nav` 一模一样（细节见
   * `recordNavStart()` 的注释：换集时**有意不补** `nav`）。所以它只活在状态里，
   * 唯一的作用是 `snapshotOf()` 在**输出层**把 `t` 平移。
   *
   * ## 为什么 `0` 表示"不平移"而不是"平移 0 毫秒"
   *
   * 两者数值上一样，但判据上必须分开：`0` 是"这一页还没换过集"，
   * 首屏与现有 200+ 例测试都跑在这条路上 —— `snapshotOf()` 在那里**原样返回**
   * 不创建新数组，保证输出与改动之前逐字节一致。
   *
   * ## 为什么是采集侧字段而不是 `buildTimeline()` 的参数
   *
   * `core/loading/timeline.ts` 是纯函数、零 IO，它**不该知道"集"这个概念**：
   * 它的排序 / 去重语义建立在**原始时基**上（同一 `t` 的两条事件必须能对上），
   * 平移必须发生在排序之后。所以原点留在本模块，`buildTimeline()` 签名一字不动。
   */
  originT: number;
}

/** 造一份空状态 */
export function createTraceState(): LoadingTraceState {
  return {
    events: [],
    hosts: new Map<string, HostStat>(),
    truncated: false,
    lastSegReqCls: null,
    extPatchRecorded: false,
    streamingProxied: false,
    filter: { applied: false, rewritten: 0, proxied: 0, fallbackKept: 0 },
    // 0 = 尚未换过集 ⇒ `snapshotOf()` 不平移，首屏行为与改动前完全一致
    originT: 0,
  };
}

/**
 * 记录时间轴的**输出原点**：换集之后，时间轴从这一刻起算 0.00s。
 *
 * ## 为什么必须在 `resetLoadingTrace()` **之后**单独调一次
 *
 * `resetLoadingTrace()` 的语义是"清空"，它会把 state 整个换成新对象，
 * `originT` 也跟着回到 `0`。**刻意不**让它顺手记一个原点：那样等于把
 * "清空数据"和"给新一集定个起点"两个职责塞进一个函数，而后者需要
 * `performance.now()` —— 一个纯清空函数不该读时钟（它现在连 `window` 都不碰，
 * 单测直接调也不会有副作用）。所以调用方是**两条**：
 *
 * ```ts
 * resetLoadingTrace();
 * markTraceOrigin(performance.now()); // 必须紧跟着，否则新一集不归零
 * ```
 *
 * ## 真机依据（2026-11-20 实测 6 轮换集）
 *
 * 换集后时间轴第一行出现 `55.62s` / `91.35s` / `267.49s` 这种大数，
 * 用户读成"这一集从 55 秒开始播"——而实测 `t=3229.65s` 与本集
 * `video.duration=1441s` 根本对不上（前者是页面 `timeOrigin` 起算的绝对毫秒）。
 * 归零后第一行就是本集真实的"第几秒"。
 *
 * @param t 毫秒（`performance.now()`）；非有限数或负数**直接忽略**
 *   （与 `pushEvent()` 同一条纪律：非法值不修正成某个"看起来正常"的数）
 */
export function markTraceOrigin(t: number): void {
  if (!Number.isFinite(t) || t < 0) return;
  state.originT = t;
}

/**
 * 告诉采集器"本页取流是否由扩展代理"（`page/activate` 回包时调用）。
 *
 * 只写一个布尔，不碰任何已采集的数据：回包可能晚于第一批分片（~400ms），
 * 那时把已经记下的事件回填成"扩展介入"就是在改写历史。
 *
 * @param proxied `res.activated === true`；不知道时**不要调**（默认 false 更保守）
 */
export function setLoadingTraceProxied(proxied: boolean): void {
  state.streamingProxied = proxied;
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
  /** 纯 hostname（唯一被保留下来的字符串，见文件头第 1 条） */
  host: string;
  /** 带上 query 后的线路分类（第 5 条 `os=mcdn` 会影响它） */
  cls: CdnKind;
  /** 官方线路的二级分类；非 `official` 恒为 `null` */
  flavor: OfficialFlavor;
  /**
   * **只看主机（不传 `search`）时**判成什么 —— ADR 0042。
   *
   * ## 为什么需要第二个类别
   *
   * 候选过滤（ADR 0039）把 PCDN 候选的 authority 换成官方镜像、`search` 一字不动
   * （签名参数 `uparams` 含 `os`，删了 403）。改写后是「官方镜像 + `os=mcdn`」，
   * 第 5 条仍命中 → `cls` 还是 `pcdn`，但它**已经不在 PCDN 上取流了**。
   *
   * 推导（面板据此选文案）：
   *
   * | `hostCls` | `cls` | 含义 |
   * | --- | --- | --- |
   * | `official` | `pcdn` | 主机本身是官方镜像，只因**资源标记**是 mcdn 才判成 pcdn |
   * | `pcdn` | `pcdn` | 真实 PCDN 主机（标签 / 供应商域 / IP） |
   * | 其余 | 与 `hostCls` 相同 | `os=mcdn` 对它没起作用 |
   *
   * ⚠️ **语义仍由 `classify.ts` 定义**：这里只是多问一次同一个纯函数。
   * 面板**不许**自己写一份官方域表 —— `classify.ts` 第 2 条纪律明确禁止。
   * ⚠️ 边界 5：这是个枚举，不是 query，所以进快照不违反"`search` 不进快照"。
   */
  hostCls: CdnKind;
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
 * B站 取流接口的路径标识（2026-11-17，T12；2026-11-20 补 `playview`）。
 *
 * 覆盖四种已知形状，前三种靠 `/playurl` 这个子串命中：
 * ```
 * /x/player/playurl          ← 普通视频（旧接口）
 * /x/player/wbi/playurl      ← 普通视频（WBI 签名版）
 * /pgc/player/web/playurl/v2 ← 番剧 / PGC 的**首屏**取流
 * ```
 *
 * 第四种 `playview` **不含 `/playurl`**，必须单列：
 * ```
 * /ogv/player/playview       ← 番剧 / PGC 的 **SPA 换集**取流
 * ```
 *
 * ## 为什么必须补 `playview`（2026-11-20 真机反馈的第 4 条）
 *
 * 用户在 PGC 页面换集，时间轴里连「发出取流请求 / B站 返回线路清单」这两行
 * 都不出现，只剩「下载视频片段」。原因是换集**根本不走 playurl**——
 * 主世界那条 `isPgcPlayview` 分支（`main-world.js`）拦的就是它。
 *
 * 漏了这条的代价不是少两行：`recordPlayurl()` 还顺带承担
 * **「本页由扩展代理 → 这一次取流就是扩展介入」**的上报（见那里的注释）。
 * 换集时 `resetLoadingTrace()` 会把 `extPatchRecorded` 清掉，而下一次
 * `playurl` 可能一整个页面都不再来 —— 于是新一集里「扩展介入」这个标签
 * 永远不会重新出现，即使扩展明明在换流。
 *
 * `playview` 只出现在 `api.bilibili.com` 上，但仍走 `isPlayurlApi()` 里
 * 同一个域判据（带点后缀），不单开一条放行的口子。
 */
const PLAYURL_PATH_MARKER = '/playurl';

/** PGC SPA 换集的取流路径（不含 `/playurl`，见上） */
const PGC_PLAYVIEW_PATH_MARKER = '/ogv/player/playview';

/**
 * `pathname` 是否**以** `marker` 为路径段结尾（`/a/b/c` 或 `/a/b/c/…`）。
 *
 * 为什么不能直接 `pathname.includes(marker)`：那样 `/ogv/player/playviewx`
 * 也会命中。真机上不存在这个接口，但判据写松了，将来 B站 加一个
 * `playviewxxx` / `playview_v2` 就会把无关请求塞进时间轴 —— 而这条通道
 * 顺带承担「扩展介入」上报，误报比漏报更难排查。
 *
 * 注意只比 `pathname`：query 已经在 `URL` 里被切走了，所以
 * `/ogv/player/playview?ep_id=…` 自然判对。
 */
function pathnameIsOrUnder(pathname: string, marker: string): boolean {
  if (!pathname.startsWith(marker)) return false;
  const rest = pathname.slice(marker.length);
  return rest === '' || rest.startsWith('/');
}

/** B站 自己的域。**必须带点**做后缀判断，否则 `evilbilibili.com` 会被放进来 */
const BILI_DOMAIN = 'bilibili.com';

/**
 * 这个 URL 是不是**B站 自己的取流接口**请求（`playurl` / PGC 的 `playview`）。
 *
 * ## 为什么需要这条通道（用户在真机上指着时间轴第一行问的话）
 *
 * 「1.53s 之前是做什么去了？」—— 采集器只收媒体分片，`playurl` 这类接口请求
 * 被 `isMediaPath()` 挡掉了，于是时间轴从 0s 直接跳到第一个片段，中间
 * 「发出取流请求 → B站 返回线路清单」整段是盲区。而这两件事恰恰是原始需求里
 * "第几秒发出请求、第几秒返回数据"的那一半。
 *
 * ## ⚠️ 这不是"放宽媒体判据"
 *
 * `isMediaPath()` / `classifyCdn()` **一个字都没动**。这是**并列的第二条通道**：
 *
 * | 通道 | 回答的问题 | 带不带 host |
 * | --- | --- | --- |
 * | 媒体分片（`resolveMediaHost`） | 数据**从哪条线路**来 | 带（host + cls） |
 * | 取流接口（本函数） | **第几秒**发出请求 / 拿到清单 | **不带** |
 *
 * `api.bilibili.com` 不是线路，把它写进 `hosts` 会让「N 条线路」的计数虚高 ——
 * 而那个数字是用户判断"是不是被切走了"的主要依据。
 *
 * ## 两条路径并列，不是"换集时另算一次"
 *
 * `playview` 与 `playurl` 走同一个出口：`recordPlayurl()` 里那对
 * `playurl-req` / `playurl-res` 事件、以及 `streamingProxied` 为真时补的
 * `ext-patch`。**事件名不加 `pgc-` 前缀**：对用户来说两件事一样
 * （「第几秒发出取流请求」），多一个 stage 只是给面板加一栏没人看得懂的区别。
 *
 * @param parsed 已解析的 URL（pathname 只在这里被判读一次，不存）
 */
function isPlayurlApi(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  if (host !== BILI_DOMAIN && !host.endsWith(`.${BILI_DOMAIN}`)) return false;
  const pathname = parsed.pathname;
  return (
    pathname.includes(PLAYURL_PATH_MARKER) || pathnameIsOrUnder(pathname, PGC_PLAYVIEW_PATH_MARKER)
  );
}

/**
 * 记录一条取流请求（`playurl` 或 PGC 的 `playview`）—— 第二条通道，
 * 与媒体分片**并列**（见 `isPlayurlApi()`）。
 *
 * 产出两条事件：`playurl-req` @ `startTime`、`playurl-res` @ `responseEnd`。
 * **不带 `host`、不带 `kind`**：它们不是线路（理由见 `isPlayurlApi()`）。
 *
 * ## 每一次都记，不做去重
 *
 * 画质切换、换轨、PGC 首屏取流、PGC 换集（`playview`）都会重新拉一次 ——
 * 那**是**事实，一次播放里有几次取流就有几对节点。闸门（`cls` 变化才发分片
 * 事件）不能套在这里：它压的是"几百条同类别分片"，而取流一次播放只有个位数。
 * PGC 换集的旧数据由 `resetLoadingTrace()` 兜底清掉。
 *
 * @param state 采集器状态（就地修改）
 * @param entry 一条 resource 条目
 * @returns 是否命中（`false` = 不是取流请求，交给媒体通道继续判）
 */
export function recordPlayurl(state: LoadingTraceState, entry: ResourceEntryLike): boolean {
  const parsed = parseUrl(entry.name);
  if (parsed === null || !isPlayurlApi(parsed)) return false;

  pushEvent(state, { t: entry.startTime, stage: 'playurl-req' });
  pushEvent(state, { t: entry.responseEnd, stage: 'playurl-res' });

  /**
   * ## 本页由扩展代理 → 这一次取流就是扩展介入（P0-3）
   *
   * 主世界那条 `reportExtPatch()` 只在"真的改写了响应"（还原观看进度）时发，
   * 所以**首次观看**（没有历史进度可还原）永远不会出现「扩展介入」——
   * 而扩展其实在介入（DNR 换掉了 Cookie）。这里补上第二种触发点。
   *
   * - `t` 用同一个 `startTime`：介入发生在**请求发出那一刻**，不是返回后。
   * - 去重共用 `extPatchRecorded`：同一次页面只留第一条。谁先到谁算
   *   （通常这里先到，因为请求先于响应）。
   * - `note` 区分来源：`接管取流`（两条路径共用 —— DNR 代理，以及 PGC 整页注入。
   *   2026-11-19 起**不再**出现 `改写响应`，理由见 `noteExtPatch()` 的注释）。
   */
  if (state.streamingProxied) recordExtPatch(state, entry.startTime, '接管取流');

  return true;
}

/**
 * URL → 「这条请求算不算媒体分片、属于哪条线路」。
 *
 * 两道判据，缺一不可：
 *   1. **路径**是媒体分片（`isMediaPath`）—— 挡掉同域下的静态资源（见那里的实测）
 *   2. **host** 能被 `classifyCdn` 解析出来（任何 `cls` 都收，含 `unknown`）
 *
 * ## 2026-11-17（T13，P0-1）：`unknown` **不再被丢弃**
 *
 * 旧实现在 `cls === 'unknown'` 时 `return null`，后果是一整类失败方向：
 * B站 新增一个 PCDN 供应商域时，`hosts` 里没有它 → 面板显示「0 条线路 /
 * 没有 PCDN」，而流量确实在跑。**界面看起来一切正常**，正是最难发现的那种错。
 *
 * 现在的分工：
 *
 * | 谁 | 怎么对待 `unknown` |
 * | --- | --- |
 * | `hosts` 计数 | **照常累加**（"用过哪些 host"是事实，与认不认得无关） |
 * | `actual`（结论大字） | **不参与**（只在 `REAL_KINDS` 里挑，见 `snapshotOf`） |
 * | 界面 | 单独一态：「有 N 条线路认不出来源」+ 虚线空心圆 |
 *
 * 前置门仍然是 `isMediaPath()`：同域静态资源（`/pbp/data`、`*.webmask`）
 * 照样进不来 —— 那条判据一个字都没动。
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
 * @returns 媒体分片则返回 host + 线路（`cls` 可能是 `unknown`）；
 *   不是媒体分片（或解析不出 host）返回 `null`
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
  /**
   * ## 第二个类别：只看主机（ADR 0042）
   *
   * `classifyCdn(host)` 不传 `search` ⇒ 第 5 条（`os=mcdn`）不可能命中 ⇒ 得到的是
   * 「这台机器本身属于哪条线路」。改写后的官方镜像在这一格是 `official`，
   * 而带 query 的 `cls` 仍是 `pcdn` —— 那一个差异正是面板要如实说出来的事实。
   *
   * ⚠️ 仍然只是**问同一个纯函数**（不是另写一份域名表，见 `MediaHost.hostCls`）。
   * ⚠️ 返回值里只有枚举，没有 query：`host` 仍是唯一被保留下来的字符串。
   */
  const hostCls = classifyCdn(host).cls;
  // ⚠️ 不再因为 `unknown` 返回 null —— 见函数头 P0-1 那一段
  return { host, cls, flavor, hostCls };
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
 * 记录时间轴的**原点**：`nav` @ `t = 0`。
 *
 * ## 为什么这不是"编一条事件"
 *
 * 时间轴的时基本来就是**页面导航开始**（`PerformanceResourceTiming.startTime` 与
 * `performance.now()` 都以 `timeOrigin` 为原点），尾注里那句"时间从页面开始加载
 * 算起"说的就是它。以前这句话只是文字，用户看到第一行是 `1.53s` 时会问
 * "1.53 秒之前干什么去了"—— 把原点画出来，那句话就变成了看得见的锚点。
 *
 * `t = 0` 是**定义**，不是测量值：导航开始那一刻没有比它更早的可观测点。
 *
 * ## 只在**安装时**记一次，`resetLoadingTrace()` 之后不补
 *
 * PGC 换集是 SPA 内切换，文档没有重新导航 —— 那时再补一条 `nav @ 0` 会把
 * "页面开始加载"插到换集之后的时间轴里，等于陈述一件没发生的事（而且会在它
 * 与这一集的第一个事件之间插出一条几分钟的空档行）。
 *
 * @param state 采集器状态（就地修改）
 */
export function recordNavStart(state: LoadingTraceState): void {
  pushEvent(state, { t: 0, stage: 'nav' });
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
 * ## 两条并列的通道（2026-11-17，T12）
 *
 * 同一个 `PerformanceObserver` 交进来的条目走两条互不干扰的判据：
 *
 * 1. **取流接口**（`recordPlayurl()`）：`playurl` 请求 → `playurl-req` / `playurl-res`。
 *    不带 host、不计入 `hosts`、**不碰** `lastSegReqCls` 闸门状态。
 * 2. **媒体分片**（本函数剩下的部分）：按 `cls` 闸门产出 `seg-req` / `seg-res`。
 *
 * 顺序是"先接口后分片"，因为前者判据更窄（host 必须是 B站 自己 + 路径含 `/playurl`），
 * 命中即返回；两条判据的**取值空间本来就不相交**（`bilibili.com` 不是任何 CDN 域），
 * 所以这个顺序只是省一次分类，不是语义依赖。
 *
 * @param state 采集器状态（就地修改）
 * @param entry 一条 resource 条目
 * @returns 本次是否**换了线路类别**（产出了一条新的 `seg-req`）
 */
export function recordResource(state: LoadingTraceState, entry: ResourceEntryLike): boolean {
  // 通道 1：B站 取流接口。命中就直接返回 —— 它不是线路，不该进 hosts，也不该动闸门
  if (recordPlayurl(state, entry)) return false;

  // 通道 2：媒体分片（下面全是原来的逻辑，一字未改）
  const resolved = resolveMediaHost(entry.name);
  if (resolved === null) return false;

  // 计数先记，且与闸门无关：它是"用过哪些 host"的唯一证据
  const known = state.hosts.get(resolved.host);
  if (known !== undefined) {
    known.count += 1;
  } else {
    /**
     * ⚠️ `hostCls` 必须一起存（ADR 0042）：面板要区分"官方镜像 + `os=mcdn`"与
     * "真实 PCDN 主机"，判据就是这个字段。漏存会让面板永远退回橙色 P2P。
     */
    state.hosts.set(resolved.host, {
      cls: resolved.cls,
      flavor: resolved.flavor,
      hostCls: resolved.hostCls,
      count: 1,
    });
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
 * 记录一条「扩展介入」（扩展真的动了这一次取流）。
 *
 * ## 两个触发点（2026-11-17，T13/P0-3 补上第二个）
 *
 * | 触发点 | 语义 | `note` |
 * | --- | --- | --- |
 * | `recordPlayurl()` + `state.streamingProxied` | DNR 换掉 Cookie，**接管**了取流 | `接管取流` |
 * | `noteExtPatch()`（主世界 `reportExtPatch()`） | XHR 改写响应体 **或** PGC 换整份 `video_info` | `接管取流`（2026-11-19 前是 `改写响应`） |
 *
 * 只有第二个触发点时，**首次观看**（没有历史进度可还原）永远不会出现这一行 ——
 * 而扩展其实在介入。这就是 P0-3 说的"覆盖面不够"。
 *
 * ## 数据从哪来（第二个触发点）
 *
 * `src/content/main-world.js` 的 `reportExtPatch()`：它在
 * `patchPlayurlXhrProgress()` **确认改写成功**之后发一条
 * `{ __ns, __PLUMA_EXT_PATCH__, at }`。跳过 / 失败 / 没改动 的分支不发 ——
 * 否则会出现"扩展介入了却什么都没改"的假事件。
 *
 * ## 为什么在这里收口"只记第一条"
 *
 * 主世界每次真改写都会上报（切清晰度会重新拉 playurl），而"扩展介入了"
 * 在一次页面里只发生一次。去重放在**采集侧**：主世界的职责是"我改了就说"，
 * "只显示一次"是显示层的事 —— 反过来做（让主世界自己判断"是不是第一次"）
 * 就等于在两个世界各维护一份"已经报过"的状态，迟早不一致。
 *
 * @param state 采集器状态（就地修改）
 * @param t 毫秒（主世界的 `performance.now()`，与采集侧同一时基）
 * @param note 介入方式的短语（当前恒为 `接管取流`；`note` 仍是参数是为了让
 *   单测能直接构造任意短语，也留给将来真的需要区分来源时）
 * @returns 本次是否真的记下了（`false` = 重复 / 时间戳非法 / 已经记过）
 */
export function recordExtPatch(state: LoadingTraceState, t: number, note?: string): boolean {
  if (state.extPatchRecorded) return false;
  // 与 `pushEvent()` 同一条纪律：非法时间戳直接丢，不修正成 0
  if (!Number.isFinite(t) || t < 0) return false;

  state.extPatchRecorded = true;
  pushEvent(
    state,
    note === undefined ? { t, stage: 'ext-patch' } : { t, stage: 'ext-patch', note },
  );
  return true;
}

/**
 * 记录一次**候选改写**的结果（ADR 0039，2026-11-17 接线）。
 *
 * ## 为什么是累加而不是覆盖
 *
 * 一次播放里三处取流点都可能改写：普通视频的 playurl、PGC 整页注入、PGC 切集换流。
 * 每个数都要算进去 —— 覆盖会让"整页注入换了 3 条、切集又换了 2 条"只剩最后那条。
 *
 * 参数直接来自主世界的 `pcdn-filter-stats` 消息（见 `main-world.js` 的
 * `reportPcdnFilter()`）。
 *
 * @param state 采集器状态（就地修改）
 * @param payload 主世界报来的这一条
 */
export function recordPcdnFilter(
  state: LoadingTraceState,
  payload: {
    applied: boolean;
    rewritten: number;
    proxied: number;
    fallbackKept: number;
    reason?: FilterSkipReason;
  },
): void {
  const count = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
  state.filter.rewritten += count(payload.rewritten);
  state.filter.proxied += count(payload.proxied);
  state.filter.fallbackKept += count(payload.fallbackKept);
  if (payload.applied === true) {
    state.filter.applied = true;
    /**
     * **真的过滤过之后，`reason` 必须消失**（2026-11-17）。
     *
     * 现实时序是这样的：开关开着、规则还没下发 → 主世界报一条
     * `reason: 'rulesMissing'`；随后规则到了、真的换掉了候选 → 再报一条
     * `applied: true`。若不清掉 reason，导出里就会出现
     * 「`applied: true` + `reason: 'rulesMissing'`」这种自相矛盾的一行，
     * 而读的人会去查一个已经不存在的问题。
     */
    delete state.filter.reason;
  }

  if (payload.reason !== undefined) state.filter.reason = payload.reason;
}

/**
 * 模块级入口：`content.ts` 收到主世界的 `pcdn-filter-stats` 时调用。
 */
export function notePcdnFilter(payload: {
  applied: boolean;
  rewritten: number;
  proxied: number;
  fallbackKept: number;
  reason?: FilterSkipReason;
}): void {
  recordPcdnFilter(state, payload);
}

/**
 * 模块级入口：`content.ts` 在**开关关着**时调一次，让导出能说清"没生效是因为关着"。
 *
 * 不覆盖已经记下的 `applied`：先开了开关过滤过、后来用户关掉，
 * 这一次页面仍然"真的过滤过"。
 */
export function notePcdnFilterOff(): void {
  if (state.filter.applied) return;
  state.filter.reason = 'off';
}

/**
 * 模块级入口：`content.ts` 收到主世界上报时调用。
 *
 * 与 `recordExtPatch(state, t)` 的分工和 `resetLoadingTrace()` 一样 ——
 * 单例的读写都在本模块里，外面不需要拿到 `state`。
 *
 * ## `note` 为什么不能固定写「改写响应」（2026-11-19 修）
 *
 * 主世界 `reportExtPatch()` 现在有**两个**语义不同的调用方，而它们共用
 * `{ __PLUMA_EXT_PATCH__, at }` 这一条消息，消息里**不带**来源标记：
 *
 * | 调用方 | 实际做了什么 | 说成「改写响应」对不对 |
 * | --- | --- | --- |
 * | `patchPlayurlXhrProgress()` | 改写 playurl 的 XHR 响应体（还原观看进度、换候选） | ✅ 对 |
 * | `pgcPatchPlayinfo()` | 在 `__playinfo__` setter 里**换掉 `result.video_info`** | ❌ **一个响应体都没碰** |
 *
 * 番剧页走的是第二条。把它显示成「改写响应」是**事实错误**，而时间轴明细行
 * 恰恰是用户用来分辨"扩展到底动了什么"的地方 —— 说错比不写更糟。
 *
 * ## 为什么用「接管取流」这个既有短语而不是新造一个
 *
 * 该短语在本文件里已经存在（`recordPlayurl()` 那条，语义是"DNR 换掉 Cookie，
 * 接管了取流"）。PGC 整页注入**确实**属于接管取流：它把播放器要读的整份流
 * 换成了播放账号那份，一次 playurl 都不用发。用同一个短语，用户不必学第三套说法，
 * 面板图例与文案也不需要第三项。
 *
 * ⚠️ 代价要说清：现在两条路径（`recordPlayurl()` 与这里）都写「接管取流」，
 * 所以**从明细行无法区分**"是 DNR 代理"还是"是 PGC 整页注入"。这是**故意的**：
 * 两者对用户是同一件事（扩展接管了这次取流）。要区分请查 `hosts` 与
 * `_trace` 的 `pgcTrace`，那是排查用的字段，不属于时间轴的语义层级。
 *
 * @param t 毫秒（主世界的 `performance.now()`，与采集侧同一时基）
 */
export function noteExtPatch(t: number): boolean {
  return recordExtPatch(state, t, '接管取流');
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
    .map(([host, stat]) => ({
      host,
      cls: stat.cls,
      flavor: stat.flavor,
      // ADR 0042：摊出来，面板与导出都要靠它分辨"官方镜像 + os=mcdn"
      hostCls: stat.hostCls,
      count: stat.count,
    }))
    .sort((a, b) => (a.count === b.count ? (a.host < b.host ? -1 : 1) : b.count - a.count));

  // 排序后第一条真实线路就是 count 最大的那条；`unknown` 不参与（它没有线路）
  const top = hosts.find((h) => REAL_KINDS.includes(h.cls));
  const timeline = buildTimeline(state.events, EVENT_LIMIT);

  return {
    present: hosts.length > 0 || timeline.events.length > 0,
    confidence: hosts.length > 0 ? 'measured' : 'none',
    actual:
      top === undefined
        ? null
        : { host: top.host, cls: top.cls, flavor: top.flavor, hostCls: top.hostCls },
    hosts,
    events: shiftToOrigin(timeline.events, state.originT),
    truncated: state.truncated || timeline.truncated,
    // 候选过滤的累计值（永远是对象，消费方不必判空）
    filter: { ...state.filter },
    video,
    // 恒填（可选只是为了不打断手工构造 fixture 的几十个测试）
    originT: state.originT,
  };
}

/**
 * 把时间轴事件的 `t` 平移到**本集起点**（`originT`）—— 归零的唯一实现处。
 *
 * ## 为什么必须在 `buildTimeline()` **之后**做
 *
 * `buildTimeline()` 的排序与去重都以**原始** `t` 为准（同一时刻的两条事件必须
 * 仍然相等才能去重）。先平移再交进去，等于让它在一份已经被动过的时基上排序 ——
 * 排序本身还成立（单调平移保序），但"去重键相同"这件事会变得依赖 `originT`
 * 的精度，是一个没人会想到的前提。所以顺序是：**先归一，再平移**。
 *
 * ## `originT === 0` 时原样返回（不产出新数组）
 *
 * 首屏那 200+ 例测试跑的就是这条路。多一个 `map()` 不只是浪费：
 * 返回新数组会让"事件对象是同一个引用"这类断言从"显然"变成"碰巧"。
 *
 * ## 平移后钳在 `0`
 *
 * `resetLoadingTrace()` 之后理论上不该有早于原点的残留事件，但**兜底判据要写死**：
 * 负的 `t` 会在面板上出现两个错 —— `clockText()` 有 `ms > 0` 守卫，负数被
 * 显示成 `0.00`（看起来正常，掩盖了异常）；而 `+x.xxs` 的增量是两个 `t` 相减，
 * 会算出一个荒谬的负增量。所以钳在 0，不产出负数。
 *
 * @param events 已归一（排序 + 去重）的事件
 * @param originT 输出原点（毫秒）；`0` = 不平移
 */
function shiftToOrigin(events: LoadEvent[], originT: number): LoadEvent[] {
  if (originT <= 0) return events;
  return events.map((event) => ({ ...event, t: Math.max(0, event.t - originT) }));
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

  /**
   * 原点先画（`nav` @ 0，见 `recordNavStart()`）。
   *
   * 放在观察器之前：`buffered: true` 会把安装前就发生的条目补进来，其中可能有
   * `startTime` 比"现在"更早的 playurl —— 先记 nav 不影响顺序（`buildTimeline()`
   * 按 `t` 排序），只是让"这条时间轴有原点"这件事与"有没有装成观察器"无关。
   */
  recordNavStart(state);

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
 *
 * ## ⚠️ 它**不**顺手记时间原点（`originT` 回到 `0`）
 *
 * 换集后要让时间轴从本集 0.00s 起算，调用方必须**紧接着**调
 * `markTraceOrigin(performance.now())`。两条调用是刻意的：本函数的语义是"清空"，
 * 让它顺手读时钟猜一个原点会把两个职责混在一起（详见 `markTraceOrigin()` 的注释）。
 * 漏了那一句的后果不是崩溃，而是**新一集的时间轴仍然显示 55.62s 这种大数**。
 */
export function resetLoadingTrace(): void {
  state = createTraceState();
}
