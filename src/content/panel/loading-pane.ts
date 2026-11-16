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
import { detectSwitches, type LoadEvent, type LoadStage } from '@core/loading/timeline';
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
 */
export type MarkerShape = 'disc' | 'diamond' | 'triangle' | 'ring';

/** 一条线路描述 —— 速览行主行与结论卡大字**共用**这一份，不许各拼一句 */
export interface LineDescription {
  title: string;
  tone: LoadingTone;
  marker: MarkerShape;
}

/**
 * 阶段中文名。**固定映射**：阶段枚举只有 12 个值，逐个给中文，
 * 不做"把英文换成中文"的通用转换（那会拼出「开始下载分片」这种半成品）。
 */
const STAGE_LABEL: Record<LoadStage, string> = {
  nav: '页面开始',
  'playurl-req': '发出取流请求',
  'playurl-res': 'B站 返回线路清单',
  'ext-patch': '扩展介入',
  'seg-req': '开始下载分片',
  'seg-res': '分片到达',
  canplay: '可以播放',
  playing: '开始播放',
  switch: '换了一条线路',
  stall: '卡了一下',
  error: '播放出错',
  blocked: '已屏蔽',
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

/** 认不出线路时说的那句话（`actual === null` / `confidence === 'none'`） */
const TITLE_UNKNOWN = '还不知道走哪条线路';

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
       * `unknown`：host 认不出线路。`snapshotOf()` 已经把它从 `actual` 里滤掉了，
       * 所以正常路径走不到；真走到了就如实说"不知道"，**不当成 PCDN**
       * （`classify.ts` 第 1 条：不替用户拦来源不明的东西）。
       */
      return { title: TITLE_UNKNOWN, tone: 'muted', marker: 'ring' };
  }
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

/** 秒（1 位小数）。`toFixed` 比 `Math.round` 稳：`.5` 的方向由字符串规则定，不看实现 */
function seconds1(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/** 绝对时刻（2 位小数，`0.42s` 这种）。面板里要能对上采集侧报的毫秒数 */
function seconds2(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/** 第一条 `playing` 事件；没有就 `null`（**不补 0**） */
export function playingEvent(events: readonly LoadEvent[]): LoadEvent | null {
  return events.find((e) => e.stage === 'playing') ?? null;
}

/**
 * 速览行的副行：`开局 3.3s · 3 条线路`。
 *
 * ## 单位是 `s`，不是「秒」（2026-11-20 Lead 裁决）
 *
 * 面板里 `s` 已经是既定单位：时间轴 `0.42s`、增量 `+0.8s`、尾注 `+x.xs`。
 * 副行写「秒」会让**同一张卡里的同一个数字**出现两种写法（`开局 1.8s` 与
 * `1.8s`），用户对照时会以为是两个不同的值。
 *
 * ## `playing` 缺失时整行不显示（不补 0）
 *
 * "开局 0.0s"是一句**看起来像数据**的话，而事实是"没测到开始播放" ——
 * 补 0 会把"缺一条信息"伪装成"测到了一个很好的值"。
 * `core/loading/timeline.ts` 文件头第 3 条（绝不补造事件）是同一个道理。
 */
export function describeQuickSub(snapshot: LoadingSnapshotLite): string | null {
  const playing = playingEvent(snapshot.events);
  if (playing === null) return null;
  return `开局 ${seconds1(playing.t)}s · ${String(snapshot.hosts.length)} 条线路`;
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
  if (playing !== null) counts.push(`开局 ${seconds1(playing.t)}s`);

  if (snapshot.hosts.length > 0) counts.push(`${String(snapshot.hosts.length)} 条线路`);

  const switches = detectSwitches(snapshot.events).length;
  if (switches > 0) counts.push(`${String(switches)} 次切换`);

  return counts;
}

/** 一条时间轴行（纯数据，DOM 由 `loadingDetailPane` 装配） */
export interface TimelineRow {
  stage: LoadStage;
  /** 阶段中文名 */
  label: string;
  /** 绝对时刻，如 `2.53s` */
  at: string;
  /** 相对上一条的增量，如 `+0.8s`；**首条为 `null`**（没有"上一条"） */
  delta: string | null;
  /** 明细（有 host 才有一行）；`null` = 不渲染，不留占位符 */
  detail: string | null;
  tone: LoadingTone;
  marker: MarkerShape;
}

/**
 * 阶段 → 颜色 + 形状。
 *
 * 优先级：**阶段先于线路**。`ext-patch`（扩展介入）与 `error` / `blocked`
 * 与"哪条线路"无关，用阶段自己的语义色 —— 它们恰恰是排查时要一眼找到的两种。
 */
export function describeEventMarker(event: LoadEvent): { tone: LoadingTone; marker: MarkerShape } {
  if (event.stage === 'ext-patch') return { tone: 'accent', marker: 'ring' };
  if (event.stage === 'error' || event.stage === 'blocked') return { tone: 'bad', marker: 'ring' };

  switch (event.kind) {
    case 'official':
      return { tone: 'ok', marker: 'disc' };
    case 'pcdn':
      return { tone: 'warn', marker: 'diamond' };
    case 'third-party':
      return { tone: 'muted', marker: 'triangle' };
    default:
      // 与线路无关的阶段（nav / playurl-* / canplay / playing / stall / switch）
      return { tone: 'muted', marker: 'ring' };
  }
}

/**
 * 事件序列 → 时间轴行。
 *
 * 竖向位置 = **传入顺序**（`buildTimeline()` 已按 `t` 升序排好，且稳定），
 * 这里**不再排序** —— 再排一次就等于对同一件事有两处判据。
 *
 * `delta` 相对**上一条**（不是上一条同阶段的）：用户看的是"这一段时间花在哪"，
 * 相邻两步之间的间隔才是他感知到的卡顿。
 */
export function buildTimelineRows(events: readonly LoadEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previous: number | null = null;

  for (const event of events) {
    const { tone, marker } = describeEventMarker(event);
    rows.push({
      stage: event.stage,
      label: stageLabel(event.stage),
      at: `${seconds2(event.t)}s`,
      delta: previous === null ? null : `+${seconds1(event.t - previous)}s`,
      // 没有 host 就不渲染明细行 —— 占位符（`—` / `未知`）会让人以为这里本该有值
      detail: event.host === undefined || event.host.length === 0 ? null : event.host,
      tone,
      marker,
    });
    previous = event.t;
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
  const line = snapshot.confidence === 'none' ? describeLine(null) : describeLine(snapshot.actual);

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

/** 图例四项。文案与形状都是**固定的**：它们解释的是"画的是什么"，不是数据 */
const LEGEND: ReadonlyArray<{ text: string; shape: MarkerShape; tone: LoadingTone }> = [
  { text: '官方', shape: 'disc', tone: 'ok' },
  { text: 'P2P', shape: 'diamond', tone: 'warn' },
  { text: '第三方', shape: 'triangle', tone: 'muted' },
  { text: '扩展介入', shape: 'ring', tone: 'accent' },
];

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
  const known = snapshot.confidence !== 'none' && snapshot.actual !== null;
  const line = known ? describeLine(snapshot.actual) : describeLine(null);

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

  return card;
}

/** 时间轴一行 */
function timelineRow(row: TimelineRow, isLast: boolean): HTMLElement {
  const line = el('div', 'ld-row');

  const wrap = el('div', 'ld-node-wrap');
  // 竖线连接上下两个点：最后一行的线会挂不到下一个点，所以隐藏
  if (!isLast) wrap.appendChild(el('span', 'ld-conn'));
  const node = el('div', `ld-node ld-tone-${row.tone}`);
  node.appendChild(markerSvg(row.marker));
  wrap.appendChild(node);
  line.appendChild(wrap);

  const body = el('div', 'ld-body');
  const titleRow = el('div', 'ld-title-row');
  titleRow.appendChild(el('span', 'ld-title', row.label));
  /**
   * 右列两件事：绝对时刻 + 相对增量。首条没有"上一条"，只显示时刻。
   * ⚠️ 两个数字都写在同一行右侧，用 `tabular-nums` 让它们纵向对齐 ——
   * 否则 `+0.8s` 与 `+10.2s` 会把右边的边距撑得忽宽忽窄。
   */
  titleRow.appendChild(
    el('span', 'ld-delta', row.delta === null ? row.at : `${row.at} ${row.delta}`),
  );
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
 * │      开局 3.3s  3 条线路  2 次切换     │
 * └──────────────────────────────┘
 * 时间轴
 * ● 页面开始            1.77s
 * │ 开始下载分片        2.53s +0.8s
 * ...
 * 图例  ● 官方  ◆ P2P  ▲ 第三方  ○ 扩展介入
 * 查看完整诊断 ›
 * 时间从页面开始加载算起；右侧 +x.xs 是比上一条多花的时间。
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

  box.appendChild(el('p', 'diag-section', '图例'));
  const legend = el('div', 'ld-legend');
  for (const item of LEGEND) {
    const cell = el('div', `ld-legend-item ld-tone-${item.tone}`);
    cell.appendChild(markerSvg(item.shape));
    cell.appendChild(el('span', 'ld-legend-text', item.text));
    legend.appendChild(cell);
  }
  box.appendChild(legend);

  box.appendChild(diagnosticsEntry(actions));

  box.appendChild(
    el('p', 'pane-note', '时间从页面开始加载算起；右侧 +x.xs 是比上一条多花的时间。'),
  );

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
