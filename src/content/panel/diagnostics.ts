/**
 * 面板的诊断视图 —— 自检信息 + 诊断日志 + 导出 JSON。
 *
 * ## 数据全部复用，不重写
 *
 * | 数据 | 来源 | 为什么不能复制 |
 * | --- | --- | --- |
 * | 自检信息 | `collectFacts()` | 它是「诊断事实的唯一数据源」（`collect.ts` 文件头） |
 * | 日志 | `readDiag()` | 环形缓冲的读取口径只有一处 |
 * | 提示 | `tipFor()` | 两处 UI 各算一份必然出现"一边说正常、一边说异常" |
 *
 * ## ⚠️ 凭据边界（`AGENTS.md` §5.2）
 *
 * 导出的 JSON **绝不含凭据**。防线有两条：
 *
 * 1. `collectFacts()` 本来就只产状态与计数（且 `collect.ts` 有一条源码级断言
 *    禁止它输出 `requestHeaders`）
 * 2. 本文件的 `buildExportPayload()` 只包**固定字段**，见那里的注释
 *
 * 单测：`tests/unit/content/panel-diagnostics-export.test.ts`
 *
 * ## 与 options 那份的关系
 *
 * 阶段 4 会删掉 `entrypoints/options/`。为了**诊断包形状不因搬家而变化**，
 * `buildExportPayload()` 的字段与顺序与 options 的 `exportDiag()` 保持一致
 * （`exportedAt` / `version` / `facts` / `logs`）。有单测守着。
 */

import type { DiagEntry, DiagRow } from '@platform/diagnostics/collect';
import { tipFor } from '@platform/diagnostics/collect';
import type { CdnKind } from '@core/cdn/classify';
import { currentSegment, detectSwitches } from '@core/loading/timeline';
import { el, iconChevron } from './dom';
import { playingEvent, type LoadingOutcome } from './loading-pane';

/**
 * 一次「读诊断日志」这件事本身**成没成**。
 *
 * ## 为什么必须有一个独立的"成没成"（2026-11-12，task-26）
 *
 * `readDiag()` 内部是 `catch { return [] }` —— **读失败和"真的一条都没有"
 * 返回的是同一个值 `[]`**。如果 `ok` 用 `logs.length > 0` 去推，那么
 * **孤儿态（`Extension context invalidated`）会被推成"没有日志"**，
 * 而这正是用户两次导出拿到 `"logs": []` 却以为是"没记录"的原因。
 *
 * 所以 `ok` 必须是**这次读取真的没抛错**，由 `panel.ts` 在调用点自己
 * try/catch 得到（**沿路看清：「不改 `readDiag()` 的返回值语义」**）。
 *
 * 详见 `poc/probe/diag-export/REPORT.md`。
 */
export interface LogsMeta {
  /** 本次是否真的读到了 storage。`false` = 读失败（孤儿态 / 权限），**不是"没有日志"** */
  ok: boolean;
  /**
   * 读失败时的错误串，已**白名单化 + 截断**（见 `describeLogsError()`）。
   * `null` = 没失败（或错误串本身不可识别）。
   */
  err: string | null;
  /** 读到的条数。`ok === false` 时恒为 0，但**必须结合 `ok` 看** */
  count: number;
  /** 环形缓冲上限（`DIAG_LIMIT`，从 `diag-store` 导入，不写死） */
  limit: number;
  /** 读日志的那个实例（split 下普通/无痕是两个 SW） */
  instanceId: string;
  /** 读取时刻（`Date.now()`） */
  readAt: number;
}

/**
 * 错误串**白名单化**。
 *
 * ## 为什么不能 `String(e)` 原样透传（2026-11-12，task-26）
 *
 * 导出包是整个项目里**唯一一个会离开本机的文件**，而这道防线是"只包固定字段"
 * （见 `buildExportPayload()`）。把 `String(e)` 直接放进去，等于给任何未来的
 * 异常对象开了一条**不受控的字符串出口** —— 它的 `message` 里有什么我们不知道
 * （可能是 DNR 规则全文、可能是带 cookie 的 URL）。
 *
 * 所以只认**已知的固定串**，其余一律归成 `'unknown'`；并且任何情况下都截断。
 * 用户仍然能区分"孤儿态"和"别的失败"，而不会有一字节未知内容被带出去。
 */
export function describeLogsError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  /**
   * 只认这几个固定串。`Extension context invalidated.` 是 Chrome 在
   * "content script 所属扩展上下文已被销毁"时的固定错误串 —— 它正是孤儿态的指纹。
   */
  const KNOWN: readonly [string, string][] = [
    ['Extension context invalidated', 'Extension context invalidated.'],
    ['chrome.runtime is undefined', 'chrome.runtime is undefined'],
    ['Cannot read properties of undefined', 'chrome.runtime is undefined'],
    ['The message port closed', 'The message port closed'],
  ];
  for (const [needle, label] of KNOWN) {
    if (raw.includes(needle)) return label;
  }
  return 'unknown';
}

/**
 * 导出 payload 的字段与顺序 —— **与 options 的 `exportDiag()` 一致**。
 *
 * ## 为什么写死这几个字段，而不是"把 rows 和 logs 原样 stringify"
 *
 * 因为"只包这几个"本身就是一道**凭据防线**：
 * 将来谁想在诊断数据里加一个字段，就必须先改这里 ——
 * 而那一步会撞上 `panel-diagnostics-export.test.ts` 的形状守卫。
 *
 * 如果直接 `JSON.stringify({ ...collectFacts(), ...readDiag() })`，
 * 加字段是**无声的**，泄漏也是无声的。
 */
export interface ExportPayloadSource {
  rows: readonly DiagRow[];
  logs: readonly DiagEntry[];
  /** 扩展版本；调用方从 `chrome.runtime.getManifest().version` 取 */
  version: string;
  /** 导出时刻（注入以便测试固定） */
  now: Date;
  /**
   * 定位追踪（`pluma:diag-trace` 的最近一条）。
   *
   * ## 为什么必须进导出（2026-11-10 第七轮）
   *
   * 主日志是环形缓冲（上限 `DIAG_LIMIT`，见 `src/platform/storage/diag-store.ts`），
   * `page/quality` 每几秒写一轮就能把它冲干净 ——
   * 定位信息活不下来。所以 `diag/facts` 的结果另写一条**覆盖式**追踪。
   *
   * 导出里带上它，smoke 就**一定能读到**，不依赖面板是否把那一块渲染出来。
   *
   * `null` = 没有追踪记录（还没触发过）。
   */
  trace: {
    at: number;
    step: string;
    detail: string;
    from: string;
  } | null;
  /**
   * `diag/facts` 应答里的调试回显（2026-11-10 第八轮）。
   *
   * ## 为什么它和 `trace` 并存
   *
   * `trace` 走 storage，**真机上写不进去**（smoke 实测）。
   * `echo` 走**消息应答**，从没丢过。
   *
   * 两个都放进导出：`trace` 能写就是额外信息，写不进时有 `echo` 兜底。
   *
   * 内容形如 `entered | incognito=ok:true windows=nil cookies=ERR:TypeError ...`。
   * `null` = 还没有 / 老版本 background。
   */
  echo: string | null;
  /**
   * 诊断日志这一次**读成没读成**（2026-11-12，task-26 第七个字段）。
   *
   * ## 为什么日志本身不够，还要一个"读成没读成"
   *
   * 用户两次导出拿到 `"logs": []`，以为"这台机器没记日志"，
   * 而实际是**孤儿态**（`Extension context invalidated`）—— `readDiag()`
   * 的静默 `catch { return [] }` 把"读失败"和"真没有"压成了同一个值。
   *
   * 只给 `count` 修不了这个缺陷：孤儿态下 `count` 依旧是 `0`，
   * 和"真的没有日志"**长得一模一样**。所以这里必须有独立的 `ok`。
   */
  logsMeta: LogsMeta;
  /**
   * 加载时间轴的**通道结局**（2026-11-20，T8 第八个字段）。
   *
   * 传的是面板模型里那一份原始结局，不是渲染后的文案 ——
   * 导出要的是数据，`buildLoadingExport()` 负责裁剪成可外传的形状。
   */
  loading: LoadingOutcome;
}

// ─────────────────────── 第八个字段：本次加载（T8，2026-11-20）───────────────────────

/**
 * 导出里 host 的白名单。
 *
 * ## 为什么要白名单化，而不是"反正只有 hostname"
 *
 * 快照是从**另一个 content script 实例**经 `postMessage` 过来的普通对象 ——
 * 形状由发送方决定，面板只在桥那里粗验了 `present` / `events`。
 * 导出是**唯一会离开本机的文件**，所以这里的判据不能建立在"上游会守规矩"上。
 *
 * 只允许小写字母 / 数字 / 点 / 连字符（`abc-1.bilivideo.com` 这种），
 * 长度取 DNS 上限 253。任何其它内容（含 `:` 端口、`/` 路径、`?` query、大写）
 * 一律写成 `'invalid'` —— 不留原文，也就没有"只漏半截"的可能。
 */
export function sanitizeHost(host: unknown): string {
  if (typeof host !== 'string') return 'invalid';
  return /^[a-z0-9.-]{1,253}$/.test(host) ? host : 'invalid';
}

/** 导出里允许出现的线路类别（`CdnKind` 的全集，逐个列出以防上游漂移） */
const EXPORT_CLASSES: readonly CdnKind[] = ['official', 'pcdn', 'third-party', 'unknown'];

/** 导出里允许出现的官方二级分类；`null` 是合法值（认不出机型） */
const EXPORT_FLAVORS: readonly ('self-built' | 'partner')[] = ['self-built', 'partner'];

/**
 * 导出里允许出现的阶段。
 *
 * ## ⚠️ `'unknown'` **不在 `LoadStage` 里**，它是导出层专属的同义词
 *
 * 别去 `core/loading/timeline.ts` 找它 —— 那里没有，也不该加：`LoadStage` 是
 * "采集侧能产出什么"的枚举，而 `'unknown'` 是"**收到的不是那 10 个值之一**"。
 * 两者的主语不同（2026-11-20 Lead 裁决，留兜底值、但把这件事写在这里）。
 *
 * 为什么保留而不是丢弃整条事件：丢了就没法解释"为什么条数对不上"；
 * 标成 `unknown` 至少让读的人知道**有一条事件我们没看懂**。
 *
 * ⚠️ 2026-11-20（T13）：`switch` / `blocked` 随 `LoadStage` 一起删了 ——
 * 它们从来没有生产者，列在这里等于告诉消费者"可能有这两种事件"。
 */
const EXPORT_STAGES: readonly string[] = [
  'nav',
  'playurl-req',
  'playurl-res',
  'ext-patch',
  'seg-req',
  'seg-res',
  'canplay',
  'playing',
  'stall',
  'error',
  /** ⚠️ 导出层兜底值，不是 `LoadStage` 的成员（见上） */
  'unknown',
];

/** 一条 host 统计进导出后最多留几条（按 count 降序取前 N，总数另给 `hostCount`） */
const EXPORT_HOST_LIMIT = 20;

/** 只取枚举内的值；认不出就用兜底值（**不把原串带出去**） */
function pickOne<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 非有限数一律当 0 —— JSON 装不下 `NaN`，而 `null` 会让消费方以为"没这个字段" */
function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 一条事件在导出里的形状。
 *
 * ## 2026-11-20（T13，P1-6）：`error` 多一个 `code`
 *
 * `MediaError.code` 以前采了又扔（`recordVideoStage()` 写进 `note`，导出按白名单
 * 剥掉）。后果是排查时「播放出错」和「卡了一下」在导出里长得一样 ——
 * 分不清"网慢"与"被拦"。现在**只对 `stage === 'error'`** 把 `note` 里的
 * `code=N` 解析成数字字段。
 *
 * ⚠️ 解析不到就**不加这个键**，绝不写 `0`：`0` 是 `MEDIA_ERR_ABORTED` 的合法码，
 * 写下去等于陈述"用户主动中止了"。这与 `finite()` 把非有限数当 0 的处理不同 ——
 * 那些字段（`t` / `count`）本来就必须有值。
 */
export interface LoadingExportEvent {
  t: number;
  stage: string;
  host?: string;
  kind?: string;
  /** `MediaError.code`（只有 `stage === 'error'` 且解析得到时才有） */
  code?: number;
}

/**
 * 从 `note` 里取 `MediaError.code`。
 *
 * `recordVideoStage()` 写的是 `code=3` 这种形式（见 `loading-trace.ts`）。
 * 只认这一种形状；取不到返回 `null`（调用方据此**不加键**）。
 *
 * @param note 事件的 `note` 字段
 */
function parseErrorCode(note: string | undefined): number | null {
  if (note === undefined) return null;
  /**
   * 容两种写法：生产端是 `code=3`，而排查笔记里可能被写成 `MediaError.code=3`。
   * 前面那个字符类排除 `[a-z0-9_]`，所以 `xcode=3` 这类不会被误读。
   */
  const match = /(?:^|[^a-z0-9_])code=(\d+)/i.exec(note);
  if (match === null) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) && code >= 0 ? code : null;
}

/**
 * 第八个字段的形状。字段顺序即导出顺序。
 *
 * ## 为什么 `status !== 'ok'` 时其余字段是"空"而不是"猜一个"
 *
 * 拿不到快照时，"0 条线路 / 0 次切换"看起来像**测到了 0**。所以那三态只有
 * `status` 是真话，其余给 `null` / `[]` / `0`，并且**消费方必须先看 `status`**。
 * 这与 `logsMeta.ok` 同一条纪律：读失败不许伪装成空态。
 *
 * ## ⚠️ 这里**没有** `capturedAt`（2026-11-20 Lead 裁决）
 *
 * 第一版加过一个 `capturedAt`，值是"组装导出的时刻" —— 那个名字在说谎：
 * `LoadingSnapshotLite` 里**没有采集时间戳**（采集器只记每条事件相对
 * `timeOrigin` 的偏移），而顶层 `exportedAt` 已经把"导出时刻"写了一遍。
 * 同一份数据写两遍，还带一个会让人以为"快照是那一刻抓的"的名字。
 *
 * 将来真要让采集器回带采集时刻（`fetchLoadingSnapshot` 加一个 `at`），
 * 再把它加回来**并给真值** —— 那时这个名字才有意义。
 */
export interface LoadingExport {
  status: 'ok' | 'absent' | 'unanswered';
  present: boolean;
  confidence: 'measured' | 'none';
  actual: { host: string; cls: string; flavor: string | null } | null;
  hosts: Array<{ host: string; cls: string; flavor: string | null; count: number }>;
  /** 截断**之前**的 host 总数 */
  hostCount: number;
  hostsTruncated: boolean;
  events: LoadingExportEvent[];
  /**
   * 快照内事件超过 `LOADING_EVENT_LIMIT` 而被**这里**截掉的（界面/导出各 40 条）。
   *
   * ⚠️ 与下面的 `eventsLostBeforeWindow` **不是同一件事**，两者必须能分开读：
   *
   * | 字段 | 谁丢的 | 含义 |
   * | --- | --- | --- |
   * | `eventsTruncated` | 导出这一层 | 快照里有更多条，导出只装前 40 条 |
   * | `eventsLostBeforeWindow` | **采集器的环形缓冲** | 更早的事件在采集时就没了，`events[0]` 不是页面开始 |
   */
  eventsTruncated: boolean;
  /**
   * 采集窗口是否已经截断（来自 `snapshot.truncated`，2026-11-20 T13/P1-7）。
   *
   * 语义是"**时间轴的开头不是页面开始**"：环形缓冲只留最近 200 条，
   * 更早的被丢掉了。以前这个信息只活在 L2 浮层里，导出里没有出口 ——
   * 消费者看到 `eventsTruncated: false` 会以为一条都没丢过。
   */
  eventsLostBeforeWindow: boolean;
  video: { readyState: number; durationSec: number; height: number; errorCode: number } | null;
}

/**
 * 通道结局 → 可外传的加载字段（**导出的唯一入口**）。
 *
 * ## 四条硬裁剪（每一条都有单测）
 *
 * | 规则 | 做法 |
 * | --- | --- |
 * | 剥 `note` | `LoadEvent.note` 可能是 `MediaError.code=3` 这类自由文本，只挑四个键输出 |
 * | host 白名单 | `sanitizeHost()`，认不出一律 `'invalid'` |
 * | 枚举化 | `status` / `confidence` / `cls` / `flavor` / `stage` / `kind` 只可能是固定值 |
 * | 无 query / 无 path | host 走白名单之后，本来就没有 `/` 与 `?` 能进来 |
 *
 * 不接时刻参数：这一块**没有**任何时间戳字段（见 `LoadingExport` 的注释），
 * 顶层 `exportedAt` 已经表达了导出时刻。
 *
 * @param outcome 面板模型里那一份原始结局
 */
export function buildLoadingExport(outcome: LoadingOutcome): LoadingExport {
  if (outcome.kind !== 'ok') {
    return {
      status: outcome.kind,
      present: false,
      confidence: 'none',
      actual: null,
      hosts: [],
      hostCount: 0,
      hostsTruncated: false,
      events: [],
      eventsTruncated: false,
      eventsLostBeforeWindow: false,
      video: null,
    };
  }

  const snapshot = outcome.snapshot;

  const actual =
    snapshot.actual === null
      ? null
      : {
          host: sanitizeHost(snapshot.actual.host),
          cls: pickOne(snapshot.actual.cls, EXPORT_CLASSES, 'unknown'),
          flavor:
            snapshot.actual.flavor === null
              ? null
              : pickOne(snapshot.actual.flavor, EXPORT_FLAVORS, 'partner'),
        };

  const allHosts = Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
  const hosts = allHosts.slice(0, EXPORT_HOST_LIMIT).map((h) => ({
    host: sanitizeHost(h.host),
    cls: pickOne(h.cls, EXPORT_CLASSES, 'unknown'),
    flavor: h.flavor === null ? null : pickOne(h.flavor, EXPORT_FLAVORS, 'partner'),
    count: finite(h.count),
  }));

  const allEvents = Array.isArray(snapshot.events) ? snapshot.events : [];
  const events: LoadingExportEvent[] = allEvents.slice(0, LOADING_EVENT_LIMIT).map((e) => {
    /**
     * ⚠️ **逐个字段挑**，绝不用展开（`{...e}`）—— `note` 会跟着出去，
     * 而它可能含 `MediaError.code` 之类自由文本。这是本轮唯一一条
     * "少写一行就泄漏"的地方，所以是白名单而不是黑名单。
     */
    const out: LoadingExportEvent = {
      t: finite(e.t),
      stage: pickOne(e.stage, EXPORT_STAGES, 'unknown'),
    };
    if (typeof e.host === 'string' && e.host.length > 0) out.host = sanitizeHost(e.host);
    if (typeof e.kind === 'string' && e.kind.length > 0) {
      out.kind = pickOne(e.kind, EXPORT_CLASSES, 'unknown');
    }
    /**
     * `MediaError.code`：只对 `error` 解析，解析不到**不加键**（见
     * `LoadingExportEvent` 的注释 —— 写 0 会被读成 `MEDIA_ERR_ABORTED`）。
     */
    if (out.stage === 'error') {
      const code = parseErrorCode(e.note);
      if (code !== null) out.code = code;
    }
    return out;
  });

  const video = snapshot.video;

  return {
    status: 'ok',
    present: snapshot.present === true,
    confidence: snapshot.confidence === 'measured' ? 'measured' : 'none',
    actual,
    hosts,
    hostCount: allHosts.length,
    hostsTruncated: allHosts.length > EXPORT_HOST_LIMIT,
    events,
    eventsTruncated: allEvents.length > LOADING_EVENT_LIMIT,
    // ⚠️ 来自采集器（环形缓冲），与上一行的"导出层只装 40 条"是两件事
    eventsLostBeforeWindow: snapshot.truncated === true,
    video:
      video === null
        ? null
        : {
            readyState: finite(video.readyState),
            durationSec: finite(video.durationSec),
            height: finite(video.height),
            errorCode: finite(video.errorCode),
          },
  };
}

/** 组装导出 JSON 的文本。**不开新的字段**，见上面注释 */
export function buildExportPayload(src: ExportPayloadSource): string {
  return JSON.stringify(
    {
      exportedAt: src.now.toISOString(),
      version: src.version,
      facts: src.rows,
      logs: src.logs,
      /**
       * ⚠️ 这是第五个字段。加它是因为**前四个装不下定位信息**
       * （`logs` 是环形缓冲，会被高频日志挤掉）。
       *
       * 它仍然遵守"绝不含凭据"：`detail` 只由 `diag/facts` 的应答摘要构成
       * （四项环境事实，不含任何凭据值、不含 token）。
       * `panel-diagnostics-export.test.ts` 的扫描覆盖了它。
       */
      trace: src.trace,
      /**
       * ⚠️ 第六个字段。理由与 `trace` 相同但更硬：
       * `trace` 走 storage 可能写不进，`echo` 走**消息应答**从没丢过。
       * 两者并存，任一路能通就能定位。
       *
       * 仍然不含凭据：内容只是四项环境事实的执行摘要
       * （`ok:true` / `nil` / `ERR:...` / `TIMEOUT`），不涉及任何账号数据。
       */
      echo: src.echo,
      /**
       * ⚠️ 第七个字段（2026-11-12，task-26）。
       *
       * **仍然遵守"绝不含凭据"，而且这一条的约束比前六个更硬**，因为它带了一个
       * 自由文本字段 `err`。三道闸：
       *
       * 1. `err` **不是** `String(e)`，而是 `describeLogsError()` 的**白名单**
       *    输出（只可能是 `'Extension context invalidated.'` / `'unknown'` 等
       *    几个固定串），所以不存在"意外对象被带出去"这条路
       * 2. 其余五个字段都是**计数 / 布尔 / 实例 id / 时间戳**（`instanceId` 是
       *    `Math.random().toString(36)` 的 6 位，与任何账号无关）
       * 3. `panel-diagnostics-export.test.ts` 的形状守卫与凭据扫描都覆盖了它
       *
       * 为什么值得多加这一个字段：没有它，孤儿态导出的 `logs: []` 会
       * **伪装成"没有日志"**，而导出恰恰是最需要它诚实的那一刻。
       */
      logsMeta: src.logsMeta,
      /**
       * ⚠️ 第八个字段（2026-11-20，T8）：**本次加载**。
       *
       * 它与前七个的区别：前七个都是"扩展自己的状态"，只有它描述
       * **页面自己在做什么**（分片从哪条线路来的）。形状见 `LoadingExport`。
       *
       * 三道闸，缺一不可：
       *
       * 1. **只挑四个键**（`t` / `stage` / `host` / `kind`）—— `LoadEvent.note`
       *    可能含 `MediaError.code` 这类自由文本，白名单式挑字段而不是黑名单式删
       * 2. **host 白名单化**（`sanitizeHost()`），query / path / 端口根本进不来
       * 3. **枚举化**（`pickOne`）—— 上游给了不认识的类别/阶段也不会把原串带出去
       *
       * ⚠️ `status !== 'ok'` 时其余字段是 `null` / `[]` / `0`，**不是猜出来的默认值**。
       * 消费方必须先看 `status` —— 与 `logsMeta.ok` 同一条纪律。
       */
      loading: buildLoadingExport(src.loading),
    },
    null,
    2,
  );
}

/** 导出文件名（带时间戳，避免多次导出互相覆盖） */
export function exportFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `pluma-diag-${stamp}.json`;
}

/**
 * 触发浏览器下载。
 *
 * ## 为什么不用 `chrome.downloads`
 *
 * 那要申请 `downloads` 权限，而本项目**不新增权限**（`AGENTS.md` §3 决策 6 的邻域：
 * 能不加就不加）。Blob + `<a download>` 完全够用，且不经过扩展 API。
 *
 * ⚠️ 在 Shadow DOM 里创建 `<a>` 没问题 —— 但**必须 attach 到 document 才能点击**
 * （detached 元素在部分浏览器里 `click()` 不触发下载）。用完立刻摘掉。
 */
export function downloadJson(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  // 不渲染、不占位；只为让 click() 生效
  a.style.display = 'none';
  (document.body ?? document.documentElement).appendChild(a);
  a.click();
  a.remove();
  /**
   * 延迟 revoke：立刻 revoke 在部分浏览器里会让下载中断。
   * 用 setTimeout(0) 已经够 —— 点击是同步处理的。
   */
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * 一行自检事实：`ok===true` 绿 / `false` 红 / 省略中性。
 *
 * ## 2026-11-16：行首加状态点
 *
 * 原来只有**数值**变颜色 —— 一屏十几行时，观众要靠读右列的每一个字才能判断
 * "哪几项不对"。加一个 6px 的点在最左列，这一列就成了纵向扫描轴（方案 §2.1 D3）。
 *
 * ⚠️ **`ok === undefined` 也要渲染一个透明点**：不能"没有状态就不占位"，
 * 否则同一列里有点与没点的行，标签起始位置差 12px，看起来像没对齐。
 */
function factRow(r: DiagRow): HTMLElement {
  const tone = r.ok === true ? ' ok' : r.ok === false ? ' bad' : '';
  const row = el('div', `diag-row${tone}`);
  row.appendChild(el('span', 'diag-dot'));
  row.appendChild(el('span', 'diag-label', r.label));
  row.appendChild(el('span', 'diag-value', r.value));
  return row;
}

/** 一条诊断日志：`step` + 时间 + 可选 detail */
function logRow(e: DiagEntry): HTMLElement {
  const row = el('div', 'diag-log');
  const t = new Date(e.at);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  row.appendChild(el('span', 'diag-time', `${hh}:${mm}:${ss}`));
  row.appendChild(el('span', 'diag-step', e.step));
  if (e.detail) row.appendChild(el('span', 'diag-detail', e.detail));
  return row;
}

// ─────────────────────── 「本次加载」区块（T7，2026-11-20）───────────────────────

/**
 * 线路类别 → 中文短名。
 *
 * ⚠️ 与 `loading-pane.ts` 的 `B站官方线路（自建 CDN）` **不是同一套文案**：
 * 那是普通层（用户在画质 Tab 里看的），这里是 **L3 技术层** ——
 * 排查时要能对着 `classify.ts` 的枚举值念出来，所以摘要行用技术名
 * （`official` / `pcdn`），只在这个紧凑的"线路数"括号里用短名。
 */
const CLASS_SHORT: Record<CdnKind, string> = {
  official: '官方',
  pcdn: 'PCDN',
  'third-party': '第三方',
  unknown: '未知',
};

/** 枚举顺序（线路数括号里的顺序，固定，不按出现顺序） */
const CLASS_ORDER: readonly CdnKind[] = ['official', 'pcdn', 'third-party', 'unknown'];

/** 毫秒数照实打印（`2525.9ms`）。非有限数标出来，不四舍五入成一个看着合理的值 */
function msText(t: number): string {
  return Number.isFinite(t) ? `${Math.round(t * 10) / 10}ms` : 'invalid';
}

/**
 * 原始事件表最多渲染几行。
 *
 * ⚠️ 与导出用的 `LOADING_EVENT_LIMIT` **是同一个值、也是同一个常量**：
 * 界面与导出条数一致，才能拿着截图和 JSON 逐行核对。
 */
const LOADING_EVENT_LIMIT = 40;

/**
 * 「本次加载」区块要渲染的节点（顺序即插入顺序）。
 *
 * ## 三态必须分开画（本节最要紧的一条）
 *
 * | 结局 | 表现 |
 * | --- | --- |
 * | `ok` | 五行摘要 + 可折叠的原始事件表 |
 * | `absent` | 一行中性色：本页没有加载记录（不是播放页） |
 * | `unanswered` | 一行**危险色**：读取失败（无应答）—— 刷新页面后重试 |
 *
 * ⚠️ `unanswered` 画成"没有记录"就是 `logsMeta.ok` 那次事故的复发：
 * 读失败伪装成空态，用户和排查者都会去查错方向。
 *
 * @param outcome 面板模型里那一份原始结局（`undefined` 与 `absent` 同义）
 */
export function loadingSectionNodes(outcome: LoadingOutcome | undefined): HTMLElement[] {
  const nodes: HTMLElement[] = [el('p', 'diag-section', '本次加载')];

  if (outcome === undefined || outcome.kind !== 'ok') {
    if (outcome?.kind === 'unanswered') {
      nodes.push(
        factRow({
          label: '加载记录',
          value: '加载快照读取失败（无应答）—— 刷新页面后重试',
          ok: false,
        }),
      );
    } else {
      nodes.push(factRow({ label: '加载记录', value: '本页没有加载记录（不是播放页）' }));
    }
    return nodes;
  }

  const snapshot = outcome.snapshot;

  // ── 摘要行：技术层，允许完整 host ──
  /**
   * `flavor === null` 显示成 `—`（2026-11-20，T13 文案）。
   *
   * 以前这里直接打印 `null` —— 那是 **JSON 字面量**，不是给用户看的文案。
   * 技术层的读者会以为是"字段缺失 / 解析失败"，而 `null` 的真实含义是
   * "`classifyCdn()` 认不出是自建还是服务商，它不猜"。破折号表达"没有值"，
   * 与导出的 `null`（给机器）分工明确。
   */
  const flavorText = (flavor: string | null): string => (flavor === null ? '—' : flavor);

  const actual = snapshot.actual;
  const actualValue =
    actual === null ? '未识别' : `${actual.cls} · ${flavorText(actual.flavor)} · ${actual.host}`;

  const byClass = new Map<CdnKind, number>();
  for (const h of snapshot.hosts) byClass.set(h.cls, (byClass.get(h.cls) ?? 0) + 1);
  const breakdown = CLASS_ORDER.filter((c) => (byClass.get(c) ?? 0) > 0).map(
    (c) => `${CLASS_SHORT[c]} ${String(byClass.get(c) ?? 0)}`,
  );
  const hostsValue = `${String(snapshot.hosts.length)} 条${breakdown.length > 0 ? `（${breakdown.join(' · ')}）` : ''}`;
  const hasPcdn = (byClass.get('pcdn') ?? 0) > 0;

  /**
   * ## 两行线路，别二选一（2026-11-20，T13/P0-2）
   *
   * 旧实现只有一行「当前线路」，值取自 `hosts` 按 count 排序的第一条（argmax）。
   * 中途被切到 PCDN 之后，argmax 仍可能指着**已经不再用**的那条 ——
   * 界面却写着"当前"。两个问题混在一个词里，答案必然是错的。
   *
   * 现在分开：
   * - `主要线路（按请求数）` = argmax，回答"这次整体主要走哪条"
   * - `当前线路（最后一次请求）` = 最后一条 `seg-req`，回答"此刻在用哪条"
   *
   * 两者是**同一条**时只显示一行「当前线路」—— 否则两行一模一样的值，
   * 读的人会怀疑自己漏了什么。
   */
  const current = currentSegment(snapshot.events);
  const currentHost = current?.host ?? null;
  /**
   * 当前线路的 `cls` / `flavor`：优先用 `hosts` 里的统计（那里有 `flavor`），
   * 找不到就退回事件自带的 `kind`（`hosts` 被环形截断过时可能查不到）。
   */
  const currentStat =
    currentHost === null ? undefined : snapshot.hosts.find((h) => h.host === currentHost);
  const currentCls = currentStat?.cls ?? current?.kind ?? null;
  const currentValue =
    currentHost === null
      ? '未记录'
      : `${String(currentCls)} · ${flavorText(currentStat?.flavor ?? null)} · ${currentHost}`;

  if (actual !== null && actual.host === currentHost) {
    const only = factRow({ label: '当前线路', value: currentValue });
    if (currentCls === 'pcdn') only.classList.add('warn');
    nodes.push(only);
  } else {
    const mainRow = factRow({ label: '主要线路（按请求数）', value: actualValue });
    // 走了 PCDN 就给警告色：那是这个功能唯一想让人看见的事
    if (actual?.cls === 'pcdn') mainRow.classList.add('warn');

    const currentRow = factRow({ label: '当前线路（最后一次请求）', value: currentValue });
    // 当前线路是 P2P 时更要紧：用户**此刻**正在被切走
    if (currentCls === 'pcdn') currentRow.classList.add('warn');

    nodes.push(mainRow, currentRow);
  }

  const hostsRow = factRow({ label: '本次线路', value: hostsValue });
  // ⚠️ 只给 `.diag-value` 上色（`.diag-row.warn`），不动状态点 ——
  // 点这一列表示的是"自检项成没成"，与"线路是哪种"不是一回事
  if (hasPcdn) hostsRow.classList.add('warn');

  const playing = playingEvent(snapshot.events);

  nodes.push(hostsRow);
  nodes.push(
    factRow({
      label: '开局耗时',
      // 没有 playing 就写「未记录」，**不补 0**（0.00s 会被读成"开局极快"）
      value: playing === null ? '未记录' : `${(playing.t / 1000).toFixed(2)}s`,
    }),
  );
  nodes.push(factRow({ label: '换线次数', value: String(detectSwitches(snapshot.events).length) }));
  nodes.push(factRow({ label: '快照状态', value: snapshot.confidence }));
  /**
   * ## 采集窗口（2026-11-20，T13/P1-7）
   *
   * `snapshot.truncated` 以前只在 L2 浮层里说一句，诊断页没有出口 ——
   * 于是排查者看原始事件表时以为第一条就是页面开始。这里明确写出来，
   * 并且与"导出只装 40 条"（`eventsTruncated`）**分开**：那个是这一层截的，
   * 这个才是采集时就丢了的。
   */
  nodes.push(
    snapshot.truncated
      ? factRow({ label: '采集窗口', value: '已截断（早期事件被丢弃）', ok: false })
      : factRow({ label: '采集窗口', value: '完整' }),
  );

  // ── 原始事件表（默认折叠）──
  const shown = snapshot.events.slice(0, LOADING_EVENT_LIMIT);

  const button = el('button', 'sub-entry');
  button.type = 'button';
  button.appendChild(el('span', undefined, `原始事件（${String(snapshot.events.length)} 条）`));
  const chevron = el('span', 'sub-entry-chevron');
  chevron.appendChild(iconChevron('right'));
  button.appendChild(chevron);

  const list = el('div', 'diag-logs');
  list.hidden = true;
  for (const [i, e] of shown.entries()) {
    const row = el('div', 'diag-log');
    row.appendChild(el('span', 'diag-time', `#${String(i + 1)}`));
    row.appendChild(el('span', 'diag-time', msText(e.t)));
    row.appendChild(el('span', 'diag-step', String(e.stage)));
    if (e.host !== undefined && e.host.length > 0) {
      row.appendChild(el('span', 'diag-detail', e.host));
    }
    if (e.kind !== undefined && e.kind.length > 0) {
      row.appendChild(el('span', 'diag-time', String(e.kind)));
    }
    list.appendChild(row);
  }
  /**
   * 截断必须**说出来**：只显示 40 条而不讲，用户会以为"这次加载只有 40 个事件"。
   * 与 `buildTimeline()` 的 `truncated` 同一条纪律（界面不许静默省略）。
   */
  if (snapshot.events.length > LOADING_EVENT_LIMIT) {
    const more = el('div', 'diag-log');
    more.appendChild(
      el(
        'span',
        'diag-detail',
        `只显示前 ${String(LOADING_EVENT_LIMIT)} 条（共 ${String(snapshot.events.length)} 条）`,
      ),
    );
    list.appendChild(more);
  }

  button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    list.hidden = !list.hidden;
    /**
     * 展开态把箭头转 90 度（`›` → `⌄`）。用 `open` 类而不是换一个图标：
     * 换图标要多一份 SVG，而"同一枚箭头换个朝向"本来就是一个 transform。
     */
    chevron.classList.toggle('open', !list.hidden);
  });

  nodes.push(button, list);
  return nodes;
}

/**
 * `logsMeta` **缺失时**的唯一兜底（渲染侧与导出侧共用，不许各写一份）。
 *
 * ## 为什么必须收敛到一处（2026-11-12，task-28）
 *
 * task-26 的崩溃原文是
 * `TypeError: Cannot read properties of undefined (reading 'ok')`
 * @ `diagnosticsPane` —— 渲染侧直接读了 `data.logsMeta.ok`，而**导出侧
 * 早就有一份 `?? {...}` 兜底**。「一侧有、一侧没有」这种**不对称**正是崩的原因：
 * 两个地方各自决定"缺了怎么办"，就总有一天忘了改其中一个。
 *
 * 只补 `:341` 还不够 —— 后面 `:357` 读 `.err` 会**接着崩**（verifier 独立复现：
 * 补第一处后错误后移到 `reading 'err'`）。所以**先把 `logsMeta` 收敛成变量**，
 * 后面每一处都读这个变量，从结构上消灭"第二处漏了"的可能。
 *
 * ## 为什么兜底语义是「不可信」而不是「正常」
 *
 * `ok: true` 会说"日志一切正常"，可我们**根本没拿到 `logsMeta`** ——
 * 那等于把一次崩溃换成一句谎话（用户看到「还没有日志。」而实际是读不到）。
 * 缺数据时唯一诚实的说法是**读失败**，所以 `ok: false` + `err: 'unknown'`，
 * 渲染出来就是「诊断日志读取失败 → 刷新页面」。
 *
 * `count: 0` 是事实（兜底时确实一条都没有），`limit` / `instanceId` / `readAt`
 * 只用于显示与定位，取中性值即可 —— **它们不参与"是否可信"的判断**。
 *
 * ## 本项目对「能否被真值覆盖」的判定依据（2026-11-12，task-28/29/30）
 *
 * 这是本轮收敛出来、engineer 与 verifier **双方独立同意**的口径
 * （verifier 的判据 D 落成「观测类相等、动作类允许不同」）。
 * 判断一个新字段该不该被覆盖，只看**它的主语是什么**：
 *
 * | 类别 | 字段 | 主语 | 能否用真值覆盖 |
 * | --- | --- | --- | --- |
 * | **观测结果** | `ok` / `err` / `count` | **日志存储**（"读到了没有"） | ❌ **不许** |
 * | **动作属性** | `limit` / `instanceId` / `readAt` | **这次读取 / 导出动作本身** | ✅ **可以** |
 *
 * 为什么这么分：
 * - 观测类字段来自 `probeLogsReadability()` 的**实际观测**。调用方没给数据时我们
 *   **没有观测**，用真值覆盖＝未做过的观测冒充观测结果，那是谎报。
 * - 动作类字段由**当前这个动作当场产生**（上限是编译期常量、实例 id 与时刻
 *   是此刻的），与"日志读没读到"**无关**。所以兜底时取中性占位、导出时取真值，
 *   两种情况下都在说真话。
 *
 * ⇒ 导出侧 `panel.ts` 的兜底因此写成
 * `{ ...describeLogsMetaFallback(), limit, instanceId, readAt }`
 * —— 只覆盖动作类，观测类保持兜底的"不可信"值。**两侧同源就靠这一条。**
 */
export function describeLogsMetaFallback(): LogsMeta {
  return { ok: false, err: 'unknown', count: 0, limit: 0, instanceId: 'unknown', readAt: 0 };
}

/**
 * 诊断二级浮层的界面。
 *
 * @param back 返回上一级
 */
export function diagnosticsPane(
  data: {
    rows: readonly DiagRow[];
    logs: readonly DiagEntry[];
    version: string;
    /**
     * ⚠️ **可以不传**：调用方在"还没采到诊断"时会传 `undefined`。
     * 全函数只通过下面这个 `meta` 变量读它，不许再写 `data.logsMeta.…`。
     */
    logsMeta?: LogsMeta | undefined;
    /**
     * 加载时间轴的通道结局（2026-11-20，T7）。
     *
     * ⚠️ **可以传 `undefined`**：与 `logsMeta` 同一个理由（调用方在"还没采到"
     * 时会传 `undefined`）。`undefined` 与 `absent` 同义 —— 不渲染任何看起来
     * 像数据的行，只说"本页没有加载记录"。真正的"读取失败"只有
     * `unanswered` 那一种，见 `loadingSectionNodes()`。
     */
    loading?: LoadingOutcome | undefined;
  },
  actions: { back: () => void; exportJson: () => void; refresh: () => void },
): HTMLElement {
  const box = el('div', 'tab-pane');
  /**
   * ## 唯一的读取入口（task-28）
   *
   * 这个函数体内部**只有这一处**碰 `data.logsMeta`。下面 `:341` 与 `:357`
   * 两处崩溃点都改成读 `meta` → 结构上不可能再出现"补了一处漏了另一处"。
   */
  const meta: LogsMeta = data.logsMeta ?? describeLogsMetaFallback();

  const bar = el('div', 'sub-bar');
  const backBtn = el('button', 'sub-back');
  backBtn.type = 'button';
  // 与 tabs.ts 的 homeCleanPane 同一形态：图标 + 文字（2026-11-16 收口）
  backBtn.appendChild(iconChevron('left'));
  backBtn.appendChild(el('span', undefined, '返回'));
  backBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.back();
  });
  bar.appendChild(backBtn);
  bar.appendChild(el('span', 'sub-title', '诊断'));

  /**
   * 手动刷新（2026-11-10 第七轮加）。
   *
   * 面板现在**每次进入诊断浮层都会重取**，这个按钮是给"我就在这一屏等着，
   * 想再看一次"的场景 —— 诊断工具最要紧的是能看到"现在此刻"的状态，
   * 而不是让人反复退出再进入。
   */
  const refreshBtn = el('button', 'sub-back', '⟳');
  refreshBtn.type = 'button';
  refreshBtn.setAttribute('aria-label', '重新采集');
  refreshBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.refresh();
  });
  bar.appendChild(refreshBtn);

  box.appendChild(bar);

  // ── 一句"该看哪"（与 options 同一个 tipFor）──
  box.appendChild(el('p', 'pane-note', tipFor(data.rows)));

  /**
   * ── 本次加载（T7，2026-11-20）──
   *
   * 位置是**刻意的**：紧跟在 `tipFor()` 那句"该看哪"之后、自检信息之前。
   *
   * - 放在最前：它回答的是"这一次播放怎么样"，是最常见的排查起点
   * - 不插进「自检信息」里：那一块是 `collectFacts()` 的产出（扩展自己的状态），
   *   混进页面侧的数据会让"自检项成没成"这条竖线不再成立
   *
   * 三态（ok / absent / unanswered）由 `loadingSectionNodes()` 一处决定，
   * 本函数不重复判。
   */
  for (const node of loadingSectionNodes(data.loading)) box.appendChild(node);

  // ── 自检信息 ──
  box.appendChild(el('p', 'diag-section', '自检信息'));
  const facts = el('div', 'diag-facts');
  for (const r of data.rows) facts.appendChild(factRow(r));
  box.appendChild(facts);

  // ── 诊断日志 ──
  /**
   * ## ⚠️ 读失败**不许**画成「还没有日志。」（2026-11-12，task-26）
   *
   * 用户最容易看到的就是这一行。旧实现只判 `logs.length === 0`，
   * 于是**孤儿态（扩展上下文已失效）**和**真的没记过日志**渲染出**完全相同**的
   * 「还没有日志。」—— 而前者是"页面需要刷新"，后者才是"一切正常"。
   *
   * 这是用户两次导出 `logs: []` 却以为"没记录"的同一类错误，只是发生在界面上。
   *
   * ⚠️ `ok === false` 与 `count === 0` **必须分开判**：前者是故障，后者是空态。
   */
  if (!meta.ok) {
    box.appendChild(el('p', 'diag-section', '诊断日志'));
    const failed = el('div', 'diag-row bad');
    // 与 factRow 同样的点占位，保证这一行与上面几行的标签左边缘对齐
    failed.appendChild(el('span', 'diag-dot'));
    failed.appendChild(el('span', 'diag-label', '诊断日志读取失败'));
    /**
     * 文案只说**用户能做的事**，不解释内部原因（§5.2：不把内部错误原样泼给用户）。
     * 孤儿态的处置就是刷新页面 —— 扩展更新后旧 content script 的 chrome API 已失效。
     */
    failed.appendChild(
      el('span', 'diag-value', '页面里的扩展已经失效（扩展可能刚更新过）—— 刷新页面后重开面板再看'),
    );
    box.appendChild(failed);
    /**
     * 把识别出来的错误串放在下面一行（已白名单化，不会带出未知内容）。
     * 它同时**出现在导出里**，真机排查时两者能对上。
     */
    if (meta.err !== null) {
      box.appendChild(el('p', 'pane-note', `（${meta.err}）`));
    }
  } else {
    box.appendChild(
      el(
        'p',
        'diag-section',
        `诊断日志（最近 ${String(data.logs.length)} 条${data.logs.length >= meta.limit ? `，已达上限 ${String(meta.limit)} 条，更早的被挤掉了` : ''}）`,
      ),
    );
    if (data.logs.length === 0) {
      box.appendChild(el('p', 'pane-note', '还没有日志。'));
    } else {
      const logs = el('div', 'diag-logs');
      /**
       * **最新在上**（倒序显示）。
       *
       * `readDiag()` 返回的是时间正序（导出按那个顺序，见 `diag-store.ts` 的注释）。
       * 界面倒序是**渲染层的事**，不要为了显示去改数据层顺序。
       */
      for (const e of [...data.logs].reverse()) logs.appendChild(logRow(e));
      box.appendChild(logs);
    }
  }

  // ── 导出 ──
  const exportBtn = el('button', 'sub-entry');
  exportBtn.type = 'button';
  exportBtn.appendChild(el('span', undefined, '导出诊断 JSON'));
  exportBtn.appendChild(el('span', 'sub-entry-hint', '不含任何凭据'));
  exportBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.exportJson();
  });
  box.appendChild(exportBtn);

  box.appendChild(
    el(
      'p',
      'pane-note',
      '面板侧取流通道的结局会记在日志里（panel/page-state · kind=…），排查时先看它。',
    ),
  );

  return box;
}
