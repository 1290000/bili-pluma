/**
 * 加载时间轴的两个视图：画质 Tab 的**速览行** + 二级浮层「本次加载」。
 *
 * ## 这个文件回答什么问题
 *
 * 「这一次播放，分片到底从哪条线路来的？」—— 用户能看懂的那一层。
 * 判据全部来自上游的三份纯数据（`cdn/classify` 的类别、`loading/timeline` 的
 * 事件序列、`loading-trace` 的快照），**本文件不重新判定任何线路**。
 *
 * ## ⚠️ 数据只走桥，不 import 采集器
 *
 * 快照是 `entrypoints/content.ts` 那个实例采集的。面板是**另一个 content script
 * 实例**，它自己 import `loading-trace.ts` 只会拿到一份**空的**模块级状态
 * （那个 `state` 是模块单例，面板那一份从没见过任何请求）。
 * 所以运行时**只**走 `panel-data.ts` 的 `fetchLoadingSnapshotViaPage()`。
 *
 * 这里**只有 `import type`**：类型不产生代码，编译后整句消失，
 * 因此不会在面板侧造出第二个实例。⚠️ 谁要把它改成值导入（`getLoadingSnapshot`），
 * 就正好踩上面说的那个坑 —— `tests/unit/content/panel-loading.test.ts` 有一条
 * 源码级断言守着（`src/content/panel/**` 不许对 `content/isolated/**` 做值导入）。
 *
 * ## ⚠️ 文案是**枚举拼接**，不是自由文本
 *
 * 线路描述必须能被穷举（7 种），否则"到底该显示哪句话"就变成一处自由发挥的地方 ——
 * 而这类界面最容易犯的错是**把没测到的东西说得像测到了**：
 * 比如 `flavor === null`（认不出是自建还是服务商）时**不加任何括号**，
 * 就是不在括号里塞一个猜出来的结论（`classify.ts` 文件头第 3 条同一条纪律）。
 *
 * ## 形状是**第二条线索**
 *
 * 圆点颜色 + 形状双编码：官方实心圆 / PCDN 空心菱形 / 第三方空心三角 /
 * 扩展介入空心圆。红绿色盲看不出 `--pluma-ok` 与 `--pluma-warning` 的差别，
 * 但分得出实心圆与菱形；图例同时给出形状与文字。
 *
 * 造型只在这里定义一次（`markerSvg`），速览行、结论卡、时间轴、图例四处共用 ——
 * 各处各画一遍会让"图例说的"和"行里画的"慢慢分家。
 */

import type { CdnKind, OfficialFlavor } from '@core/cdn/classify';
import {
  currentSegment,
  detectSwitches,
  pairSegments,
  type LoadEvent,
  type LoadStage,
  type SegmentPair,
} from '@core/loading/timeline';
import type { LoadingSnapshotLite } from '@/src/content/isolated/loading-trace';

import { el, iconChevron, onClick, pill } from './dom';

// ─────────────────────────── 通道结局 ───────────────────────────

/**
 * 取加载快照的**三种结局**（不许归并）。
 *
 * ## 为什么必须分开（本项目已有一次同类事故）
 *
 * `diagnostics.ts` 的 `logsMeta.ok` 记的就是同一件事：`readDiag()` 读失败返回
 * `[]`，和"真的一条日志都没有"**长得一模一样**，于是用户两次导出
 * `"logs": []` 以为"没记录"，实际是孤儿态。把失败画成空态，会让人查错方向。
 *
 * | 结局 | 含义 | 用户该做什么 | 界面 |
 * | --- | --- | --- | --- |
 * | `ok` | 拿到了快照（可能一条线路都还没识别出来） | —— | 正常渲染 |
 * | `absent` | **本页没有这条通道**（非播放页，`content.ts` 根本没注入） | 什么都不用做 | **整卡不渲染** |
 * | `unanswered` | 播放页但没人应答（超时 / 孤儿态 / 应答形状不对） | 刷新页面 | 危险色「读取失败」 |
 *
 * ⚠️ `absent` **不能**由"超时"推出来：非播放页问也永远问不到，硬问一次只是
 * 白等 2 秒，然后还会把"本页没有"谎报成"读取失败"。所以 `pageKind` 先判，
 * 见 `panel-data.ts` 的 `fetchLoadingSnapshot()`。
 */
export type LoadingOutcome =
  { kind: 'ok'; snapshot: LoadingSnapshotLite } | { kind: 'absent' } | { kind: 'unanswered' };

// ─────────────────────────── 文案与形状 ───────────────────────────

/** 文字/图形色调。`accent` 只给"扩展介入"用 —— 蓝在本项目里表示"交互/我方动作" */
export type LoadingTone = 'ok' | 'warn' | 'muted' | 'bad' | 'accent';

/**
 * 圆点形状（色盲可用的第二条线索）。
 *
 * | 形状 | 含义 |
 * | --- | --- |
 * | `disc` | 官方线路（实心圆） |
 * | `diamond` | PCDN（空心菱形） |
 * | `triangle` | 第三方（空心三角） |
 * | `ring` | 扩展介入 / 与线路无关的阶段（空心圆） |
 * | `dashed` | **认不出来源的线路**（虚线空心圆，2026-11-20 P0-1） |
 *
 * ⚠️ `dashed` 不是装饰：`unknown` 以前被整类丢弃，现在它会出现在时间轴上，
 * 而它**不能**与「扩展介入」共用实心/空心圆 —— 那两个圆在色盲眼里一模一样，
 * 却一个是"我方动作"、一个是"来源不明的流量"，含义完全相反。
 */
export type MarkerShape = 'disc' | 'diamond' | 'triangle' | 'ring' | 'dashed';

/** 一条线路描述 —— 速览行主行与结论卡大字**共用**这一份，不许各拼一句 */
export interface LineDescription {
  title: string;
  tone: LoadingTone;
  marker: MarkerShape;
}

/**
 * 阶段中文名。**固定映射**：阶段枚举只有 10 个值，逐个给中文，
 * 不做"把英文换成中文"的通用转换（那会拼出「开始下载分片」这种半成品）。
 *
 * ⚠️ 2026-11-20（T13）：`switch` / `blocked` 两档随枚举一起删了 ——
 * 它们从来没有生产者，留着就是让读代码的人以为面板能报这两件事。
 */
const STAGE_LABEL: Record<LoadStage, string> = {
  /**
   * `nav` 是时间轴的**原点**（`t = 0`），2026-11-20（T12）起真的会出现在第一行。
   *
   * 为什么从「页面开始」改成「页面开始加载」：尾注那句"时间从页面开始加载算起"
   * 需要一个看得见的对应物 —— 用户看到第一行是 `1.53s` 时会问"这之前干什么去了"，
   * 而「页面开始」读起来像一句残缺的话（开始什么？）。
   */
  nav: '页面开始加载',
  'playurl-req': '发出取流请求',
  'playurl-res': 'B站返回线路清单',
  'ext-patch': '扩展介入',
  'seg-req': '开始下载分片',
  'seg-res': '分片到达',
  canplay: '可以播放',
  playing: '开始播放',
  stall: '卡了一下',
  error: '播放出错',
};

/**
 * 阶段 → 中文名。
 *
 * 上游理论上只给 12 个枚举值，但**快照来自另一个实例**（postMessage 过来的
 * 普通对象），所以非法值要能兜住：认不出就把原值原样显示，
 * 让它显眼地出现，而不是换成「未知阶段」把一个问题藏起来。
 */
export function stageLabel(stage: LoadStage): string {
  return STAGE_LABEL[stage] ?? String(stage);
}

/** 认不出线路时说的那句话（`actual === null` 且**一条 host 都没有**） */
const TITLE_UNKNOWN = '还不知道走哪条线路';

/**
 * 有流量、但**每一条**都认不出来源时说的那句话（2026-11-20，P0-1）。
 *
 * 与 `TITLE_UNKNOWN` 是**两件事**，不许合并：前者是"什么都没看到"，
 * 后者是"看到了 N 条，但没有一条能认出属于哪类 CDN"。合并的后果是
 * B站 新增一个 PCDN 供应商域时，界面说「还不知道走哪条线路」——
 * 用户会以为功能没数据，而事实是**有数据、只是我们认不出**。
 *
 * @param count 认不出来源的 host 条数（≥ 1）
 */
export function describeUnknownSource(count: number): string {
  return `有 ${String(count)} 条线路认不出来源`;
}

/** 没人应答时说的那句话。**不许写成「还没有数据」** —— 那是另一件事 */
const TITLE_UNREADABLE = '读取失败 · 刷新页面后重试';

/** 官方线路的主干；括号部分由 `flavor` 拼，认不出时不加括号 */
const TITLE_OFFICIAL = 'B站官方线路';

/** 官方线路的两种括号后缀。`flavor === null` 时**一个都不选**（不猜） */
const OFFICIAL_SUFFIX: Record<'self-built' | 'partner', string> = {
  'self-built': '（自建 CDN）',
  partner: '（服务商 CDN）',
};

const TITLE_PCDN = '第三方加速线路（PCDN）';
const TITLE_THIRD = '第三方线路';

/**
 * 线路 → 文案 + 色调 + 形状。
 *
 * 七种情况里的前六种在这里（第七种"没人应答"在 `buildLoadingQuick` 里，
 * 因为它不是"线路"，是"没读到"）。
 *
 * @param actual 快照里的 `actual`；`null` 表示还没识别出任何线路
 */
export function describeLine(
  actual: { cls: CdnKind; flavor: OfficialFlavor } | null,
): LineDescription {
  if (actual === null) return { title: TITLE_UNKNOWN, tone: 'muted', marker: 'ring' };

  switch (actual.cls) {
    case 'official': {
      /**
       * ⚠️ `flavor === null` 时**不加括号**。
       *
       * `classify.ts` 认不出机型时返回 `null` 而不是猜一个 —— 界面这一侧必须
       * 保持一致：给一个空的括号、或者默认写「自建」，都是在替分类器下结论。
       * 用户会拿这句话去对照播放页右键的「视频统计信息」，说错就被抓。
       */
      const suffix = actual.flavor === null ? '' : OFFICIAL_SUFFIX[actual.flavor];
      return { title: `${TITLE_OFFICIAL}${suffix}`, tone: 'ok', marker: 'disc' };
    }
    case 'pcdn':
      return { title: TITLE_PCDN, tone: 'warn', marker: 'diamond' };
    case 'third-party':
      return { title: TITLE_THIRD, tone: 'muted', marker: 'triangle' };
    default:
      /**
       * `unknown`：host 认不出线路。`snapshotOf()` 只把 `unknown` 从 `actual` 里
       * 滤掉（它不进结论），但**会留在 `hosts` 里**（P0-1）。所以这里仍可能被
       * 直接调用到（例如有人拿 `hosts[0]` 来问），如实说"认不出来源"，
       * **不当成 PCDN**（`classify.ts` 第 1 条：不替用户拦来源不明的东西）。
       */
      return { title: describeUnknownSource(1), tone: 'muted', marker: 'dashed' };
  }
}

/**
 * 快照 → 结论行（**三态**，2026-11-20 P0-1）。
 *
 * | 情形 | 文案 | 形状 |
 * | --- | --- | --- |
 * | 一条 host 都没有 | 「还不知道走哪条线路」 | 空心圆（muted） |
 * | 有 host，但**全部**认不出来源 | 「有 N 条线路认不出来源」 | **虚线**空心圆 |
 * | 有已知线路 | 正常线路文案 | 线路形状 |
 *
 * 三态**不许归并**：第二态以前被并进第一态（因为 `unknown` 被丢弃 → `hosts`
 * 是空的），于是"有流量但认不出"看起来和"没流量"一模一样 ——
 * 那正是这次审计的 P0。
 */
export function describeSnapshotLine(snapshot: LoadingSnapshotLite): LineDescription {
  if (snapshot.actual !== null) return describeLine(snapshot.actual);

  const unknownCount = snapshot.hosts.filter((h) => h.cls === 'unknown').length;
  if (unknownCount === 0) return describeLine(null);
  return { title: describeUnknownSource(unknownCount), tone: 'muted', marker: 'dashed' };
}

/** 结论卡里那个小胶囊。`null` = 没有线路可标（不编一个「未知」标签） */
export function describeKindPill(
  cls: CdnKind | null,
): { text: string; tone: 'good' | 'warn' | 'neutral' } | null {
  switch (cls) {
    case 'official':
      return { text: '官方 CDN', tone: 'good' };
    case 'pcdn':
      return { text: 'PCDN', tone: 'warn' };
    case 'third-party':
      return { text: '第三方', tone: 'neutral' };
    default:
      return null;
  }
}

// ─────────────────────────── 纯函数：数值与序列 ───────────────────────────

/**
 * 秒（**统一 2 位小数**）。
 *
 * ## 为什么不是 1 位（2026-11-20 Lead 裁决 ⑤）
 *
 * 真机截图里「开局 3.2s」与时间轴「3.18s」是同一个数字的两种精度 ——
 * 用户对照时会以为是两个不同的值。面板里所有时间现在只有一种精度：
 * `开局 3.18s`、`4.22s → 4.39s · 0.17s`、`+0.40s`。
 *
 * `toFixed` 比 `Math.round` 稳：`.5` 的方向由十进制字符串规则定，不看实现。
 */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/** 第一条 `playing` 事件；没有就 `null`（**不补 0**） */
export function playingEvent(events: readonly LoadEvent[]): LoadEvent | null {
  return events.find((e) => e.stage === 'playing') ?? null;
}

/**
 * 线路数文案：`4 条线路（1 条认不出）`。
 *
 * ## 为什么括号里必须写出来（2026-11-20，P0-1）
 *
 * `unknown` 现在会进 `hosts`（不再被丢弃）。如果只显示总数，用户看到「4 条线路」
 * 而时间轴上只有 3 个认得出的形状，会以为是渲染 bug。括号把那 1 条的去向说清。
 *
 * 认不出来源的条数**不参与**「N 次切换」「当前线路」这类结论 —— 那两处只认
 * `official` / `pcdn` / `third-party`（`snapshotOf()` 的 `actual` 判据）。
 */
export function hostCountText(snapshot: LoadingSnapshotLite): string {
  const total = snapshot.hosts.length;
  const unknown = snapshot.hosts.filter((h) => h.cls === 'unknown').length;
  return unknown > 0
    ? `${String(total)} 条线路（${String(unknown)} 条认不出）`
    : `${String(total)} 条线路`;
}

/**
 * 速览行的副行：`开局 3.18s · 3 条线路`。
 *
 * ## 单位是 `s`，不是「秒」（2026-11-20 Lead 裁决）
 *
 * 面板里 `s` 已经是既定单位：时间轴 `0.42s`、增量 `+0.40s`、尾注 `+x.xxs`。
 * 副行写「秒」会让**同一张卡里的同一个数字**出现两种写法（`开局 1.80s` 与
 * `1.80s`），用户对照时会以为是两个不同的值。
 *
 * ## `playing` 缺失时整行不显示（不补 0）
 *
 * "开局 0.00s"是一句**看起来像数据**的话，而事实是"没测到开始播放" ——
 * 补 0 会把"缺一条信息"伪装成"测到了一个很好的值"。
 * `core/loading/timeline.ts` 文件头第 3 条（绝不补造事件）是同一个道理。
 */
export function describeQuickSub(snapshot: LoadingSnapshotLite): string | null {
  const playing = playingEvent(snapshot.events);
  if (playing === null) return null;
  return `开局 ${seconds(playing.t)}s · ${hostCountText(snapshot)}`;
}

/**
 * 结论卡下面那一排小计数。
 *
 * 每一项都**只在有数据时出现**（同样不补 0）。所以数量可能是 0～3 个，
 * 布局按 flex 换行处理，不做固定三列 —— 固定三列会为了对齐去补空格子。
 */
export function describeCounts(snapshot: LoadingSnapshotLite): string[] {
  const counts: string[] = [];

  const playing = playingEvent(snapshot.events);
  if (playing !== null) counts.push(`开局 ${seconds(playing.t)}s`);

  if (snapshot.hosts.length > 0) counts.push(hostCountText(snapshot));

  const switches = detectSwitches(snapshot.events).length;
  if (switches > 0) counts.push(`${String(switches)} 次切换`);

  return counts;
}

/**
 * 结论卡里那句"为什么官方线路上还有 P2P 节点"（2026-11-20 Lead 裁决 ②）。
 *
 * ## 不解释会自相矛盾
 *
 * 真机截图：结论卡写「B站官方线路（自建 CDN）」+ 徽章「官方 CDN」，
 * 而时间轴上有两个橙色 P2P 节点 —— 普通用户看到会卡住：走官方为什么有 P2P？
 *
 * 技术上没错：`actual` 取的是**请求数最多**的那条线路（`snapshotOf` 的判据），
 * 竞速里另一条也会被用上一两次。所以这里要**把判据说出来**。
 *
 * ## 2026-11-20（T13，P0-2）：当前线路也是 P2P 时换一句更强的话
 *
 * 「其中 N 条是 P2P 线路，未占主导」在**当前正在用 P2P** 时是误导：
 * 用户刚被切走，界面却说"没占主导"。那时改成「现在正在用 P2P 线路」——
 * 这是一句**可观测的事实**（最后一条 `seg-req` 的 `kind` 就是 `pcdn`）。
 *
 * ⚠️ 仍然**不许**写"已回退"：我们没有"什么时候被踢下来"的观测。
 *
 * @returns `null` = 不需要这句（没有 P2P，或者结论本身就是 P2P）
 */
export function describePcdnCaveat(snapshot: LoadingSnapshotLite): string | null {
  const actual = snapshot.actual;
  // 结论已经是 P2P 了："其中 N 条是 P2P，未占主导"会与大字结论打架
  if (actual === null || actual.cls === 'pcdn') return null;

  const pcdnHosts = snapshot.hosts.filter((h) => h.cls === 'pcdn').length;
  if (pcdnHosts === 0) return null;

  /**
   * 结论看的是**整次加载**（argmax），这句补充的是**此刻**。
   * 两者不同时以"此刻"为准 —— 那才是用户正在经历的事。
   */
  if (currentSegment(snapshot.events)?.kind === 'pcdn') return '现在正在用 P2P 线路';

  return `其中 ${String(pcdnHosts)} 条是 P2P 线路，未占主导`;
}

// ─────────────────────────── 时间轴行 ───────────────────────────

/** 一条时间轴行（纯数据，DOM 由 `loadingDetailPane` 装配） */
export interface TimelineRow {
  /** `segment` = 配对好的「请求→返回」；`event` = 里程碑等单点事件；`gap` = 空档 */
  kind: 'segment' | 'event' | 'gap';
  /** 空档行没有阶段（它不是事件），所以是 `null` */
  stage: LoadStage | null;
  /** 左侧标题 */
  label: string;
  /**
   * 右列那一整块元信息（这一行最右侧的小字）。三种形态：
   * - 配对成功：`4.22s → 4.39s · 0.17s`
   * - 只有请求：`4.22s · 未完成`
   * - 里程碑：`3.18s +0.40s`（后半个是距上一条的增量）
   *
   * 空档行是 `''`（它的说明写在 `label` 里，独占一行）。
   */
  meta: string;
  /** 明细（有 host 才有一行）；`null` = 不渲染，不留占位符 */
  detail: string | null;
  /**
   * 线路形状。`null` = **里程碑**，左侧画一根短竖线而不是圆点
   * （2026-11-20 Lead 裁决 ④：里程碑不是线路，不该共用形状）。
   *
   * 空档行也是 `null`，但它连短竖线都不画 —— `timelineRow()` 对
   * `kind === 'gap'` 走另一套骨架（一条细横线 + 一句话）。
   */
  marker: MarkerShape | null;
  /** 圆点色调（只在 `marker !== null` 时起作用） */
  tone: LoadingTone;
  /** 标题用次要文字色（"未完成"的请求、空档行） */
  dimTitle: boolean;
  /** 标题用危险色（只有 `error`） */
  dangerTitle: boolean;
}

/**
 * 配对行里的线段文案。
 *
 * ## 为什么是「下载视频片段」而不是「开始下载分片」
 *
 * 用户原话：「下载分片是下载视频的意思吗」—— 「分片」是这行的**实现词**，
 * 非技术用户读不出它指什么。这一行代表"从某条线路取一段视频数据"，
 * 所以用「下载视频片段」：既说清了对象（视频片段），也保留了"一段一段"的语义。
 *
 * 它也**不再是** `stageLabel('seg-req')`（那是「开始下载分片」，指"那一刻"）——
 * 这一行代表的是一整段（请求→返回），所以文案与诊断页的技术名分开。
 */
const SEGMENT_LABEL = '下载视频片段';

/**
 * 相邻两个节点间隔多大就插一条空档分隔行（毫秒）。
 *
 * ## 为什么需要它（2026-11-20 真机截图）
 *
 * 用户看到 `2.07s` 与 `8.28s` 之间一片空白，第一反应是"这 6 秒卡住了"。
 * 我们**能证实的只有一件事**：这段时间里没有可显示的事件（采集闸门按 `cls`
 * 压事件，同一类别下的连续分片不逐段列，见 `loading-trace.ts:recordVideoStage`）。
 *
 * ## ⚠️ 文案**绝不**写"同一线路继续下载"
 *
 * 闸门是按 `cls`（类别）压的，**同一类别下 host 可能已经换了**。用户真机截图里
 * 副行写「4 条线路」而时间轴只有 3 个 host —— 第 4 个正是在空档期间出现的。
 * 写"同一线路"就是在陈述一件我们没有观测到的事。所以两条文案都只说
 * "这段时间的片段未逐段列出"（分隔行见 `gapText()`，尾注见 `TIMELINE_FOOTNOTE`）。
 *
 * 2 秒是"肉眼已经开始怀疑"的阈值：1.x 秒的间隔在正常播放里到处都是，
 * 每条都插一行会把时间轴撑长，反而看不清真正的节点。
 */
const GAP_THRESHOLD_MS = 2000;

/**
 * 空档分隔行的文案。
 *
 * 只陈述可证实的事实：**有这么长一段时间，我们没有逐段列出其中的片段**。
 * 不解释原因、不点名线路（原因见 `GAP_THRESHOLD_MS` 的第 2 段）。
 *
 * @param ms 相邻两个节点之间没被列出的那段时长（毫秒，由两个节点的时刻相减得到）
 */
export function gapText(ms: number): string {
  return `⋯ ${seconds(ms)}s（这段时间的片段未逐段列出）`;
}

/**
 * 时间轴尾注（**基准版**：时间轴上有 `nav` 原点时用它）。
 *
 * ## 第 3 句为什么不写"同一条线路"
 *
 * 旧文案写的是"同一条线路连续下载的片段只列第一段"——**不准**：闸门按 `cls`
 * 压事件，同类别下 host 可能已经换了（真机截图里「4 条线路」但时间轴只有
 * 3 个 host）。所以只说"每次线路类别变化后的第一段"，其余一律"未逐段列出"。
 *
 * 导出是为了让 `tests/unit/content/panel-loading.test.ts` 能用一条**文案守卫**
 * 钉住"不许写回去"，而不是断言整段长文本。
 *
 * ⚠️ 渲染时**不要**直接用这个常量：用 `timelineFootnote(events)` ——
 * 番剧换集后时间轴没有 `nav` 原点，光凭这句话会让人以为"这一集从 0 秒开始"。
 */
export const TIMELINE_FOOTNOTE =
  '时间从页面开始加载算起；+x.xxs 是比上一条多花的时间，下载视频片段那几行给的是请求到返回的耗时。只列出每次线路类别变化后的第一段，其余片段未逐段列出。';

/**
 * 毫秒 → `m:ss.SS`（≥ 1 小时用 `h:mm:ss.SS`）。
 *
 * ## 为什么用「分:秒」而不是再写一遍 `302.41s`
 *
 * 5 分钟的播放写成 `302.41s`，用户要在脑子里除一次 60；而这种"这一集从页面
 * 加载后多久才开始"的数字恰恰是给人看时间感的。秒保留两位小数，与面板里
 * 其它时间（`3.18s` / `+0.40s` / `6.21s`）**同一精度**。
 *
 * 取整先落在**百分之一秒**上再拆分，避免 `59.999 → "60.00"` 拼出 `59:60.00`。
 *
 * @param ms 毫秒（非有限数按 0 —— 调用方本来就不该传，但别让它拼出 `NaN:NaN`）
 */
export function clockText(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const cs = Math.round(safe / 10); // 百分之一秒
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = (cs % 6000) / 100;
  const ss = s.toFixed(2).padStart(5, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${ss}` : `${String(m)}:${ss}`;
}

/**
 * 时间轴的**锚点**：这一集是页面加载后多久开始的（`null` = 不用补这句）。
 *
 * ## 为什么需要它（2026-11-20，审计「已记录未修」）
 *
 * `resetLoadingTrace()` 之后**有意不补** `nav`（补了会凭空多出一条几分钟的空档
 * 行，见 `loading-trace.ts` 的 `recordNavStart()`），于是番剧换集后时间轴第一行
 * 可能直接是 `302.41s`。
 *
 * 尾注那句「时间从页面开始加载算起」**本身是对的**（时间戳确实相对页面
 * `timeOrigin`），错的只是**没有锚点**让它看起来像"这一集从 302 秒开始"。
 * 所以这里不补假事件、不加新行，只把**可观测的那个数**说进尾注。
 *
 * ## 判据（三条，缺一不可）
 *
 * | 情形 | 补锚点？ | 为什么 |
 * | --- | --- | --- |
 * | 有 `nav` | ❌ | 时间轴第一行就是原点，没什么可补 |
 * | 一条事件都没有 | ❌ | 没有数可说（**不补 0**） |
 * | `truncated`（环形缓冲丢过早期事件） | ❌ | 此时"第一条事件"**不是**这一集的开始 —— 说「本集开始于…」是假的 |
 *
 * 第三条是最容易漏的：`nav` 也会被 200 条环形缓冲挤掉。那种情况下已经有一句
 * 「更早的事件被丢掉了」在解释"开头不是页面开始"，再补一句"本集开始于 X"
 * 就是**两个互相矛盾的说法**。
 *
 * @param snapshot 快照（用 `events` 与 `truncated`）
 * @returns 锚点文案；`null` = 不补
 */
export function pageOriginAnchor(snapshot: LoadingSnapshotLite): string | null {
  if (snapshot.events.some((e) => e.stage === 'nav')) return null;
  if (snapshot.truncated) return null;
  const first = snapshot.events.find((e) => Number.isFinite(e.t));
  if (first === undefined) return null;
  return `本集开始于页面加载后 ${clockText(first.t)}`;
}

/**
 * 尾注（**按有没有锚点分两版**）。
 *
 * - 有 `nav`：基准版，原样不动
 * - 没有 `nav`：把锚点插进第一句 → `时间从页面开始加载算起（本集开始于页面
 *   加载后 5:02.41）；+x.xxs 是…`
 *
 * ⚠️ 只换第一句，**后面三句一律保留**：`+x.xxs` 的含义与"其余片段未逐段列出"
 * 这两条解释跟锚点无关，砍掉它们等于为了修一个文案问题丢掉三个说明。
 *
 * @param snapshot 快照
 */
export function timelineFootnote(snapshot: LoadingSnapshotLite): string {
  const anchor = pageOriginAnchor(snapshot);
  if (anchor === null) return TIMELINE_FOOTNOTE;
  const clause = '时间从页面开始加载算起';
  return TIMELINE_FOOTNOTE.replace(clause, `${clause}（${anchor}）`);
}

/**
 * 阶段 → 颜色 + 形状（只对**线路行**有意义）。
 *
 * 优先级：**阶段先于线路**。`ext-patch`（扩展介入）与 `error` 与"哪条线路"无关，
 * 用阶段自己的语义色 —— 它们恰恰是排查时要一眼找到的两种。
 *
 * ⚠️ 里程碑（`canplay` / `playing` / …）**不再用这个函数的形状**：
 * 它们在 `buildTimelineRows` 里走 `marker: null`（短竖线），
 * 因为空心圆与图例里的线路形状撞形（2026-11-20 Lead 裁决 ④）。
 * 本函数对它们仍返回一个值，但调用方不会拿它画圆点。
 *
 * `ext-patch` 是例外：它**保留**空心圆 + `accent` —— 它不是里程碑，是"扩展动了
 * 这一次取流"这一刻，而且图例里已经有一条「○ 扩展介入」与它对应。
 */
export function describeEventMarker(event: LoadEvent): { tone: LoadingTone; marker: MarkerShape } {
  if (event.stage === 'ext-patch') return { tone: 'accent', marker: 'ring' };
  if (event.stage === 'error') return { tone: 'bad', marker: 'ring' };

  switch (event.kind) {
    case 'official':
      return { tone: 'ok', marker: 'disc' };
    case 'pcdn':
      return { tone: 'warn', marker: 'diamond' };
    case 'third-party':
      return { tone: 'muted', marker: 'triangle' };
    /**
     * `unknown`（2026-11-20，P0-1）：认不出来源的线路**必须画出来**，
     * 而且必须与「扩展介入」的空心圆区分开 —— 两者含义相反（一个是"我方动作"，
     * 一个是"来源不明的流量"），色盲用户只能靠形状分辨。
     */
    case 'unknown':
      return { tone: 'muted', marker: 'dashed' };
    default:
      // 与线路无关的阶段（nav / playurl-* / canplay / playing / stall / error）
      return { tone: 'muted', marker: 'ring' };
  }
}

/**
 * 分片事件在 `pairSegments()` 的返回里怎么找回来。
 *
 * `buildTimeline()` 已经按 `t + stage + host` 去过重，所以同一时刻同一 host
 * 的 `seg-req` 只可能有一条 —— `(t, host)` 是它的唯一键。
 */
function segKey(t: number, host: string | null): string {
  return `${String(t)}\u0000${host ?? ''}`;
}

/**
 * 这条事件该不该用"线路形状"。
 *
 * 只有**分片请求**（配对行）谈得上"哪条线路"。里程碑（`canplay` / `playing` /
 * `stall` / `error` / `nav` / `playurl-*`）与线路无关，用短竖线 —— 否则它们
 * 与图例里的空心圆撞形，看着像"未激活"。
 *
 * ⚠️ 2026-11-20（T13）：`switch` 从枚举里删了（它没有生产者），
 * 这里跟着只剩 `seg-req`。
 */
function isLineRow(event: LoadEvent): boolean {
  if (event.kind === undefined) return false;
  return event.stage === 'seg-req';
}

/**
 * 事件的明细行（`.ld-detail`）：**有 host 给 host，没有就给 `note`**。
 *
 * `note` 是技术层原值，两条用途：
 *
 * | 阶段 | `note` | 显示成 |
 * | --- | --- | --- |
 * | `error` | `code=3` | `code=3`（`MediaError.code`，排查"网慢 vs 被拦"靠它） |
 * | `ext-patch` | `接管取流` / `改写响应` | 同字面，说清是哪一种介入 |
 *
 * 都没有就 `null` —— **不渲染空占位**（里程碑本来就没有明细）。
 *
 * @param event 一条已归一的事件
 */
function eventDetail(event: LoadEvent): string | null {
  if (event.host !== undefined && event.host.length > 0) return event.host;
  if (event.note !== undefined && event.note.length > 0) return event.note;
  return null;
}

/**
 * 事件序列 → 时间轴行（**请求与返回合并成一行**）。
 *
 * ## 为什么合并（2026-11-20 真机截图，本轮最重要的一条）
 *
 * B站 会同时向两条线路发分片请求，`seg-req` / `seg-res` 交错排列，平铺着看
 * 分不清哪个返回属于哪个请求。配对规则与理由写在 `core/loading/timeline.ts`
 * 的 `pairSegments()` 头上，这里只负责**渲染成一行**：
 *
 * ```text
 * ◇ 下载视频片段          4.22s → 4.39s · 0.17s
 *   xy116x196x140x34xy.mcdn.bilivideo.cn
 * ```
 *
 * ## 哪些事件会被吃掉
 *
 * - `seg-res` **一律**不出独立行：配上的已经并进请求那行，配不上的按
 *   `pairSegments()` 的规则丢弃（对应的请求在采集窗口外，凭空造一条"只有返回"
 *   比不显示更容易误导）。
 * - 其它阶段各占一行（里程碑）。
 *
 * 真机那份 9 条事件因此变成 **6 行**（3 段配对 + stall / canplay / playing）。
 *
 * 竖向位置 = 传入顺序（`buildTimeline()` 已排好），这里**不再排序**。
 *
 * ## 空档分隔行（`kind: 'gap'`）是**派生**出来的，不来自任何事件
 *
 * 相邻两个节点之间隔了 ≥ `GAP_THRESHOLD_MS` 就插一行。它不是事件：
 * `stage` 为 `null`、`marker` 为 `null`、`meta` 为空，文案见 `gapText()`。
 * 参数用**上一条行覆盖到的结束时刻**（配对行是返回时刻），所以只会把间隔算小、
 * 不会把一段正在下载的时间说成"没有事件"。
 */
export function buildTimelineRows(events: readonly LoadEvent[]): TimelineRow[] {
  const pairByKey = new Map<string, SegmentPair>();
  for (const pair of pairSegments(events)) pairByKey.set(segKey(pair.t, pair.host), pair);

  const rows: TimelineRow[] = [];
  /**
   * 上一条**显示出来的行**的结束时刻。
   *
   * 配对行用 `doneAt`（不是请求时刻）：里程碑的"+x.xxs"要回答的是
   * "上一个动作**做完**之后隔了多久"，用请求时刻会把这段下载耗时算进间隔里。
   * 被吃掉的 `seg-res` 不更新它（它们不是行）。空档行同样不更新它。
   */
  let previous: number | null = null;

  /**
   * 在时刻 `t` 那一行之前按需插一条空档分隔行。
   *
   * `previous` 是"上一行**覆盖到的**结束时刻"：`t - previous` 因此只会等于或
   * **小于**两个节点名义时刻之差 —— 差值可能为负（两条分片请求在时间上重叠），
   * 那种情况自然落在阈值以下，不会插行，也不需要额外判断。
   */
  const pushGapBefore = (t: number): void => {
    if (previous === null) return;
    const ms = t - previous;
    if (ms < GAP_THRESHOLD_MS) return;

    rows.push({
      kind: 'gap',
      stage: null,
      label: gapText(ms),
      meta: '',
      detail: null,
      marker: null,
      tone: 'muted',
      dimTitle: true,
      dangerTitle: false,
    });
  };

  for (const event of events) {
    // 返回不单独成行，见函数头
    if (event.stage === 'seg-res') continue;

    const pair =
      event.stage === 'seg-req' && event.host !== undefined && event.host.length > 0
        ? pairByKey.get(segKey(event.t, event.host))
        : undefined;

    if (pair !== undefined) {
      pushGapBefore(pair.t);

      const unmatched = pair.doneAt === null || pair.ms === null;
      const look = describeEventMarker(event);
      rows.push({
        kind: 'segment',
        stage: event.stage,
        label: SEGMENT_LABEL,
        meta: unmatched
          ? `${seconds(pair.t)}s · 未完成`
          : `${seconds(pair.t)}s → ${seconds(pair.doneAt ?? pair.t)}s · ${seconds(pair.ms ?? 0)}s`,
        detail: pair.host,
        marker: look.marker,
        tone: look.tone,
        /**
         * ⚠️ 未完成用**次要文字色**，不用危险色：竞速里被丢弃的那条请求
         * 正常得很，涂红会让用户以为网络出问题了。
         */
        dimTitle: unmatched,
        dangerTitle: false,
      });
      previous = pair.doneAt ?? pair.t;
    } else {
      pushGapBefore(event.t);

      const line = isLineRow(event);
      const look = describeEventMarker(event);
      /**
       * 要不要画圆点。
       *
       * - 线路行（`seg-req`）用线路形状；
       * - `ext-patch`（扩展介入）**也画**：它是空心圆 + `--pluma-accent`，
       *   而且图例里有一条「○ 扩展介入」与它对应（`legendEntries()`）。
       *   裁决 ④ 让里程碑改用短竖线，理由是"空心圆与图例里的线路撞形"——
       *   有了图例条目，这个理由不再成立，而颜色/形状正是这一行最该被看见的东西；
       * - 其余里程碑用短竖线（`marker: null`）。
       */
      const usesMarker = line || event.stage === 'ext-patch';
      rows.push({
        kind: 'event',
        stage: event.stage,
        label: stageLabel(event.stage),
        meta:
          previous === null
            ? `${seconds(event.t)}s`
            : `${seconds(event.t)}s +${seconds(event.t - previous)}s`,
        /**
         * 明细：有 host 给 host；没有就用 `note`（`error` 的 `code=3`、
         * `ext-patch` 的 `接管取流` / `改写响应`）。
         *
         * 2026-11-20（P1-6）：`MediaError.code` 以前采了又扔 —— 时间轴上
         * 「播放出错」和「卡了一下」长得一样，分不清"网慢"与"被拦"。
         */
        detail: eventDetail(event),
        // 里程碑没有线路形状：左侧画短竖线（见 TimelineRow.marker 的注释）
        marker: usesMarker ? look.marker : null,
        tone: look.tone,
        dimTitle: false,
        dangerTitle: event.stage === 'error',
      });
      previous = event.t;
    }
  }

  return rows;
}

// ─────────────────────────── 速览行 ───────────────────────────

/** 速览行的渲染模型 */
export interface LoadingQuickView {
  /** 主行文案 */
  title: string;
  tone: LoadingTone;
  /** 副行；`null` = 整行不渲染（`playing` 缺失） */
  sub: string | null;
  marker: MarkerShape;
  /** 有没有可展开的详情（只有拿到快照才有） */
  hasDetail: boolean;
}

/**
 * 通道结局 → 速览行；`null` = **整卡不渲染**。
 *
 * 两种 `null` 来源：
 *   - `absent`（非播放页）：本页没有加载这回事，摆一张卡等于让用户等一个不会来的东西
 *   - `undefined`（调用方没给）：与 `absent` 同义，见 `QualityView.loading`
 */
export function buildLoadingQuick(outcome: LoadingOutcome | undefined): LoadingQuickView | null {
  if (outcome === undefined || outcome.kind === 'absent') return null;

  if (outcome.kind === 'unanswered') {
    /**
     * 没人应答。⚠️ **不许**画成"还没有数据"：那会让人以为播放一会儿就有了，
     * 而实际是这条通道根本没通（刷新页面才可能恢复）。
     */
    return { title: TITLE_UNREADABLE, tone: 'bad', sub: null, marker: 'ring', hasDetail: false };
  }

  const snapshot = outcome.snapshot;
  /**
   * ⚠️ 三态由 `describeSnapshotLine()` 决定，**不要**在这里写
   * `confidence === 'none' ? describeLine(null) : …`：`unknown` 现在会进 `hosts`
   * 而 `actual` 仍是 `null`，"有流量但全部认不出"会被误显示成"没有数据"（P0-1）。
   */
  const line = describeSnapshotLine(snapshot);

  return {
    title: line.title,
    tone: line.tone,
    sub: describeQuickSub(snapshot),
    marker: line.marker,
    hasDetail: true,
  };
}

// ─────────────────────────── DOM：形状 ───────────────────────────

/**
 * 内联 SVG 形状。照 `dom.ts` 的写法（`createElementNS`，**不用 innerHTML**）。
 *
 * 填色/描边一律 `currentColor`：色调由外层的 `.ld-tone-*` 给，
 * 形状本身不认识任何颜色 —— 这样"哪条线路是什么颜色"只有 CSS 一处判据。
 */
function markerSvg(shape: MarkerShape, size = 12): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.pointerEvents = 'none';
  svg.style.flex = '0 0 auto';

  if (shape === 'disc') {
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', '6');
    dot.setAttribute('cy', '6');
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', 'currentColor');
    dot.setAttribute('stroke', 'none');
    svg.appendChild(dot);
    return svg;
  }

  if (shape === 'diamond') {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M6 2.2 9.8 6 6 9.8 2.2 6Z');
    svg.appendChild(path);
    return svg;
  }

  if (shape === 'triangle') {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M6 2.6 10 9.4H2Z');
    svg.appendChild(path);
    return svg;
  }

  /**
   * `dashed`：虚线空心圆 = **认不出来源的线路**（2026-11-20，P0-1）。
   *
   * 与 `ring`（扩展介入）几何完全相同，只靠 `stroke-dasharray` 区分 ——
   * 这正是色盲第二条线索的用法：形状/线型不同，颜色相同也能分开。
   * 虚线还自带一层语义："这条线我们没能确认"。
   */
  if (shape === 'dashed') {
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', '6');
    circle.setAttribute('cy', '6');
    circle.setAttribute('r', '3');
    circle.setAttribute('stroke-dasharray', '1.6 1.6');
    svg.appendChild(circle);
    return svg;
  }

  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('cx', '6');
  ring.setAttribute('cy', '6');
  ring.setAttribute('r', '3');
  svg.appendChild(ring);
  return svg;
}

// ─────────────────────────── DOM：速览行 ───────────────────────────

/**
 * 画质 Tab 的速览行。
 *
 * ```text
 * 线路                          详情 ›
 * ● B站官方线路（自建 CDN）
 *   开局 3.3s · 3 条线路
 * ```
 *
 * ## 整行可点，而不是只有「详情」两个字
 *
 * 命中区是 272px 宽的一整行。只有两个字可点的话，用户要先瞄准 ——
 * 而这行的全部意义就是"点进去看细节"。
 *
 * ## 没有详情可看时**不渲染**「详情 ›」
 *
 * `onOpen` 缺席（或没有快照）时，那个箭头会变成一个点了没反应的控件 ——
 * handoff §2.3 第 9 条：死控件比没有控件更糟。
 *
 * @param view 见 `buildLoadingQuick`
 * @param onOpen 点整行时调用；`undefined` = 本次没有可进的二级页
 */
export function loadingQuickRow(view: LoadingQuickView, onOpen?: () => void): HTMLElement {
  /** 有详情可看**且**调用方真的给了入口，才算可点 —— 缺一个就退化成静态行 */
  const open = view.hasDetail ? onOpen : undefined;

  /**
   * 可点时用 `<button>`（键盘可达、读屏可识别），否则用 `<div>`。
   * 不可点却渲染成 button，会让读屏用户听到一个按不动的按钮。
   */
  const row = open !== undefined ? el('button', 'ld-quick') : el('div', 'ld-quick flat');
  if (open !== undefined) {
    (row as HTMLButtonElement).type = 'button';
    onClick(row, open);
  }

  const head = el('div', 'ld-quick-head');
  head.appendChild(el('span', 'ld-quick-label', '线路'));
  if (open !== undefined) {
    const more = el('span', 'ld-quick-more', '详情');
    more.appendChild(iconChevron('right', 10));
    head.appendChild(more);
  }
  row.appendChild(head);

  // 色调挂在这一行上：标题与圆点都靠 currentColor 继承，只有一处判据
  const main = el('div', `ld-quick-main ld-tone-${view.tone}`);
  const dot = el('span', 'ld-quick-dot');
  dot.appendChild(markerSvg(view.marker));
  main.appendChild(dot);
  main.appendChild(el('span', 'ld-quick-title', view.title));
  row.appendChild(main);

  if (view.sub !== null) row.appendChild(el('span', 'ld-quick-sub', view.sub));

  return row;
}

// ─────────────────────────── DOM：二级浮层 ───────────────────────────

/**
 * 图例的外观表：**只解释"画的形状是什么意思"**，不含任何数据。
 *
 * ## ⚠️ 图例按数据动态生成，不再写死四项（2026-11-20 Lead 裁决 ③）
 *
 * 旧实现固定列四项，其中「扩展介入」与「第三方」在真机上**永远不会出现**：
 * 我们所有打点都在 isolated 侧，没有任何事件能产出 `ext-patch`。
 * 图例承诺了不存在的类别 —— 那是在解释一个不会出现的形状。
 *
 * 现在只列**本次真的出现过**的东西（`legendEntries()`），一项都没有就整块不画。
 * `2026-11-20 T11` 起 `ext-patch` 有了数据源（主世界 `reportExtPatch()`），
 * 所以「扩展介入」按需回到图例里 —— 仍然只在**本次真的出现过**时出现。
 */
const LEGEND_LOOK: Record<
  'official' | 'pcdn' | 'third-party',
  { text: string; shape: MarkerShape; tone: LoadingTone }
> = {
  official: { text: '官方', shape: 'disc', tone: 'ok' },
  pcdn: { text: 'P2P', shape: 'diamond', tone: 'warn' },
  'third-party': { text: '第三方', shape: 'triangle', tone: 'muted' },
};

/**
 * 「扩展介入」的图例外观。
 *
 * 空心圆 + `--pluma-accent`，与时间轴里那一行（`describeEventMarker()` 的
 * `accent` / `ring` 档）**同一个造型**：图例说的和行里画的不许分家。
 */
const LEGEND_EXT_PATCH: { text: string; shape: MarkerShape; tone: LoadingTone } = {
  text: '扩展介入',
  shape: 'ring',
  tone: 'accent',
};

/**
 * 「认不出来源」的图例外观（2026-11-20，P0-1）。
 *
 * 虚线空心圆 + 次要色。**必须有这一项**：`unknown` 现在会真的出现在时间轴上，
 * 一个画出来却没人解释的形状，比不画更容易误导。
 */
const LEGEND_UNKNOWN: { text: string; shape: MarkerShape; tone: LoadingTone } = {
  text: '认不出来源',
  shape: 'dashed',
  tone: 'muted',
};

/** 图例的固定顺序：官方 → P2P → 第三方（不按出现顺序，免得每次截图都不一样） */
const LEGEND_ORDER: readonly ('official' | 'pcdn' | 'third-party')[] = [
  'official',
  'pcdn',
  'third-party',
];

/**
 * 本次真的出现过的线路类别（图例用）。
 *
 * 来源是 `hosts[].cls` 与 `events[].kind` **两边取并**：
 * 只看 hosts 会漏掉"请求发生过但统计没记到"的边角，只看 events 会漏掉
 * 那些只出现在 hosts 里的线路（事件被环形缓冲挤掉时就是这样）。
 * `unknown` 不算线路，不进图例。
 */
export function legendKinds(
  snapshot: LoadingSnapshotLite,
): Array<'official' | 'pcdn' | 'third-party'> {
  const seen = new Set<string>();
  for (const h of snapshot.hosts) seen.add(h.cls);
  for (const e of snapshot.events) {
    if (e.kind !== undefined) seen.add(e.kind);
  }
  return LEGEND_ORDER.filter((k) => seen.has(k));
}

/**
 * 本次事件序列里有没有「扩展介入」。
 *
 * 判据只看**事件**（不看 hosts —— 那里面没有这个阶段）：
 * `ext-patch` 有两个来源（`recordPlayurl()` 的 `接管取流`、主世界的 `改写响应`），
 * 时间轴上只留第一条（去重在采集侧，见 `loading-trace.ts`）。
 */
export function legendHasExtPatch(snapshot: LoadingSnapshotLite): boolean {
  return snapshot.events.some((e) => e.stage === 'ext-patch');
}

/** 本次有没有认不出来源的 host（`unknown`） */
export function legendHasUnknown(snapshot: LoadingSnapshotLite): boolean {
  return snapshot.hosts.some((h) => h.cls === 'unknown');
}

/**
 * 图例条目（按绘制顺序）。
 *
 * 顺序：官方 → P2P → 第三方 → **认不出** → 扩展介入。
 *
 * - 前三个回答"这几条线是什么"；
 * - 「认不出」是线路层面的第四种情况（`unknown`，2026-11-20 P0-1 起会真的出现），
 *   它必须排在三个已知类别之后 —— 它是兜底，不是并列的一种 CDN；
 * - 「扩展介入」回答的是"扩展在这一刻动过手"，与线路无关，所以放最后。
 *
 * 一项都没有就返回空数组，调用方据此**整块不画**（图例不承诺没出现的形状）。
 */
export function legendEntries(
  snapshot: LoadingSnapshotLite,
): Array<{ text: string; shape: MarkerShape; tone: LoadingTone }> {
  const entries = legendKinds(snapshot).map((kind) => LEGEND_LOOK[kind]);
  if (legendHasUnknown(snapshot)) entries.push(LEGEND_UNKNOWN);
  if (legendHasExtPatch(snapshot)) entries.push(LEGEND_EXT_PATCH);
  return entries;
}

/** 二级浮层「本次加载」要调出去的三件事 */
export interface LoadingDetailActions {
  /** 返回上一级 */
  back: () => void;
  /** 重新读一次快照（⟳）。**入口不重新采集就等于在展示上一次的结果** */
  refresh: () => void;
  /** 进既有的「诊断」浮层（压栈，不是跳转） */
  openDiagnostics: () => void;
}

/**
 * 顶栏：返回 + 标题 + ⟳。
 *
 * 形态照抄 `diagnosticsPane` 的那一条（`sub-bar` / `sub-back` / `sub-title`），
 * **不自创第二套**：二级浮层的返回条在项目里只有这一种样子。
 */
function detailBar(actions: LoadingDetailActions): HTMLElement {
  const bar = el('div', 'sub-bar');

  const backBtn = el('button', 'sub-back');
  backBtn.type = 'button';
  backBtn.appendChild(iconChevron('left'));
  backBtn.appendChild(el('span', undefined, '返回'));
  backBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.back();
  });
  bar.appendChild(backBtn);
  bar.appendChild(el('span', 'sub-title', '本次加载'));

  const refreshBtn = el('button', 'sub-back', '⟳');
  refreshBtn.type = 'button';
  refreshBtn.setAttribute('aria-label', '重新读取加载数据');
  refreshBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.refresh();
  });
  bar.appendChild(refreshBtn);

  return bar;
}

/** 结论卡：44px 圆底图标 + 小字 + 大字结论 + 胶囊，下面一排计数 */
function conclusionCard(snapshot: LoadingSnapshotLite): HTMLElement {
  /**
   * ⚠️ 三态走 `describeSnapshotLine()`（P0-1）：
   * 有已知线路 → 正常；有 host 但全部认不出 → 「有 N 条线路认不出来源」+ 虚线圆；
   * 一条 host 都没有 → 「还不知道走哪条线路」。
   */
  const known = snapshot.actual !== null;
  const line = describeSnapshotLine(snapshot);

  /**
   * 色调挂在**卡片**上：44px 圆底用 `color-mix(currentColor 14%)` 调出语义色的淡底，
   * 大字与图标都继承同一个 `currentColor`。换色调只改一个类名。
   */
  const card = el('div', `ld-conclusion ld-tone-${line.tone}`);

  const icon = el('div', 'ld-conclusion-icon');
  // 20px 的形状在这里与时间轴/速览行**同一个造型**，不另找一套图标语言
  icon.appendChild(markerSvg(line.marker, 20));
  card.appendChild(icon);

  const body = el('div', 'ld-conclusion-body');
  body.appendChild(el('span', 'ld-conclusion-kicker', '本次加载'));
  body.appendChild(el('span', 'ld-conclusion-title', line.title));
  const tag = describeKindPill(known ? (snapshot.actual?.cls ?? null) : null);
  // 认不出来就没有胶囊 —— 不编一个「未知」标签（那看起来像一种线路）
  if (tag !== null) {
    const holder = el('div', 'ld-conclusion-tag');
    holder.appendChild(pill(tag.text, tag.tone));
    body.appendChild(holder);
  }
  card.appendChild(body);

  const counts = describeCounts(snapshot);
  if (counts.length > 0) {
    const row = el('div', 'ld-conclusion-counts');
    for (const c of counts) row.appendChild(el('span', 'ld-count', c));
    card.appendChild(row);
  }

  /**
   * 结论与时间轴自洽（裁决 ②）：结论说官方、时间轴上却有橙色 P2P 节点时，
   * 在这一行说清"那几条没占主导"。没有 P2P 就整句不出现。
   */
  const caveat = describePcdnCaveat(snapshot);
  if (caveat !== null) card.appendChild(el('span', 'ld-conclusion-note', caveat));

  return card;
}

/**
 * 时间轴一行。
 *
 * ## 空档行（`kind === 'gap'`）走另一套骨架
 *
 * 它**不是事件**：不画圆点、不画短竖线、也不参与"圆点列 + 竖线连接"那套布局。
 * 只有一条细横线（CSS 的 `.ld-gap::before`）加一句说明，文字本身已经在
 * `row.label` 里（`gapText()`）。上一行的 `.ld-conn` 到这里断开 ——
 * 这正是想让人看到的"中间有一段没有列出来的时间"。
 */
function timelineRow(row: TimelineRow, isLast: boolean): HTMLElement {
  if (row.kind === 'gap') {
    return el('div', 'ld-row ld-gap', row.label);
  }

  const line = el('div', 'ld-row');

  const wrap = el('div', 'ld-node-wrap');
  // 竖线连接上下两个点：最后一行的线会挂不到下一个点，所以隐藏
  if (!isLast) wrap.appendChild(el('span', 'ld-conn'));

  if (row.marker === null) {
    /**
     * 里程碑：一根 10px 的短竖线，**不画圆点**（裁决 ④）。
     *
     * 它们是"时间走到了这里"，不是"数据从哪条线路来" —— 共用圆点会让用户
     * 把它们当成一种线路，而且和空心圆撞形、看着像"未激活"。
     */
    wrap.appendChild(el('span', 'ld-tick'));
  } else {
    const node = el('div', `ld-node ld-tone-${row.tone}`);
    node.appendChild(markerSvg(row.marker));
    wrap.appendChild(node);
  }
  line.appendChild(wrap);

  const body = el('div', 'ld-body');
  const titleRow = el('div', 'ld-title-row');
  const titleClass = `ld-title${row.dimTitle ? ' ld-tone-muted' : ''}${
    row.dangerTitle ? ' ld-tone-bad' : ''
  }`;
  titleRow.appendChild(el('span', titleClass, row.label));
  /**
   * 右列元信息（`ld-delta` 这个名字留着不改 —— 它在类名契约里）。
   *
   * ⚠️ 用 `tabular-nums` 让所有行右边缘对齐：`+0.40s` 与 `+10.20s`
   * 字宽不同，不对齐会读成"这几行没对齐"。
   */
  titleRow.appendChild(el('span', 'ld-delta', row.meta));
  body.appendChild(titleRow);

  if (row.detail !== null) body.appendChild(el('span', 'ld-detail', row.detail));
  line.appendChild(body);

  return line;
}

/**
 * 二级浮层「本次加载」。
 *
 * ## 结构（自上而下）
 *
 * ```text
 * ‹ 返回   本次加载              ⟳
 * ┌──────────────────────────────┐
 * │ (44) 本次加载                 │
 * │      B站官方线路（自建 CDN） [官方 CDN] │
 * │      开局 3.27s  3 条线路  2 次切换   │
 * │      其中 1 条是 P2P 线路，未占主导   │
 * └──────────────────────────────┘
 * 时间轴
 * ▏卡了一下              1.77s
 * ● 下载视频片段         2.53s → 2.82s · 0.29s
 * │ cn-jsnt-ct-01-07.bilivideo.com
 * ▏可以播放              3.27s +0.45s
 * ⋯ 5.01s（这段时间的片段未逐段列出）      ← 空档分隔行，不是事件
 * ○ 扩展介入             8.28s +5.01s
 * ◆ 下载视频片段         8.40s → 8.55s · 0.15s
 *   xy220x180x77x45xy.mcdn.bilivideo.cn
 * 图例  ● 官方  ◆ P2P  ○ 扩展介入
 * 查看完整诊断 ›
 * 时间从页面开始加载算起；+x.xxs 是比上一条多花的时间，…（见 TIMELINE_FOOTNOTE）
 * ```
 *
 * ## 拿不到数据时**不画空壳**
 *
 * 没有快照就只留顶栏 + 一句实话 + 诊断入口：一张空的时间轴会让人以为
 * "这次加载什么都没发生"，而实际是**没读到**。
 *
 * @param outcome 通道结局（`undefined` 与 `absent` 同义）
 * @param actions 见 `LoadingDetailActions`
 */
export function loadingDetailPane(
  outcome: LoadingOutcome | undefined,
  actions: LoadingDetailActions,
): HTMLElement {
  const box = el('div', 'tab-pane');
  box.appendChild(detailBar(actions));

  if (outcome === undefined || outcome.kind !== 'ok') {
    const unanswered = outcome?.kind === 'unanswered';
    box.appendChild(
      el(
        'p',
        `pane-note${unanswered ? ' ld-tone-bad' : ''}`,
        unanswered ? TITLE_UNREADABLE : '本页还没有可显示的加载数据',
      ),
    );
    box.appendChild(diagnosticsEntry(actions));
    return box;
  }

  const snapshot = outcome.snapshot;
  box.appendChild(conclusionCard(snapshot));

  /**
   * ⚠️ **不许静默**：环形缓冲丢了较早的事件时，时间轴的开头**不是**页面开始。
   * 不说这句话，用户会以为"第一条分片请求发生在 3 秒" —— 而事实是
   * 前 3 秒的东西被挤掉了（`core/loading/timeline.ts` 文件头最后一段）。
   * 不写具体条数：快照里没有上一个上限值，编一个数字比不写更糟。
   */
  if (snapshot.truncated) {
    box.appendChild(
      el('p', 'pane-note ld-tone-warn', '更早的事件被丢掉了 —— 这里只保留最近一段。'),
    );
  }

  box.appendChild(el('p', 'diag-section', '时间轴'));

  const rows = buildTimelineRows(snapshot.events);
  if (rows.length === 0) {
    box.appendChild(el('p', 'pane-note', '还没有加载事件。'));
  } else {
    const timeline = el('div', 'ld-timeline');
    rows.forEach((row, i) => {
      timeline.appendChild(timelineRow(row, i === rows.length - 1));
    });
    box.appendChild(timeline);
  }

  /**
   * 图例：**按本次出现的东西动态生成**（裁决 ③）。
   *
   * 一项都没有时整块不渲染 —— 包括那个「图例」小标题。画一个空图例等于说
   * "这里有形状要解释"，而实际一个形状都没有。
   * 「扩展介入」排在线路类别之后，且同样只在本次真的出现过 `ext-patch` 时才画。
   */
  const legendItems = legendEntries(snapshot);
  if (legendItems.length > 0) {
    box.appendChild(el('p', 'diag-section', '图例'));
    const legend = el('div', 'ld-legend');
    for (const look of legendItems) {
      const cell = el('div', `ld-legend-item ld-tone-${look.tone}`);
      cell.appendChild(markerSvg(look.shape));
      cell.appendChild(el('span', 'ld-legend-text', look.text));
      legend.appendChild(cell);
    }
    box.appendChild(legend);
  }

  box.appendChild(diagnosticsEntry(actions));

  /**
   * 尾注：**按有没有 `nav` 原点分两版**（见 `timelineFootnote()`）。
   * 番剧换集后（`resetLoadingTrace()` 不补 `nav`）这里会多一句
   * 「本集开始于页面加载后 5:02.41」—— 否则时间轴第一行 `302.41s` 会让人
   * 以为这一集从 302 秒开始。
   */
  box.appendChild(el('p', 'pane-note', timelineFootnote(snapshot)));

  return box;
}

/**
 * 「查看完整诊断 ›」入口。
 *
 * 复用 `sub-entry` 的三个既有类（入口行 / 提示 / 箭头），与净化 Tab 的
 * 「诊断 ▸」长得一样 —— 用户已经认识这个入口了。
 *
 * ⚠️ 箭头那三行**不 import `tabs.ts` 的 `entryChevron()`**：`tabs.ts` 已经
 * import 了本文件（速览行要挂在画质 Tab 里），反向 import 会成环。
 */
function diagnosticsEntry(actions: LoadingDetailActions): HTMLElement {
  const btn = el('button', 'sub-entry');
  btn.type = 'button';
  btn.appendChild(el('span', undefined, '查看完整诊断'));
  btn.appendChild(el('span', 'sub-entry-hint', '自检信息 · 日志 · 导出'));
  const chevron = el('span', 'sub-entry-chevron');
  chevron.appendChild(iconChevron('right'));
  btn.appendChild(chevron);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.openDiagnostics();
  });
  return btn;
}
