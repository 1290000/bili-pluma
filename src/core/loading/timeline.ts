/**
 * 加载事件 → 归一后的时间轴。
 *
 * 分层：`core/` 纯函数，零 IO、零浏览器 API（`chrome` / `window` / `document` /
 * `fetch(` 都不许出现）。采集在 content script，归一在这里，所以这段能在 Node 里全覆盖。
 *
 * ## 这个模块守的是什么
 *
 * 守的是"诊断页画出来的那条时间轴，与真实发生的事一一对应"。事件由几个互不相识的采集钩子
 * 投递（main-world 的 playurl hook、isolated 的 `PerformanceObserver`、`<video>` 的事件），
 * 投递顺序与时间顺序不保证一致，所以归一要做三件事，且每件都有对错之分：
 *
 * 1. **非有限数 / 负数时间戳直接丢，不修正成 0。** 修正成 0 会在时间轴上凭空多出一个
 *    "页面刚开始就发生了这件事"的假节点 —— 比缺一个节点更容易骗人，因为它看起来是数据。
 * 2. **排序要稳定**：主键 `t`，次键用 `LoadStage` 的声明顺序。否则同一毫秒内的
 *    `playurl-req` / `playurl-res` 每次渲染位置随机，用户截图对比时对不上。
 * 3. **绝不补造事件。** 输入没有就不输出。缺一个节点只是少一条信息，
 *    补一个占位节点则是**编造事实** —— 诊断工具一旦编数据，整份报告的信用就没了。
 *
 * ## ⚠️ 时间戳只排序，绝不"修正"
 *
 * 曾经有一版在排序之前先做"单调性夹平"（当前 `t` 小于上一条就改成上一条的值），
 * 并输出 `adjusted` 计数。整段删掉的原因不是口味：
 *
 * - **同源，本身有序。** `seg-req` / `seg-res` 取自**同一条** resource entry 的
 *   `startTime` / `responseEnd`，不存在跨源时钟偏差；`t` 就是事实。
 * - **夹平那一步永远不可能触发。** 排序完成后 `t` 已非递减，"当前 t 小于上一条"恒为假，
 *   `adjusted` 恒为 0 —— 界面写"N 条被修正"只是因为它数不到，是个假指标。
 * - **它会改写事实。** 一个真的更早的事件会被抬成前一条的时间，而"更早"恰恰可能是要
 *   被看见的异常（比如采集钩子装晚了）。
 *
 * 所以：若某天真出现 `seg-res` 早于 `seg-req`，**照原样显示**。那是采集侧的问题，
 * 应该被发现，而不是被抹平成一个看着合理的顺序。
 *
 * 上限 200 条（与采集侧环形缓冲一致）：超出时保留**最新的** 200 条，并置 `truncated`，
 * 让界面能明说"前面还有事件被丢了"，而不是安静地只显示后段。
 */

import type { CdnKind } from '@core/cdn/classify';

/**
 * 加载阶段。声明顺序**就是**同一 `t` 下的渲染顺序，不要依赖字母序。
 *
 * ## 2026-11-17（T13）：删掉 `switch` 与 `blocked` —— 它们**没有生产者**
 *
 * 两个值从加进来到删掉，全仓没有一处代码产出它们。留着不是"将来可能有用"，
 * 而是**空承诺**：读枚举的人会以为面板已经能报"换了一条线路"和"已屏蔽"。
 *
 * - `switch`：换线已经由「下载视频片段」行的类别变色表达（官方实心圆 /
 *   P2P 菱形 / 第三方三角），再插一行是同一件事说两遍。
 *   ⚠️ `detectSwitches()` **保留** —— 它只服务「N 次切换」那个计数，
 *   不产出事件。
 * - `blocked`：候选过滤（T9′）**曾评估并否决**，不是"本期没做"。
 *   ⚠️ 这条注释在 2026-11-19 更正过：原文写的是"T9′ 本期没做，真做的时候
 *   再加回来"，而 T9′ 已在 ADR 0038/0039 落地（`a791d41` 三处取流点接线）。
 *   否决的真实理由与 `switch` **同构**：屏蔽成功已由分片行的类别/形状自证
 *   （屏蔽后 host 从 `*.mcdn.bilivideo.cn` 变为官方镜像，菱形变实心圆），
 *   再插一行是同一件事说两遍。
 *
 *   另外 `blocked` 还缺一个前提：**屏蔽没有单一时刻**。一次 `filterDashOf()`
 *   会改 4 个容器里的 N 条候选，一次播放三处取流都可能改写，累加器
 *   `state.filter` 天生不是流 —— 而时间轴每一行都要求一个唯一时刻。
 *   屏蔽失败要说的话由结论卡 `describeFilterFailure()` 承担，不进时间轴。
 */
export type LoadStage =
  | 'nav'
  | 'playurl-req'
  | 'playurl-res'
  | 'ext-patch'
  | 'seg-req'
  | 'seg-res'
  | 'canplay'
  | 'playing'
  | 'stall'
  | 'error';

/** 一条加载事件 */
export interface LoadEvent {
  /** ms，相对 `performance.timeOrigin` */
  t: number;
  /** 阶段 */
  stage: LoadStage;
  /** 只有 hostname，**永不带 query**（query 里是 `upsig` / `deadline` 这类取流凭据） */
  host?: string;
  /** 该 host 的线路分类，便于面板直接显示，不必再算一遍 */
  kind?: CdnKind;
  /**
   * 技术层原值 / 短语（`error` 是 `code=3`，`ext-patch` 是 `接管取流`）。
   *
   * 会显示在时间轴的明细行（`.ld-detail`），**不进导出** —— 导出按白名单另取
   * （`error` 的码由 `diagnostics.ts` 解析成 `code` 数字字段，见那里的注释）。
   */
  note?: string;
}

/** `buildTimeline()` 的产出 */
export interface LoadTimeline {
  /** 归一后的事件，按 `t` 升序且已去重 */
  events: LoadEvent[];
  /** 是否因超出上限而丢掉过较早的事件 */
  truncated: boolean;
}

/** 默认上限：与采集侧环形缓冲（200 条）保持一致，避免"采集丢了、这里却以为全有" */
const DEFAULT_LIMIT = 200;

/** 同一 `t` 的排序依据 —— 直接用下面数组的下标，声明顺序即语义 */
const STAGE_ORDER: readonly LoadStage[] = [
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
];

/**
 * 阶段在同 `t` 组内的排序权重。
 *
 * 用 `indexOf` 而不是 `Record<LoadStage, number>` 查表：非法阶段名（上游传了字符串）
 * 会落到末尾而不是 `undefined`，排序比较不会变成 `NaN`（`NaN` 比较的返回值是实现细节，
 * 会让 `sort` 行为不确定）。注释里的"声明顺序"也只有一个来源，不会两处漂移。
 */
function rankOf(stage: LoadStage): number {
  const index = STAGE_ORDER.indexOf(stage);
  return index < 0 ? STAGE_ORDER.length : index;
}

/** 去重键里区分"没有 host"与"host 是空串"——两者不同，不该互相吞掉 */
function dedupeKey(t: number, stage: LoadStage, host: string | undefined): string {
  const hostPart = host === undefined ? '\u0000' : `h:${host}`;
  return `${t}\u0000${stage}\u0000${hostPart}`;
}

/**
 * 把采集到的原始事件归一成可渲染的时间轴。
 *
 * 处理顺序：丢弃非法 → 排序 → 去重 → 截断。**没有**"修正时间戳"这一步：
 * `t` 只被排序、从不被改写（理由见文件头 §"时间戳只排序，绝不修正"）。
 *
 * **不改入参**：入参是采集侧的环形缓冲，就地改会污染原始数据。
 *
 * @param raw 采集到的原始事件，允许乱序、允许重复、允许时间戳非法
 * @param limit 保留的最新事件条数，默认 200；`NaN` 退回默认值，负数按 0 处理
 * @returns 归一后的时间轴与"是否丢过较早事件"的标记
 */
export function buildTimeline(
  raw: readonly LoadEvent[],
  limit: number = DEFAULT_LIMIT,
): LoadTimeline {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_LIMIT;

  // 1. 非法时间戳直接丢。`Number.isFinite` 同时挡住 NaN 与 ±Infinity；`< 0` 不属于本时基
  const valid = raw.filter((event) => Number.isFinite(event.t) && event.t >= 0);

  // 2. 排序：主键 t（时间戳原样保留，绝不夹平），次键阶段声明顺序（同 t 时渲染稳定）
  const sorted = [...valid].sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    return rankOf(a.stage) - rankOf(b.stage);
  });

  const events: LoadEvent[] = [];
  const seen = new Set<string>();

  for (const event of sorted) {
    // 3. 去重：stage + host + t 三者全同只留一条（`note` 不同也算同一条，它是同一件事）。
    //    同 t 的同构事件在排序后会被并到一起，但中间可能夹着别的 host，
    //    所以用 Set 记键而不是只比"上一条"。
    const key = dedupeKey(event.t, event.stage, event.host);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }

  // 4. 截断：保留最新的一段，并明确标记丢过东西
  const truncated = events.length > max;
  return {
    events: truncated ? events.slice(events.length - max) : events,
    truncated,
  };
}

/**
 * 找出播放中实际发生的线路切换。
 *
 * 取所有 `seg-req` 的 `host` 序列，相邻不同就产出一条 `{ t, from, to }`，
 * `t` 用**后一条**（切过去那一次请求）的时间。
 *
 * 用 `seg-req` 而不是 `playurl-res` 的候选列表：候选是"可以用的"，分片请求才是
 * "真的用了" —— 只看候选会把"备了但没用"误报成切换。
 *
 * @param events 已归一的事件（传 `buildTimeline()` 的 `events`）；按传入顺序扫，不重新排序
 * @returns 切换点列表；空输入或只有一条 seg-req 时返回 `[]`
 */
export function detectSwitches(
  events: readonly LoadEvent[],
): { t: number; from: string; to: string }[] {
  const switches: { t: number; from: string; to: string }[] = [];
  let previousHost: string | null = null;

  for (const event of events) {
    if (event.stage !== 'seg-req') continue;
    // 没有 host 的分片事件无法参与比较：跳过，但不重置上一条（否则会被当成"断点"）
    const host = event.host;
    if (host === undefined || host.length === 0) continue;

    if (previousHost !== null && host !== previousHost) {
      switches.push({ t: event.t, from: previousHost, to: host });
    }
    previousHost = host;
  }

  return switches;
}

/**
 * **最后一次分片请求** —— 也就是"此刻正在用的那条线路"（2026-11-17，P0-2）。
 *
 * ## 为什么要它
 *
 * `snapshot.actual` 取的是 `hosts` 里**请求数最多**的那条（argmax），语义是
 * "这次整体主要走哪条"。中途被切到 PCDN 之后，argmax 仍可能指着已经不再用的
 * 那条 —— 诊断页如果只写「当前线路」，就是在陈述一件已经过期的事。
 *
 * 所以两件事分开说：`主要线路（按请求数）` = argmax；`当前线路（最后一次请求）`
 * = 本函数的返回值。两者相同时界面只显示一行（见 `diagnostics.ts`）。
 *
 * ## 为什么用 `seg-req` 而不是 `seg-res`
 *
 * 请求发出那一刻就已经在用那条线路了；返回时刻只说明"它答完了"。
 * 与 `detectSwitches()` 的判据同源（那里也只扫 `seg-req`）。
 *
 * @param events 已归一的事件（按传入顺序扫，不重新排序）
 * @returns 最后一条带 `host` 的 `seg-req`；没有则 `null`
 */
export function currentSegment(events: readonly LoadEvent[]): LoadEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.stage !== 'seg-req') continue;
    if (event.host === undefined || event.host.length === 0) continue;
    return event;
  }
  return null;
}

/**
 * 一对「分片请求 → 分片返回」。
 *
 * `doneAt` / `ms` 为 `null` 表示**只有请求、没配对到返回**（详见 `pairSegments`）。
 */
export interface SegmentPair {
  /** 请求发出的时刻 */
  t: number;
  /** 返回时刻；`null` = 没有配对到返回 */
  doneAt: number | null;
  /** `doneAt - t`；`null` = 同上 */
  ms: number | null;
  /** 这条分片走的 host；不参与配对时为 `null`（正常情况下必有） */
  host: string | null;
  /** 该 host 的线路分类（取自**请求**那一条） */
  kind: CdnKind | null;
}

/**
 * 把 `seg-req` / `seg-res` 配成一对一对，**按 host 各自 FIFO**。
 *
 * ## 为什么必须配对（2026-11-17 真机截图）
 *
 * B站 会**同时**对两条线路发分片请求（竞速 / 预载），于是事件是交错的：
 *
 * ```text
 * 4.22s  seg-req  xy116…mcdn        ← 请求 A
 * 4.23s  seg-req  cn-zjih-ct-04-03  ← 请求 B
 * 4.39s  seg-res  +0.2s             ← 其实是 A 的返回
 * 4.97s  seg-res  +0.6s             ← 其实是 B 的返回
 * ```
 *
 * 平铺着看，**没有任何线索**说明哪个返回属于哪个请求 —— 而"第几秒发出、
 * 第几秒回来"正是这个功能的原始需求。配对之后这条信息才第一次存在。
 *
 * ## 配对规则
 *
 * - **按 host 各自维护一个 FIFO 队列**：`seg-req` 入队，`seg-res` 配给该 host
 *   **最早那条未配对的**。跨 host 绝不错配（不同线路的耗时没有可比性）。
 * - **没有 host 的事件不参与配对**（`LoadEvent.host` 是可选的，采集侧一定会给，
 *   但这里是纯函数，不假设上游守规矩）。
 * - **配不上的 `seg-res` 直接丢弃**：它对应的请求落在采集窗口外
 *   （环形缓冲被挤掉了），凭空造一条"只有返回"的记录比不显示更容易误导。
 * - 配不上的 `seg-req` 保留，`doneAt` / `ms` 为 `null`。
 *   ⚠️ 这**不是错误**：竞速里被丢弃的那条请求正常得很，界面不可以用危险色。
 *
 * ## 为什么 `ms` 允许为负而不夹平
 *
 * 与 `buildTimeline()` 文件头同一条纪律：时间戳只排序，绝不修正。
 * 真出现 `seg-res` 早于它自己的 `seg-req`，那是采集侧的问题，应该被看见。
 *
 * @param events 已归一的事件（传 `buildTimeline()` 的 `events`）；按传入顺序扫，不重新排序
 * @returns 配对结果，**按请求发出的顺序**（不是按返回顺序）
 */
export function pairSegments(events: readonly LoadEvent[]): SegmentPair[] {
  /** host → 该 host 还没等到返回的请求（FIFO） */
  const pending = new Map<string, SegmentPair[]>();
  const pairs: SegmentPair[] = [];

  for (const event of events) {
    if (event.stage !== 'seg-req' && event.stage !== 'seg-res') continue;

    const host = event.host;
    if (host === undefined || host.length === 0) continue;

    if (event.stage === 'seg-req') {
      const pair: SegmentPair = {
        t: event.t,
        doneAt: null,
        ms: null,
        host,
        kind: event.kind ?? null,
      };
      const queue = pending.get(host);
      if (queue === undefined) pending.set(host, [pair]);
      else queue.push(pair);
      // 返回顺序按"请求发出的顺序"：入队时就把位置定下来
      pairs.push(pair);
      continue;
    }

    const queue = pending.get(host);
    if (queue === undefined || queue.length === 0) continue;
    const paired = queue.shift();
    if (paired === undefined) continue;
    paired.doneAt = event.t;
    paired.ms = event.t - paired.t;
  }

  return pairs;
}
