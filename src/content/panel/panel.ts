/**
 * 面板的**编排层**：Tab 切换、二级浮层返回栈、写存储、写完主动应用。
 *
 * ## 三层分工
 *
 * | 层 | 文件 | 职责 |
 * | --- | --- | --- |
 * | 数据 | `panel-data.ts` | 取数 + 组装模型（纯函数优先） |
 * | 视图 | `tabs.ts` / `sidebar.ts` | 模型 → DOM，操作 → 回调 |
 * | **编排** | **本文件** | Tab 状态、返回栈、读—改—写、主动应用 |
 *
 * ## ⚠️ 读—改—写：面板是**第二个写者**（ADR 0033 决定五）
 *
 * `writeCleanOptionFlags()` 是**整块覆盖**，而设置页也会写同一个键。
 * 面板如果"只写自己改的那一个键"，另外三个会被重置成缺省值 ——
 * 用户在设置页做的调整会在面板里点一下之后**静默消失**。
 *
 * 所以每次写入前都**重新读一次**（不是复用内存里的旧模型）：
 * 用户在另一个标签页的设置页里改过，这里也必须看到。
 *
 * ## ⚠️ 写完必须主动应用（T5）
 *
 * `content-home.content.ts` 的 `onChanged` 监听只处理**净化偏好**，
 * 而广告清理那一侧的监听器**不存在**（`ads.ts` 的 `installAdObserver` 不读偏好）。
 * 所以面板写完不能只依赖 storage 事件，必须自己调 `applyAdClean()` / `applyHomeClean()`。
 */

import {
  normalizeCleanPreferences,
  type CleanOptionKey,
} from '@/src/content/site-clean/clean-options';
import { applyAdClean } from '@/src/content/site-clean/ads';
import { applyHomeClean } from '@/src/content/site-clean/home-clean';
import {
  readBadgeEnabled,
  readPcdnFilterEnabled,
  readRawCleanOptions,
  writeBadgeEnabled,
  writeCleanHideCategories,
  writeCleanOptionFlags,
  writePcdnFilterEnabled,
} from '@platform/storage/ui-prefs-store';
import { collectFacts, readLastDiagEcho, type DiagRow } from '@platform/diagnostics/collect';
import {
  readDiag,
  readDiagTrace,
  DIAG_LIMIT,
  instanceId,
  type DiagEntry,
} from '@platform/storage/diag-store';
import { el, replaceChildren } from './dom';
import {
  patchCleanOption,
  toggleHideCategory,
  loadPanelModel,
  onLoadingChanged,
  openUpdateWindow,
  readUpdateStatus,
  requestUpdateCheck,
  requestUpdateDismiss,
  writeUpdateAuto,
  fetchLoadingSnapshot,
  type PanelModel,
} from './panel-data';
import { aboutTab, accountTab, cleanTab, displayTab, homeCleanPane, qualityTab } from './tabs';
import { loadingDetailPane, type LoadingOutcome } from './loading-pane';
import { isStreamingReady, type StreamingIdentity } from '@shared/constants/streaming-identity';
import { isNewerThan } from '@core/update/state';
import { UPDATE_RELEASES_PAGE } from '@shared/constants/update';
import type { UpdateStatusView } from '@shared/types/update';
import {
  buildExportPayload,
  describeLogsError,
  describeLogsMetaFallback,
  diagnosticsPane,
  downloadJson,
  exportFileName,
  type LogsMeta,
} from './diagnostics';

/**
 * 四个一级 Tab。
 *
 * ## 为什么 2026-11-10 从三个变成四个（真机反馈）
 *
 * 原来「页内角标」和「诊断 ▸」都塞在**净化** Tab 底部。用户指出位置不对 ——
 * 它们是**界面偏好**和**排查工具**，不是"净化页面内容"。
 *
 * `docs/02-ui-spec.md` §4.3 当初在 options 里就专门论证过这条：
 * > 塞「诊断」页 → 用户会以为它是排查工具，而它是常驻的显示偏好
 *
 * 面板里犯了当初避开过的同一个错，所以单开「显示」Tab。
 */
export const PANEL_TABS = ['quality', 'clean', 'display', 'account', 'about'] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/**
 * Tab 显示文字。
 *
 * ⚠️ **五个 Tab 挤在 300px 里**（2026-11-16 改版前是 280px / 四个），
 * 每个约 56px（扣掉 padding 与 gap）。两字中文在 13px 字号下约 26px，
 * 完全放得下 —— 所以**不需要缩字号或改成图标**。见 `PANEL_CSS` 里 `.tab` 的注释。
 */
const TAB_LABEL: Record<PanelTab, string> = {
  quality: '画质',
  clean: '净化',
  display: '显示',
  account: '账号',
  about: '关于',
};

/**
 * 当前界面在哪一层。
 *
 * ## 为什么用返回栈而不是布尔 `subOpen`
 *
 * 现在只有一层二级（首页净化），布尔就够。但这是**将来加第二层时必然要改的**
 * （例如"画质 ▸ 详细参数"）。把它写成栈，加一层只是多一个 `push`，
 * 而不是回头把 `subOpen: boolean` 改成别的形状、再改所有分支。
 *
 * 栈顶即当前层：`[]` = 一级 Tab 页。
 */
type PanelLevel = readonly { kind: SubKind }[];

/** 二级浮层的种类 */
type SubKind = 'homeClean' | 'diagnostics' | 'loadingDetail';

/** 编排层对外暴露的句柄 */
export interface PanelController {
  /** 切到某个一级 Tab */
  showTab(tab: PanelTab): void;
  /** 重画（模型变了） */
  setModel(model: PanelModel): void;
  /**
   * 接上「有新版本」信号的接收方（贴边条）。
   *
   * 接上时**立刻用当前状态调一次** —— 否则"先建 body、后建 sidebar"的顺序
   * 会丢掉挂载那一刻已读到的状态，用户要等下一次重画才看得到提示。
   */
  setUpdateSink(sink: (available: boolean) => void): void;
  /**
   * 外部推来一份新的更新状态（来自 `storage.onChanged` 的 `pluma:update-state`）。
   *
   * 用于多 Tab 同步：一个面板里看过「关于」之后，别的 Tab 的红点要跟着消失。
   * **不触发 dismiss** —— 推来的状态不代表"用户看过这一版"。
   */
  applyUpdateStatus(next: UpdateStatusView): void;
  /** 当前 Tab */
  currentTab(): PanelTab;
  /** 当前返回栈深度（0 = 一级页） */
  depth(): number;
  /**
   * 在面板底部显示一条提示（登录 / 退出的结果）。
   *
   * ## 为什么需要它（2026-11-10）
   *
   * 旧实现所有消息都是 `.catch(() => null)` —— **失败完全静默**。
   * 用户点「扫码登录」后什么也没发生，无法判断是没开 InPrivate 权限、
   * 网络问题、还是按钮坏了。
   *
   * @param text 提示文案
   * @param ok   `true` 中性/成功色，`false` 危险色
   */
  showNotice(text: string, ok: boolean): void;
  /**
   * 立刻清掉提示条（**不区分成败色**）。
   *
   * 用于"用户刚点了一个会带来新提示的按钮"的那一刻 ——
   * 先清掉上一次的残留，避免"两条红字长得一样、分不清新旧"（裁决 3）。
   *
   * ⚠️ 它**不是**"给失败提示加超时"：失败提示照旧常驻，
   * 这里清的是**上一条**。
   */
  clearNotice(): void;
  /**
   * 卸载：摘掉面板在 `window` 上挂的监听器与待触发的定时器。
   *
   * ## 为什么需要它（2026-11-20）
   *
   * 面板从"换集后主动重取"订阅了 `window` 的 `message`
   * （见 `panel-data.ts` 的 `onLoadingChanged`）。`window` 上的监听器**不跟着
   * DOM 走**：不摘的话用户每关一次开关、每 reload 一次扩展，就多叠一层 ——
   * 之后一次换集会触发 N 次重取（N = 曾经挂载过的次数）。
   *
   * 与 `SidebarHandle.dispose()` **同一形状、同一处调用点**
   * （`content-panel.content.ts` 的 `paint()` 关闭分支与 `ctx.onInvalidated`），
   * 不是新造的生命周期机制。
   */
  dispose(): void;
  /** 整块根节点（塞进 sidebar 的 sheet 里） */
  root: HTMLElement;
}

/**
 * 建出面板的编排（**只调一次**，DOM 建好后靠 `setModel` 更新）。
 *
 * @param actions 需要调到面板外面的动作（登录、关面板）
 */
/**
 * 扩展版本号（诊断导出里用）。
 *
 * ⚠️ 读不到时返回 `'unknown'` 而**不是空串** ——
 * 导出包里的 `version` 为空会让人以为"没记版本"，
 * 而 `'unknown'` 明确表示"这次读失败"。
 */
function diagVersion(): string {
  try {
    return chrome.runtime.getManifest().version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 面板对外暴露的动作（由入口 `content-panel.content.ts` 提供实现）。
 *
 * ⚠️ 2026-11-10 加了 `logout` —— 迁移时漏了这个按钮，
 * 用户配置好后账号 Tab 一个操作都没有（真机发现的功能缺失）。
 */
export interface PanelActions {
  /** 打开扫码窗口 */
  login: () => void;
  /** 退出播放账号。**UI 已过两步确认**，这里直接发请求 */
  logout: () => Promise<{ ok: boolean; detail?: string }>;
  /**
   * ── 取流身份（2026-11-11，步骤 4）──
   *
   * ## 为什么放在 `PanelActions` 而不是 `PanelModel`
   *
   * 它是**纯配置读取**（`storage.local` 一次 `.get()`），不是"页面数据"。
   * 放进 `PanelModel` 会让那个模型多一个与当前页面无关的字段，
   * 而 `PanelModel` 的职责是"这一页采集到了什么"。
   *
   * ## 与 `AccountActions` 的关系
   *
   * 这两个字段**原样透传**给 `accountTab()`（见 `:557` 附近的调用）。
   * 两边形状一致不是为了省事，是为了让"面板层不加工身份数据"这件事在类型上可见 ——
   * 面板只负责搬运，判据在 `popup-state.ts` / `streaming-pill.ts`。
   */
  /** 当前取流身份；`null` = 还没读出来（胶囊不渲染） */
  streamingIdentity: StreamingIdentity | null;
  /** 切换取流身份。失败时由实现方自己弹提示，这里不返回 Promise */
  toggleStreamingIdentity: (next: StreamingIdentity) => void;

  /**
   * ── 重取模型时用的**取流身份**（2026-11-12，task-3 修 B-1/B-2/B-3）──
   *
   * ## 为什么不能复用 `streamingIdentity`
   *
   * 那个字段是**挂载那一刻**的初值（见上面 `panel.ts` 里本地镜像的注释）。
   * 用户点过胶囊之后它就过期了，而 `refreshModel()` 在任何写操作之后都会跑
   * （总开关 / 净化开关 / 退出）。拿一份过期初值去重取，就是
   * 「切了身份，一拨开关就显示错」—— 取证 B.4 的原样复发。
   *
   * ## 为什么不硬编码 `'extension'`
   *
   * `loadPanelModel()` 的 `streamingIdentity` 三态语义里，`undefined` 与
   * `'extension'` **不等价**：
   *   - `undefined` → `panel-data.ts` 的 `streamingIdentity ?? 'extension'`
   *     会用 `'extension'` 算 `configured`，同时**不透传**给 `describePopup()`
   *   - `'extension'` → 同上算 `configured`，但**会透传**，画质 Tab 说真话
   *
   * 而 `'page'` 身份下缺省成 `'extension'` 会让 `isStreamingReady()` 得 `false`
   * → 把一个**完全可用**的配置报成「还没有配置取流账号」。
   *
   * 所以这里必须拿到**当前的真实身份**，与 `loadOnce()` 同口径 ——
   * 唯一真相源是 `content-panel.content.ts` 的 `streamingIdentityCache`，
   * 由实现方经闭包传入（**不是**面板自己读）。
   *
   * 返回 `undefined` = 还没读到 → 走 `loadPanelModel()` 的既有判据
   * （与"缺省 = 调用方没给"那条纪律一致，见 `panel-data.ts` 的注释）。
   */
  currentStreamingIdentity: () => StreamingIdentity | null | undefined;

  /**
   * ── 首页推荐流开关（2026-11-11，**与上面两项完全独立**）──
   *
   * 用户原话：「首页推荐流的变化与取流身份是完全独立的两个功能」。
   *
   * ## ⚠️ 类型里**没有** `StreamingIdentity` —— 这是有意的
   *
   * 与 `feed-hide.ts` 同一手法：谁想在推荐流开关的判据里用取流身份，
   * 必须先改这个签名，而改签名会让调用点报错 → **不可能静默发生**。
   *
   * ## 它读的是 `storage.local` 的 `pluma:feed-account-enabled`
   *
   * 与 `streaming/status` 消息**无关**：那个消息回答"谁在取流"，
   * 本开关回答"推荐流用谁" —— 两个问题各有各的数据源。
   */
  feedAccountEnabled: boolean;
  /** 拨推荐流开关。失败时由实现方自己弹提示 */
  toggleFeedAccount: (next: boolean) => void;
}

/**
 * 成功类提示的存活时间。
 *
 * 5 秒：够读一句"扫码窗口已打开"，又不会让面板底部长期占一块。
 * ⚠️ **失败类不自动消失** —— 见 `PanelController.showNotice` 的注释。
 */
const NOTICE_TTL_MS = 5000;

/**
 * 换集后**补救取数**的延迟（毫秒）—— 单次 `setTimeout`，**不是轮询**。
 *
 * ## 这个数字怎么来的（2026-11-20 真机 6 轮换集实测）
 *
 * | 事件 | `pushState` 之后的时刻 |
 * | --- | --- |
 * | `resetLoadingTrace()` | 28.0 – 49.2ms |
 * | 新集首波 `.m4s` | **577.1 – 848.1ms** |
 *
 * 也就是说从 reset 到"真的有事可看"之间恒有 532.5–798.9ms 的空窗。
 * 通知到达面板时第一次重取几乎必然落在这个空窗里（只看到 playurl 那两行），
 * 所以要在空窗**之后**再补一次。
 *
 * 取值 1200ms：比实测最大的 848.1ms 还留 ~350ms 给一次消息往返与
 * `PerformanceObserver` 的回调滞后（实测 `seg-req` 入账滞后 72.5–292.9ms）。
 *
 * ⚠️ **不许**改成"每 N 毫秒再看一次" —— 项目硬纪律：无常驻定时器，
 * 曾因此出现过挂后台白屏。这里只在换集这一个事件之后排**一次**。
 */
const LOADING_CHANGED_RETRY_MS = 1200;

/**
 * ── 退出 / 取数失败时用户必须看到的那几句话（2026-11-12，task-3）──
 *
 * ## 为什么是常量
 *
 * 这几句是**裁决文件钉死的**（权威顺序：裁决文件 > 任务卡 > 聊天消息）。
 * 抽成常量后，测试断言"界面上的文字 === 这个常量"，
 * 实现改一个字就会红 —— 这是"文案也是契约"在代码里的落点。
 *
 * ## 为什么定义在 `panel.ts` 而不是 `tabs.ts`
 *
 * `tabs.ts` 是纯 DOM 层（不 import 编排层），而这三句里有两条的
 * **结局判定**（"成功但刷新失败"）在入口层才有。放在编排层：
 * `tabs.ts` 经 `PanelActions` 的 `notifyResult` 接收结果，
 * 入口（`content-panel.content.ts`）也从这里 import 文案 —— 一处定义、两处使用。
 *
 * ⚠️ 说法必须是「浏览器当前账号」，不是「主账号」「主浏览器账号」：
 * 用户能读懂前者；后者是内部术语（裁决 1 第 2 条）。也不许出现「凭据」「配置」。
 */

/** 退出**成功**：用户必须当场看到这句 */
export const NOTICE_LOGOUT_OK = '已退出取流账号，取流回退到浏览器当前账号';

/**
 * 退出**成功**了，但退出后的界面刷新（`loadOnce()`）失败。
 *
 * 用户此时面板上还画着旧账号卡片 —— 不说清楚，他就分不清
 * 是"退出没生效"还是"界面没刷新"。这句同时给出**唯一真能做的动作**。
 */
export const NOTICE_LOGOUT_REFRESH_FAILED = '已退出，但界面刷新失败 —— 收起重开面板可刷新';

/**
 * 任意一次面板取数失败（`loadOnce()` 抛错）时的那句话。
 *
 * ⚠️ **不归因**：面板拿不到"是哪一步坏了"（消息没应答 / 并发一条失败 / 解析抛错），
 * 编原因就是陈述错误事实。只说"这次没取到"，并给出用户能做的动作。
 */
export const NOTICE_LOAD_FAILED = '界面数据刷新失败 —— 收起重开面板可重试';

/**
 * 退出结果 → 该显示什么（**纯函数**）。
 *
 * 把"报哪一句、用什么色"从 `tabs.ts` 的 DOM 回调里拆出来，
 * 这样三种结局的文案都**可单测**。
 *
 * ⚠️ 账号 Tab 只知道前两种（它拿不到 `loadOnce()` 的结局）；
 * 「成功但刷新失败」由入口在重取失败时**覆盖**。
 */
export function describeLogoutNotice(result: { ok: boolean; detail?: string }): {
  text: string;
  ok: boolean;
} {
  if (result.ok) return { text: NOTICE_LOGOUT_OK, ok: true };
  return { text: `退出失败：${result.detail ?? '未知原因'}`, ok: false };
}

export function mountPanelBody(actions: PanelActions): PanelController {
  const root = el('div', 'panel-body');

  /** 当前成功提示的自动清除定时器；`null` = 没有 */
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const nav = el('nav', 'tabs');
  const tabButtons = new Map<PanelTab, HTMLElement>();
  for (const t of PANEL_TABS) {
    const b = el('button', 'tab', TAB_LABEL[t]);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      showTab(t);
    });
    tabButtons.set(t, b);
    nav.appendChild(b);
  }
  root.appendChild(nav);

  /** 内容区：每次重画都整个替换（结构简单，比 diff 可靠） */
  const content = el('div', 'panel-content');
  root.appendChild(content);

  let tab: PanelTab = 'quality';
  let stack: PanelLevel = [];
  let model: PanelModel | null = null;

  /**
   * 角标开关（阶段 3）。
   *
   * `null` = 还没读出来 → 开关禁用，**不画成"关"**。
   * 与净化偏好同一纪律：把"未知"画成"关"，用户会以为功能自己关掉了。
   */
  let badgeEnabled: boolean | null = null;

  /**
   * 屏蔽 PCDN 开关（ADR 0038）。
   *
   * 与角标开关同一套纪律：`null` = 还没读出来 → 禁用，**不画成"关"**。
   * 单独一份状态、单独的读失败闸 —— 两个开关的读取互相独立，
   * 一个读不到不该把另一个也拖成灰的。
   */
  let pcdnFilterEnabled: boolean | null = null;
  /** 有一次读取在飞（挡住并发） */
  let pcdnFilterReading = false;
  /**
   * 读失败过（挡住自动重试）。
   *
   * 与 `badgeReadFailed` 同一理由：失败时 `pcdnFilterEnabled` 仍是 `null`，
   * 若没有这条闸，`render()` 会再触发读 → 再失败 → 再 `render()`，无限递归。
   * 重试口同样由用户动作提供（进一次「显示」Tab）。
   */
  let pcdnFilterReadFailed = false;

  /**
   * 诊断数据（阶段 3）。**懒加载**：只有进入诊断浮层时才去 `collectFacts()`。
   *
   * 理由：`collectFacts()` 要发多次 chrome API 调用（窗口 / cookie / DNR / manifest…），
   * 面板每次展开都跑一遍是浪费。诊断是排查时才看的东西。
   */
  let diagData: {
    rows: readonly DiagRow[];
    logs: readonly DiagEntry[];
    /**
     * 这一次**读日志这件事本身**成没成（2026-11-12，task-26）。
     *
     * ## 为什么不由 `logs.length` 推
     *
     * `readDiag()` 内部是 `catch { return [] }` —— 读失败与"真的一条都没有"
     * 返回同一个 `[]`。用 `length > 0` 推 `ok` 的话，**孤儿态会被推成"没有日志"**，
     * 而这正是用户两次导出 `"logs": []` 却以为"没记录"的原因。
     *
     * ## 那怎么拿到这个"成没成"：在调用点做一次**存活探针**
     *
     * 两条路都不行：
     * - 改 `readDiag()` 的返回值 → **越权**（本卡硬边界），且"读不到就给空数组"
     *   被别处依赖
     * - 在本文件自己把环形缓冲的读取逻辑写一遍 → 复制读取口径，
     *   违背 `diagnostics.ts` 文件头"读取口径只有一处"
     *
     * ⇒ 用第三条：`readDiag()` 照原样调（口径仍只有一处），另外单独做一次
     * `chrome.storage.local.get(null)` **只判断它抛不抛错**，返回值直接丢弃。
     * 它不解释数据、不过滤，所以没有复制任何口径 —— 只是一次
     * "存储还活着吗"的存活探针，而这正是被 `readDiag()` 吞掉的唯一信息。
     */
    logsMeta: LogsMeta;
  } | null = null;
  /** 定位追踪（`pluma:diag-trace`）。`null` = 还没有记录 */
  let diagTrace: { at: number; step: string; detail: string; from: string } | null = null;
  /**
   * `diag/facts` 应答里的调试回显（**不经 storage**，2026-11-10 第八轮）。
   * `null` = 还没有 / 老版本 background。
   */
  let diagEcho: string | null = null;
  let diagLoading = false;

  /**
   * 加载快照是否**有一次读取在飞**（T5）。
   *
   * 与 `diagLoading` 同一个用途：⟳ 可以被连点，重复发没有收益。
   * 区别是它不驱动"正在采集…"那种整屏状态 ——
   * 浮层里保留上一次的数据比换成一句"正在读取…"更有用（用户正在对照那一屏）。
   */
  let loadingRefreshing = false;

  /**
   * 探一次"存储还能不能碰"，产出 `logsMeta` 里除 `count` 之外的字段。
   *
   * ## 为什么是 `chrome.storage.local.get(null)`
   *
   * `readDiag()` 读的就是它。孤儿态下 `chrome.storage` 整个不可用
   * （抛 `Extension context invalidated`），这是**唯一与日志读取同路**的存活信号。
   *
   * ⚠️ 返回值丢弃 —— 本函数**不读数据、不解释数据**，只问"抛不抛"。
   * 因此它没有复制"读取口径"（那条在 `diagnostics.ts` 文件头）。
   *
   * @param failure 采集**整体失败**时的原因（`loadDiag` 的 catch 分支传）；
   *                正常路径不传，靠探针自己判断
   */
  const probeLogsReadability = async (failure?: unknown): Promise<Omit<LogsMeta, 'count'>> => {
    const base = { instanceId: instanceId(), readAt: Date.now(), limit: DIAG_LIMIT };
    /**
     * 采集整体失败 = 日志**不可能**读到（连第一个 await 都炸了），直接如实报失败。
     * 不去探针，是因为此时 `chrome.storage` 可能都不存在，探针本身的异常
     * 不代表日志通道的原因（真正的原因在 `failure` 里）。
     */
    if (failure !== undefined) {
      return { ...base, ok: false, err: describeLogsError(failure) };
    }
    try {
      await chrome.storage.local.get(null);
      return { ...base, ok: true, err: null };
    } catch (error) {
      return { ...base, ok: false, err: describeLogsError(error) };
    }
  };

  /**
   * 读角标开关的结局：`null` = 还没读到，`'unreadable'` = **读失败**。
   *
   * ## 为什么需要三态（2026-11-12，task-5 静默点 2）
   *
   * 旧实现只有 `badgeEnabled: boolean | null`：`null` 同时表示
   * "还没读"和"读失败"。而渲染层拿不到区分 → 开关**永久灰着**，
   * 面板上**没有任何一句话说明为什么**。
   *
   * 用户看到的是一个点不动的开关，不知道是"加载中"还是"坏了"——
   * 这正是「点了没反应」里最难排查的一类：**控件既然不可点，就永远
   * 不会产生"点击"，用户连抱怨的入口都没有**。
   */
  let badgeReadFailed = false;

  /**
   * 是否已经有一次读取**在飞**。
   *
   * ## ⚠️ 没有它就是无限递归（2026-11-12，task-5 实测踩到）
   *
   * 失败分支会 `render()`，而 `render()` 在 `display` Tab 里会再调
   * `ensureBadgeRead()` —— 此时 `badgeEnabled` **仍然是 `null`**（我们刻意不猜成
   * `false`），于是早退不命中 → 再发一次请求 → 再失败 → 再 render() →
   * **无限同步递归**，整个面板卡死（单测表现为整份文件挂住、一行都不出）。
   *
   * 早退条件 `badgeEnabled !== null` 只能挡住"读成功之后"，挡不住"读失败之后"。
   *
   * ⚠️ 它**不会**让一次失败永久锁死：请求结束时复位为 `false`，
   * 用户下次进这个 Tab（`showTab` → `render` → `ensureBadgeRead`）会重试。
   */
  let badgeReading = false;

  /**
   * 读一次角标开关（进入净化 Tab 或重画前用）。
   *
   * ## ⚠️ 三重早退，缺一个就是死循环（2026-11-12，task-5 实测踩到）
   *
   * `render()` 在 `display` Tab 里**每次**都会调本函数。而本函数的 `.finally`
   * 又调 `render()` —— 两者构成一个环。只要有一条路径能让"读"重新发起，
   * 就是无限同步递归：整个面板卡死（单测表现：整份文件挂住、一行都不出）。
   *
   * | 早退条件 | 挡住的场景 |
   * | --- | --- |
   * | `badgeEnabled !== null` | 已读到真实值 → 不必再读 |
   * | `badgeReading` | 已有一次在飞 → 不并发 |
   * | **`badgeReadFailed`** | **已失败过 → 不再自动重试**（关键的一条） |
   *
   * 第三条不能省：失败时 `badgeEnabled` 仍是 `null`（刻意不猜成 `false`），
   * 前两条都不命中 → `render()` 会再次触发读 → 再失败 → 再 `render()`。
   *
   * ## 那失败之后怎么重试
   *
   * 由**用户动作**驱动，而不是自动：`showTab('display')` 时把
   * `badgeReadFailed` 复位（见 `showTab`），于是"再进一次这个 Tab"就是重试。
   * 这比自动重试更合适 —— 失败多半是 storage/SW 暂时不可用，
   * 高频自旋只会烧 CPU，而用户重新点一下 Tab 是零成本的明确重试意愿。
   */
  const ensureBadgeRead = (): void => {
    if (badgeEnabled !== null || badgeReading || badgeReadFailed) return;
    badgeReading = true;
    void readBadgeEnabled()
      .then((v) => {
        badgeEnabled = v;
        badgeReadFailed = false;
      })
      .catch(() => {
        /**
         * ## 读不到**不能只留一个灰开关**（2026-11-12，task-5 静默点 2）
         *
         * 旧实现这里是空 `catch`（注释写"读不到就保持禁用，不画成关"）——
         * 保持禁用是对的，但**不解释就是静默失败**。
         *
         * 现在：记下"读失败"这个结局，让渲染层能画一句原因；
         * 同时**仍然**保持 `badgeEnabled === null`（不猜成 `false`，
         * 那会让用户以为角标被自己关掉了）。
         */
        badgeReadFailed = true;
      })
      .finally(() => {
        /**
         * ⚠️ 复位 `badgeReading` 之后 `render()` 不会复发 ——
         * 因为失败路径上 `badgeReadFailed` 已是 `true`，第三条早退命中。
         * （若把那条早退删掉，这里就会无限递归。）
         */
        badgeReading = false;
        render();
      });
  };

  /** 角标开关写入：不需要面板做别的，`content.ts` 监听 `onChanged` 自己重画 */
  const writeBadge = async (next: boolean): Promise<void> => {
    const prev = badgeEnabled;
    badgeEnabled = next; // 乐观更新：开关要跟手（开关类控件必须 300ms 内有反应）
    render();
    try {
      await writeBadgeEnabled(next);
    } catch {
      badgeEnabled = prev;
      render();
      /**
       * ## 写入失败也要说（2026-11-12，task-5）
       *
       * 旧实现只回滚、**一句话都没有**。用户看到开关自己弹回去，
       * 不知道是"点错了"还是"没保存上"。
       *
       * 回滚 + 说明才是完整的：回滚保证界面不撒谎，说明让用户知道发生了什么。
       */
      showNotice('页内角标没保存成功 —— 稍后再拨一次', false);
    }
  };

  /**
   * 屏蔽 PCDN：懒读 + 三重早退（与 `ensureBadgeRead` 同构，理由不再复述一遍）。
   *
   * ⚠️ **必须是独立的一组状态**，不能复用角标那三个变量：
   * 两个开关的读取是两次独立的 storage 往返，共用闸会出现"角标读成功
   * 顺手把 PCDN 的失败标记清掉"这种串味，排查时极难看出来。
   */
  const ensurePcdnFilterRead = (): void => {
    if (pcdnFilterEnabled !== null || pcdnFilterReading || pcdnFilterReadFailed) return;
    pcdnFilterReading = true;
    void readPcdnFilterEnabled()
      .then((v) => {
        pcdnFilterEnabled = v;
        pcdnFilterReadFailed = false;
      })
      .catch(() => {
        // 读不到**不猜成 false** —— 那会让用户以为自己把这个开关关了
        pcdnFilterReadFailed = true;
      })
      .finally(() => {
        pcdnFilterReading = false;
        render();
      });
  };

  /** 屏蔽 PCDN：写入（乐观更新 + 失败回滚 + 说明，同 `writeBadge`） */
  const writePcdnFilter = async (next: boolean): Promise<void> => {
    const prev = pcdnFilterEnabled;
    pcdnFilterEnabled = next;
    render();
    try {
      await writePcdnFilterEnabled(next);
      render();
    } catch {
      pcdnFilterEnabled = prev;
      render();
      showNotice('屏蔽 PCDN 没保存成功 —— 稍后再拨一次', false);
    }
  };

  /**
   * ## ❌ 这里曾有 `feedBoundaryEnabled` 状态 + 读写函数（2026-11-11 删除）
   *
   * 它服务于「显示推荐来源分界线」开关。**分界线功能整体取消**：
   *
   * 1. 用户裁决：设完取流账号后直接隐藏 `.feed-card`，首屏就是取流账号的，线没有意义
   * 2. 而隐藏方案也因**选择器（父子嵌套）与身份（M1）两层都未验证**而冻结
   *
   * 面板里那个开关、它的懒读、它的乐观更新全部删除。
   */

  /**
   * ── 取流身份（2026-11-11，步骤 4）──
   *
   * ## 为什么由 `actions` 提供初值，而不是面板自己读
   *
   * `streamingIdentity` 的来源是 **`streaming/status` 消息**（background 是唯一
   * 知道"用户选了谁"的地方 —— 它同时管着规则重建）。面板是纯 DOM 层，
   * 不该自己去读 `storage.local` 再判断。
   *
   * ## 为什么还要在面板里存一份可变副本
   *
   * `actions.streamingIdentity` 是**挂载那一刻**的初值。用户点了胶囊之后，
   * 面板必须立刻重画（乐观更新），否则会有"点了没反应"的观感。
   * 所以这里镜像一份，`render()` 用这份；`actions` 只作为初值来源。
   *
   * ⚠️ 两者**同源不同步**是有意的：面板不负责感知"别处改了身份"，
   * 那是 `streaming/set` 的实现方（content 入口）在成功后回调刷新的职责。
   */
  let streamingIdentity: StreamingIdentity | null = actions.streamingIdentity;

  /**
   * 点胶囊切换。
   *
   * 采用与 `writeFeedBoundary` **同款**的乐观更新 + 失败回滚：
   * 先本地切、立刻重画；调用方失败时回滚。
   * "点了没反应"是最糟的反馈，而身份切换通常 <100ms，乐观更新完全值得。
   */
  const toggleStreamingIdentity = async (next: StreamingIdentity): Promise<void> => {
    const prev = streamingIdentity;
    streamingIdentity = next;
    render();
    try {
      await actions.toggleStreamingIdentity(next);
    } catch {
      streamingIdentity = prev;
      render();
    }
  };

  /**
   * ── 首页推荐流开关的本地副本（2026-11-11）──
   *
   * ## ⚠️ 它与 `streamingIdentity` 是**两件独立的事**
   *
   * 用户原话：「首页推荐流的变化与取流身份是完全独立的两个功能」。
   *
   * 所以本状态**不从 `streamingIdentity` 派生**，也不在它变化时重置。
   * 两者各自乐观更新、各自回滚。
   *
   * 同理采用乐观更新：开关要跟手，"点了没反应"是最糟的反馈。
   */
  let feedAccountEnabled = actions.feedAccountEnabled;

  const toggleFeedAccount = async (next: boolean): Promise<void> => {
    const prev = feedAccountEnabled;
    feedAccountEnabled = next;
    render();
    try {
      await actions.toggleFeedAccount(next);
    } catch {
      feedAccountEnabled = prev;
      render();
      /**
       * ## ⚠️ 这个 `catch` 实际上**几乎不会进入**（2026-11-12，task-5 发现）
       *
       * `PanelActions.toggleFeedAccount` 的签名是 `(next: boolean) => void`，
       * 所以 `await` 拿到的是 `undefined` —— 实现方的失败**抛不到这里**。
       *
       * 于是「开关失败时既不回滚也不提示」的真实修法在**实现方**：
       * `content-panel.content.ts` 的 `setFeedAccount()` 失败时自己
       * `showNotice(...)`（已修，见那里）。
       *
       * 这里保留 catch + 回滚 + 提示，是为了将来签名改成返回 Promise 时
       * 行为**已经是对的**（防御性冗余，不是死代码——签名一变它立刻生效）。
       */
      showNotice('首页推荐流开关没保存成功 —— 稍后再拨一次', false);
    }
  };

  /**
   * 拉诊断数据。
   *
   * ## ⚠️ 每次进入诊断浮层都**重新**拉（2026-11-10 第七轮修）
   *
   * 原来是 `if (diagData !== null) return;` —— **只在首次创建时拉一次**。
   * smoke 实测：第二次进入诊断浮层（隔 6 秒）**没有任何新增的 `diag/facts` 日志**，
   * 说明它根本没重新取数。
   *
   * 后果：**一次失败后永远显示旧结果**。用户点「重试」或来回切换都看不到变化 ——
   * 而诊断工具最需要的就是"现在这一刻是什么样"。
   *
   * 现在：每次都重新拉，只保留 **in-flight 去重**（同一次进入不重复发）。
   */
  const loadDiag = (): void => {
    if (diagLoading) return; // 正在拉，不重复发起
    diagLoading = true;
    void (async () => {
      try {
        /**
         * ⚠️ 传 **`model` 里的当前页数据**，不是 `undefined`。
         *
         * 面板自己就在当前页面里，`collectFacts()` 默认会 `chrome.tabs.query`
         * 去找**别的**视频标签页 —— 那会让诊断页显示另一页的数据，
         * 或者在首页显示"打开任意视频页后可见"。
         *
         * 见 `CollectOptions` 的注释。`null` 与 `undefined` 语义不同：
         * 传 `null` = "本页就是没有"，不会被当成"没传"。
         */
        const rows = await collectFacts({ pageView: model?.pageView ?? null });
        /**
         * ⚠️ **探针必须在 `readDiag()` 之前**：后者会吞掉异常，
         * 之后就没有任何线索能判断"这次到底读到没有"了。见 `diagData` 的注释。
         */
        const logsMeta = { ...(await probeLogsReadability()), count: 0 };
        const logs = await readDiag();
        diagData = { rows, logs, logsMeta: { ...logsMeta, count: logs.length } };
        /**
         * ## echo：绕开 storage 的调试回显（2026-11-10 第八轮）
         *
         * `collectFacts()` 内部发给 background 的 `diag/facts` 应答里带 `echo`，
         * 它被存在 `collect.ts` 的模块级变量中（**不经任何存储**）。
         *
         * 前七轮所有"写 storage 再看"的通道都失败了 —— 而消息应答从没丢过。
         * 所以这是唯一可靠的一路。
         *
         * ⚠️ 必须在 `collectFacts()` **之后**读，否则拿到的是上一次的。
         */
        diagEcho = readLastDiagEcho();
        /**
         * 另外也读一次 `readDiagTrace()`（第七轮加的 storage 通道）。
         * 它在真机上可能写不进去，但**成本为零**（一次 local.get），
         * 写进去了就是额外收益。
         */
        diagTrace = await readDiagTrace();
      } catch (error) {
        /**
         * 采集整体失败 —— 日志也**一定**读不到。`logsMeta` 必须如实 `ok: false`，
         * 否则导出里会出现"facts 全空 + logs 空数组 + ok: true"这种自相矛盾的包，
         * 而那正是这次要消灭的"假正常"。
         */
        diagData = {
          rows: [],
          logs: [],
          logsMeta: { ...(await probeLogsReadability(error)), count: 0 },
        };
        diagTrace = null;
        diagEcho = null;
        /**
         * ## 采集失败**不能只交一张空表**（2026-11-12，task-5 静默点 4）
         *
         * 旧实现 catch 里只 `diagData = { rows: [], logs: [] }` —— 于是诊断页
         * 渲染出**一张空表**，用户以为"这台机器什么都没有"，而实际是**采集挂了**。
         *
         * 诊断工具的全部价值就是"现在这一刻是什么样"，把失败渲染成"没有数据"
         * 比不显示更糟：它会让人以为问题已经解决了（那句注释自己写过这一点，
         * 只是漏在失败分支上）。
         *
         * 这里加一条提示说清"采集失败"，与表格的空态区分开。
         * ⚠️ 走同一个 `showNotice` 通道，不另造第二套提示机制。
         */
        showNotice('诊断信息采集失败 —— 点浮层里的「刷新」再试一次', false);
      } finally {
        diagLoading = false;
        render();
      }
    })();
  };

  /**
   * 端口把 `pageView` 从模型里取出来喂给 `collectFacts()` —— 见 `PanelModel.pageView`。
   *
   * ⚠️ `?? null` 不是多余：`model` 可能还是 `null`（首屏没取到），
   * 那时也必须传 `null` 而不是 `undefined`（后者会让 collectFacts 去查标签页）。
   */

  /**
   * 净化开关写入。
   *
   * ## ⚠️ 刻意**没有**乐观更新（2026-11-12，task-5）
   *
   * 这是读—改—写：先 `readRawCleanOptions()` 拿**最新的整块**偏好，
   * 改一个键，再整块写回。理由在下面那段注释里（别的标签页可能刚改过）。
   *
   * 正因为它先把真实值读回来，**乐观更新反而会撒谎**：
   * 如果读失败、我们却先把开关翻过去，用户会看到一个 storage 里**不存在**的状态。
   * 所以本轮**只加失败可见，不加乐观**（Lead 明确要求）。
   *
   * ## 旧实现为什么是"点了没反应"（静默点 3）
   *
   * 旧写法里 `await readRawCleanOptions()` / `writeCleanOptionFlags()` 抛错时，
   * 异常一路冒泡到 `render()` 之外 —— 于是：
   *   - `refreshModel()` **不会跑** → 开关**视觉不动**
   *   - 面板上**一个字都没有**
   *
   * 用户看到的就是"点了一下，什么也没发生"。
   */
  const writeOption = async (key: CleanOptionKey, next: boolean): Promise<void> => {
    /**
     * ## 必须**重新读**，不能复用 `model.clean`
     *
     * `model` 是上一次取数的快照。用户可能刚在别的标签页的设置页里改过，
     * 也可能这中间 `storage.onChanged` 又触发了一次。
     * 用旧快照做"改一个键"，写回去的就是**过期数据** —— 那是"读—改—写"的经典错误。
     */
    try {
      const fresh = normalizeCleanPreferences(await readRawCleanOptions());
      const updated = patchCleanOption(fresh.options, key, next);

      await writeCleanOptionFlags(updated);
      applyCleanNow();
      await refreshModel();
    } catch {
      /**
       * 失败：开关**拉回模型里的值**（模型没变，所以就是原值），
       * 再把原因说给用户听。
       *
       * ## 为什么必须 `render()`
       *
       * 净化开关**没有乐观更新**，但用户点的那一下已经把 checkbox 翻过去了
       * （那是浏览器对 checkbox 的默认行为）。不重画的话，界面就停在
       * **一个 storage 里并不存在的值**上 —— 正是"不加乐观更新"要防的事。
       *
       * ⚠️ 成功路径不用在这里 `render()`：`refreshModel()` 会重取并重画。
       */
      render();
      showNotice('净化设置没保存成功 —— 稍后再点一次', false);
    }
  };

  /**
   * 分类切换：同样是读—改—写，但写的是另一半（`hideCategories`）。
   *
   * 失败处理与 `writeOption` 完全同理（见上面那段注释）。
   */
  const writeCategory = async (cat: string, next: boolean): Promise<void> => {
    try {
      const fresh = normalizeCleanPreferences(await readRawCleanOptions());
      const cats = toggleHideCategory(fresh.hideCategories, cat, next);

      await writeCleanHideCategories(cats);
      applyCleanNow();
      await refreshModel();
    } catch {
      // 同理：分类开关也要拉回模型里的值（见 `writeOption` 的注释）
      render();
      showNotice('净化分类设置没保存成功 —— 稍后再点一次', false);
    }
  };

  /**
   * 总开关：走 background 消息（与 popup 同一条通道，不新增消息类型）。
   *
   * ## 🔴 这是扩展最核心的开关，旧实现失败时**一个字都没有**（2026-11-12，task-5）
   *
   * 旧写法 `await sendMessage(...).catch(() => null)` 之后直接 `refreshModel()`：
   *
   * | 失败方式 | 用户看到 |
   * | --- | --- |
   * | 消息抛错（SW 挂了 / 上下文失效） | `.catch(() => null)` 吞掉 → 开关**视觉不动**，无文字 |
   * | 应答是失败 type | 完全没检查 → 同上 |
   *
   * 两种都表现为「点了没反应」——而这是用户最常拨的那个开关。
   *
   * ## ⚠️ 不加乐观更新（刻意）
   *
   * 总开关的状态来自 `proxy/status`（background 是唯一真相源），`refreshModel()`
   * 读回真实值才算数。先乐观翻转再失败回滚，会出现「开关闪一下又弹回去」——
   * 那比"点了没反应"更容易让用户以为点坏了。
   *
   * 所以这里只做两件事：**检查应答类型** + **失败时说清**。
   * 成功路径保持原样（`refreshModel` 读回真实值重画）。
   */
  const toggleProxy = async (next: boolean): Promise<void> => {
    const res = (await chrome.runtime
      .sendMessage({ type: 'proxy/set', enabled: next })
      .catch(() => null)) as { type?: string } | null;

    /**
     * 失败判据：没有应答，或应答 type 不是 `proxy/set:ok`。
     *
     * ⚠️ 不编原因 —— 面板拿不到"是 SW 没醒还是权限问题"。
     * 但必须让用户知道**这次没生效**，并且有一个真能做的动作。
     */
    if (res?.type !== 'proxy/set:ok') {
      showNotice('总开关没切换成功 —— 稍后再点一次，或刷新页面试试', false);
    }

    // 无论成败都重取：成功要读回真实值；失败要确认开关停在真实状态
    await refreshModel();
  };

  /**
   * **主动应用**刚写下的净化偏好。
   *
   * 两个都必须调：
   *   - `applyAdClean()` 管广告（body 类名 + 元素标记）
   *   - `applyHomeClean()` 管首页分类与顶部大图（生成 CSS）
   *
   * 只调 storage 事件是不够的：`content-home.content.ts` 的监听器虽然存在，
   * 但面板与它**是两个 content script 实例**，事件传播依赖浏览器时序；
   * 而"我刚点的开关没有立刻生效"是用户最不能接受的失败。
   */
  const applyCleanNow = (): void => {
    void readRawCleanOptions()
      .then((raw) => {
        const prefs = normalizeCleanPreferences(raw);
        applyAdClean(prefs.options, document);
        applyHomeClean(prefs, document);
      })
      .catch(() => {
        /* 应用失败不阻塞 UI 更新：偏好已经写进 storage，刷新后仍会生效 */
      });
  };

  /**
   * 重取一次模型并重画。
   *
   * ## ⚠️ 必须透传**当前**取流身份（2026-11-12，task-3 修 B-1/B-2/B-3）
   *
   * 旧实现**不传** `streamingIdentity`，于是：
   *   - `panel-data.ts` 的 `streamingIdentity ?? 'extension'` 拿 `'extension'` 算
   *     `configured` → `page` 身份（`hasCredential === false`）被判成「未配置」
   *   - `panel-data.ts` 的透传条件 `streamingIdentity !== undefined` 为假 →
   *     `describePopup()` 里 `if (snap.streamingIdentity === 'page')` 永不触发 →
   *     画质 Tab 说「已接管」而 `page` 模式下**什么都没换 Cookie**（假话）
   *
   * 触发时机：`toggleProxy` / `writeOption` / `writeCategory` 之后都会调这里，
   * 即「用户拨一下开关，身份判据就退回缺省」。
   *
   * ⚠️ 值必须来自 `actions.currentStreamingIdentity()`（实现在入口文件里，
   * 读 `streamingIdentityCache`），**不许在这里写死 `'extension'` / `'page'`** ——
   * 那只是把"缺省"换成一个看起来更具体的错值。
   */
  const refreshModel = async (): Promise<void> => {
    /**
     * `currentStreamingIdentity()` 可能返回 `undefined`（还没读到），
     * 而 `loadPanelModel()` 在 `exactOptionalPropertyTypes` 下**不接受**
     * 显式 `undefined`。两者语义相同（都是"调用方没给"），
     * 所以这里用条件展开把它换回"字段缺席"的形状。
     */
    const identity = actions.currentStreamingIdentity();
    const next = await loadPanelModel({
      pageKind: model?.pageKind ?? 'other',
      primary: model?.account.primary ?? {
        uname: null,
        level: null,
        loggedIn: 'unknown',
        source: 'none',
      },
      ...(identity !== undefined ? { streamingIdentity: identity } : {}),
    });
    model = next;
    render();
  };

  /**
   * 在面板底部显示一条提示（登录 / 退出的结果）。
   *
   * ## 为什么需要它（2026-11-10）
   *
   * 旧实现所有消息都是 `.catch(() => null)` —— **失败完全静默**。
   * 用户点「扫码登录」后什么也没发生，无法判断是没开 InPrivate 权限、
   * 网络问题、还是按钮坏了。
   *
   * ## 自动消失：成功 5 秒，**失败不消失**
   *
   * | 类型 | 自动清除 | 为什么 |
   * | --- | --- | --- |
   * | 成功 / 中性（`ok: true`） | ✅ 5 秒 | 用户看一眼就够，留着占地方 |
   * | **失败（`ok: false`）** | ❌ **常驻** | 用户可能正在读、或已经去开权限了 —— 回来时提示还在 |
   *
   * 失败常驻的代价是"要占一块地方"，但它带来的是**用户不会错过原因**。
   * 下一次 `showNotice` 会替换掉它，所以不会无限堆积。
   *
   * ⚠️ 不放在 `content` 里 —— 那个容器每次 `render()` 都会 `replaceChildren`，
   * 提示会跟着消失。放在 `root` 末尾，跨越整棵子树存活。
   *
   * ## 为什么是具名函数而不是返回对象里的方法（2026-11-12）
   *
   * `render()` 内部要把**退出结果**也交给这条通道（`accountTab` 的
   * `notifyResult`），而 `render()` 定义在返回对象**之前** ——
   * 那时方法还不存在。提升成具名函数后两处共用同一份实现，
   * 而不是在 `render` 里复制一段。
   *
   * @param text 提示文案
   * @param ok   `true` 中性/成功色，`false` 危险色
   */
  function showNotice(text: string, ok: boolean): void {
    let bar = root.querySelector('.panel-notice');
    if (!bar) {
      bar = el('p', 'panel-notice');
      root.appendChild(bar);
    }
    bar.textContent = text;
    bar.classList.toggle('danger', !ok);

    // 清掉上一条的定时器 —— 否则新的成功提示会被旧的定时器提前抹掉
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }

    if (ok) {
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        // 只在它还是**这一条**时移除（期间可能被新提示替换过）
        if (bar.textContent === text) bar.remove();
      }, NOTICE_TTL_MS);
    }
  }

  /**
   * 立刻清掉提示条（**不区分成败色**）。
   *
   * ## 为什么需要"清"这个动作（2026-11-12，裁决 3）
   *
   * 取证 D.2 实测：用户点「扫码登录取流账号」，底下还挂着**上一次**的红色提示
   * （「等了 3 分钟还没检测到新账号…」）。新提示确实会替换旧的，但
   * **两条红字长得一样** —— 用户分不清这是"这次的失败"还是"上次留下的"。
   *
   * 裁决：点按钮的**第一时间**先清掉上一条，之后无论成功失败都写新的。
   * 于是"屏幕上出现一条红字"永远意味着"刚刚那次失败了"。
   *
   * ⚠️ 失败提示本身**仍然常驻**（见上面那条的论证）—— 这里清的是
   * **上一次**的，不是给"这一次"加超时。
   *
   * ⚠️ **不许**用时间戳 / 序号来"区分新旧"（裁决 3 明令禁止）：
   * 那是把内部状态推给用户。
   */
  function clearNotice(): void {
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    root.querySelector('.panel-notice')?.remove();
  }

  // ── 自动更新（2026-11-16）──
  //
  // 懒读：进入「关于」Tab 或重画时才问后台。`updateReadFailed` 那一条早退不能省，
  // 理由与 `ensureBadgeRead` 完全相同 —— 本函数的 `.finally` 会调 `render()`，
  // 而 `render()` 又会调本函数，缺一条早退就是无限同步递归。
  let updateStatus: UpdateStatusView | null = null;
  let updateReading = false;
  let updateReadFailed = false;
  let updateBusy = false;

  /** 「关于」Tab 上的红点：有新版且用户没关过这一版时才显示 */
  const updateDot = el('span', 'tab-dot');
  updateDot.hidden = true;
  tabButtons.get('about')?.appendChild(updateDot);

  function ensureUpdateRead(): void {
    if (updateStatus !== null || updateReading || updateReadFailed) return;
    updateReading = true;
    void readUpdateStatus()
      .then((status) => {
        updateStatus = status;
        updateReadFailed = status === null;
      })
      /**
       * ⚠️ 这一段**不能省**（2026-11-17 二轮，把本函数提到 `render()` 顶部时才暴露）。
       *
       * `readUpdateStatus()` 是 `async`，`sendMessage` 同步抛（扩展被重载后的
       * `Extension context invalidated`）或返回 `undefined`（某些测试桩）时，
       * 它会**reject** 而不是返回 `null`。此时：
       *
       * - `updateReadFailed` 仍是 `false` ⇒ 三条早退全失效
       * - `.finally` 照样 `render()` ⇒ `render()` 又调本函数 ⇒ 再读 ⇒ 再 reject …
       *
       * 就是**死循环 + 内存暴涨**（真机上表现为面板卡死、页面 CPU 拉满）。
       * 把 rejection 与 `status === null` 同等对待（都是"读失败，本会话不再重试"）
       * 才能把环切断。之前本函数只在「关于」Tab 才被调用，这个环碰不到，所以没暴露。
       */
      .catch(() => {
        updateReadFailed = true;
      })
      .finally(() => {
        updateReading = false;
        render();
      });
  }

  /**
   * 打开「关于」Tab 即视为已读（2026-11-17）。
   *
   * ## 为什么用"进入 Tab"而不是加一个「×」按钮
   *
   * `docs/02-ui-spec.md` §5.3 的版式是定稿的（纵向四行），多一个「×」是净增 UI；
   * 而"点进关于页说明我已经看到了"本来就是用户的意图。
   * 安全性靠面板默认 Tab 是 `'quality'` 且**不记忆上次选中** —— 「关于」只能由用户主动点进来。
   *
   * ## ⚠️ 必须防重（这里是消息风暴的唯一入口）
   *
   * `render()` 是高频函数：`ensureUpdateRead()` 的 `.finally` 会调它，
   * 每次 Tab 切换、每次存盘都调它。没有防重就是**每帧一条消息**。
   *
   * 用**版本号**而不是布尔：`dismissedVersion` 只压"那一版"（`shouldPrompt` 的语义），
   * 界面上必须跟着一致 —— 否则"同一会话里先看到 v1.2.0、又查到 v1.3.0"时，
   * v1.3.0 的红点再也消不掉。
   *
   * 副作用要说清：如果用户就停在「关于」Tab 上点「检查更新」查出了一个新版本，
   * 那一次也会立刻算已读（他正看着版本行上的「最新 v1.3.0」，确实看到了）。
   * 换到别的 Tab 就不会 —— 那时 `render()` 走的是分支外面，根本不调本函数。
   *
   * ## ⚠️ 失败静默
   *
   * `requestUpdateDismiss()` 返回 `null` 时**什么都不做** —— 红点保留，别的都不变。
   * dismiss 只是消除提示，它失败不该把 Tab 切成错误态（那会让版本行和按钮一起消失）。
   * 也**不重试**：失败后每个 `render()` 都重发一次，比红点消不掉糟得多。
   *
   * ## ⚠️ `sendMessage` 会**同步抛**，而 `.catch()` 接不到
   *
   * 扩展被重载后，`chrome.runtime.sendMessage` 抛的是 `Extension context invalidated`
   * —— 那是**同步异常**，`panel-data.ts` 里挂在它后面的 `.catch(() => null)` 根本接不到。
   *
   * ## ⚠️ 但**光有 `try/catch` 在这里没用**（实测，2026-11-17 二轮）
   *
   * `requestUpdateDismiss()` 是 `async` 函数 ⇒ 体内的同步抛会被它自己**转成
   * rejected promise**，调用方那圈 `try` 里什么都不会发生。真正漏出去的是
   * **未处理的 promise rejection**：`.finally` 照跑（所以标志位不会卡），
   * 但控制台留一条 unhandled rejection，而"接住它"只能靠链上的 `.catch()`。
   *
   * 两层的分工：
   *
   * | 兜什么 | 靠什么 | 今天可达吗 |
   * | --- | --- | --- |
   * | `async` 转出来的 rejection（真实会发生的） | 链上的 `.catch()` | ✅ 是 |
   * | 万一以后 `requestUpdateDismiss` 改成非 `async` 的同步抛 | 外层 `try/catch` | ❌ **不可达** |
   *
   * ⚠️ **外层 `try/catch` 今天不可达**：调用一个 `async` 函数本身从不抛
   * （实测：删掉外层，全部用例绿、行为完全一致）。保留它只为将来那次重构兜底 ——
   * **不要**把它当成"同步抛已被处理"而去删链上的 `.catch()`，那才是真正生效的那层。
   *
   * 复位 `dismissSending` 放 `.finally` —— 成功、失败、抛，三条路都要放，否则锁死。
   *
   * 同一类 bug 在 `5b4396f` / `40a2aa9` 修过两次，不要再踩第三次。
   *
   * 不复位 `dismissedFor`：上下文都已失效，这次会话的后续请求一样会抛，
   * 重试没有意义（与"失败不重试"同一条纪律）。
   */
  let dismissSending = false;
  let dismissedFor: string | null = null;
  /**
   * 下一次 `render()` **不许**触发 dismiss（一次性）。
   *
   * 只有 `applyUpdateStatus()` 会置它 —— 那份状态是 `storage.onChanged` 推来的，
   * 不代表"用户看过这一版"。见该方法的注释。
   */
  let suppressDismissOnce = false;
  /**
   * 「有新版本」这个信号的**外部接收方**（贴边条）。
   *
   * 为什么不直接调 `sidebar.setUpdateDot()`：本文件**拿不到** `SidebarHandle` ——
   * `mountPanelBody()` 先于 `mountSidebar()` 构造（sidebar 的 `body` 就是本函数的
   * `root`）。而"先建 body、后再塞 handle 进来"的两段式初始化比一个 sink 更脆。
   */
  let updateSink: ((available: boolean) => void) | null = null;

  /** 当前该不该亮"有新版本"——**唯一判据**，红点、贴边条、sink 全用它 */
  const updateAvailable = (): boolean => updateStatus?.phase === 'available';

  function ensureUpdateDismissed(): void {
    if (dismissSending) return;
    const latest = updateStatus?.latestVersion ?? null;
    if (latest === null || updateStatus?.phase !== 'available') return;
    if (dismissedFor === latest) return;

    dismissedFor = latest;
    dismissSending = true;
    try {
      void requestUpdateDismiss()
        .then((status) => {
          // null = 后台没应答 / 没成功：静默保留红点，不切错误态
          if (status) updateStatus = status;
        })
        // ⚠️ 这一句不能省：`async` 函数体内的同步抛会变成 rejection，
        // 没有它就是一个未处理的 promise rejection（真机表现为控制台一片红）
        .catch(() => undefined)
        .finally(() => {
          dismissSending = false;
          render();
        });
    } catch {
      // 同步抛（`Extension context invalidated`）：复位在途标志，别把面板锁死
      dismissSending = false;
    }
  }

  /**
   * ── 加载快照的 ⟳（T5）──
   *
   * ## 为什么由编排层做，而不是让浮层自己取
   *
   * 取数只有 `panel-data.ts` 一条路（`fetchLoadingSnapshot`），
   * 浮层是纯 DOM 层（与 `diagnosticsPane` 同一条纪律：它不认识 chrome / postMessage）。
   *
   * ## 为什么刷完要 `render()`，并写回模型
   *
   * 写回 `model.loading` 而不是另存一份局部状态：速览行读的是
   * `model.quality.loading`，两处各存一份就会出现"浮层刷新了、速览行还是旧值"。
   * 与 `pageView` 留在模型里同一个理由。
   *
   * ⚠️ `in-flight` 去重（`loadingRefreshing`）：⟳ 是用户可以连点的按钮，
   * 每点一次都发一条 postMessage 没有任何收益，只会让应答互相超车。
   */
  const refreshLoading = (): void => {
    if (loadingRefreshing) return;
    loadingRefreshing = true;
    void fetchLoadingSnapshot({ pageKind: model?.pageKind ?? 'other' })
      .then((next) => {
        if (model === null) return;
        /**
         * ⚠️ **两处都要写**（2026-11-20 修）。
         *
         * `model.loading` 是浮层（`loadingDetailPane`）读的，`model.quality.loading`
         * 是速览行（`tabs.ts` 的 `buildQualityQuick`）读的 —— 它们是**两个字段**。
         *
         * 旧实现只写前者，于是这段话上面的注释「写回 `model.loading` ……
         * 速览行读的是 `model.quality.loading`，两处各存一份就会出现"浮层刷新了、
         * 速览行还是旧值"」讲的其实是**它自己**：点 ⟳ 浮层变了、速览行没变。
         * 归零 / 主动推送之后这个偏差会更容易被看见（换集后速览行停在上一集的
         * 「线路」结论上），所以在这里一次补齐，而不是让下游各自兜底。
         */
        model = { ...model, loading: next, quality: { ...model.quality, loading: next } };
      })
      .catch(() => {
        /**
         * `fetchLoadingSnapshot` 自己不会抛（超时与形状不对都归到 `unanswered`），
         * 真抛了（`Extension context invalidated` 这类同步抛）说明通道已经废了 ——
         * 如实标成"没人应答"，而不是把面板卡在 ⟳ 上转圈。
         */
        if (model !== null) model = { ...model, loading: { kind: 'unanswered' } };
      })
      .finally(() => {
        loadingRefreshing = false;
        render();
      });
  };

  /**
   * ── 换集后主动重取（2026-11-20）──
   *
   * ## 为什么要订阅（真机实测的空白）
   *
   * 面板开着累计 900.4 秒、**0 次取数**；换集本身一条取数都不产生。于是用户
   * 换完集把鼠标移到侧边条看时间轴，看到的还是上一集的数据 —— 而那正是
   * 他要看的那一刻。
   *
   * ## 为什么不做"展开才重取"的判据
   *
   * `mountPanelBody()` 不知道侧边条的开合状态（那是 `sidebar.ts` 的），要判就得
   * 往 `PanelActions` 里加一个注入项 —— 为一个**低频**推送去增加一条跨层耦合，
   * 收益远小于"漏接线就永远不重取"的风险。而且这条推送只在**真的换页**时来
   * （一次会话几次），不是常驻：一次只读 `postMessage` 的成本可以忽略。
   *
   * 反过来更划算：面板收着的时候把 `model.loading` 也更新掉，用户下一次 hover
   * 展开时数据已经是新的 —— 正是"鼠标快速移到侧边条"那个场景。
   *
   * ## 为什么还要一次补救取数（不是轮询）
   *
   * 实测：新集首波 `.m4s` 在 `pushState` 后 **577.1–848.1ms** 才到，而 reset 在
   * 28.0–49.2ms 就做完了 —— 通知到达面板时，采集器里**还什么都没有**（实测空窗
   * 288ms 内 `hosts` 恒为空）。所以第一次重取很可能只拿到一份"只有下载视频片段、
   * 没有可以播放/开始播放"的半成品。
   *
   * 补救**只排一次**、延迟 1200ms（略大于实测最大 848.1ms + 一次消息往返），
   * 且只在"确实还没到"时才真的再取一次；`setTimeout` 单次，**不是** `setInterval`。
   * 项目硬纪律：不许常驻定时器（曾因此挂后台白屏）。
   */
  let loadingRetryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearLoadingRetry = (): void => {
    if (loadingRetryTimer === null) return;
    clearTimeout(loadingRetryTimer);
    loadingRetryTimer = null;
  };

  /**
   * 这份快照值不值得再取一次：还没见到分片（`hosts` 空）或还没见到起播。
   *
   * ## 为什么这里还要自己判一次 `hosts`（桥已经校验过了）
   *
   * `panel-data.ts` 的 `fetchLoadingSnapshotViaPage()` 现在会拒绝缺 `hosts` 的应答
   * （那是不信任输入的**边界**，见那里的注释）。所以正常路径下这里拿到的
   * `snapshot.hosts` 一定是数组，这个判据"用不上"。
   *
   * 保留它的理由只有一条，但足够：**这段代码跑在 `setTimeout` 回调里**。
   * 回调里的异常没人 `await`、没人 catch，只会变成一行控制台报错，
   * 然后补救取数**永远不发生** —— 症状与"根本没接推送"一模一样，最难查。
   * 边界已经挡住了畸形输入，这里是"万一挡漏了别静默死掉"的第二道：
   * 缺字段时按"还没到"处理，保守地多取一次（多取一次只读快照的代价可忽略）。
   */
  const loadingNeedsRetry = (outcome: LoadingOutcome | undefined): boolean => {
    if (outcome === undefined || outcome.kind !== 'ok') return false;
    const snapshot = outcome.snapshot;
    if (!Array.isArray(snapshot.hosts) || snapshot.hosts.length === 0) return true;
    return !snapshot.events.some((e) => e.stage === 'playing');
  };

  const onLoadingPush = (): void => {
    refreshLoading();
    clearLoadingRetry();
    loadingRetryTimer = setTimeout(() => {
      loadingRetryTimer = null;
      // 此刻第一次重取早已落地（那是一次 ms 级的 postMessage 往返），
      // 所以这里读到的 `model.loading` 就是它的结果，不是上一集的旧值。
      if (!loadingNeedsRetry(model?.loading)) return;
      refreshLoading();
    }, LOADING_CHANGED_RETRY_MS);
  };

  /**
   * ⚠️ 必须保存取消函数并在卸载时调 —— `window` 上的监听器不跟着 DOM 走。
   * 不摘的话每次面板重挂都多叠一层监听（用户反复开关 / 扩展 reload 之后累积）。
   */
  const stopLoadingPush = onLoadingChanged(onLoadingPush);

  const render = (): void => {
    /**
     * 一次性压制：上一次 `applyUpdateStatus()` 推来的状态不算"用户看过"。
     *
     * 必须在**这里**消费（而不是在 `about` 分支里），否则当前不在「关于」时
     * 标志会残留到下一次真正的 Tab 切换，把那次合法的 dismiss 一起吃掉。
     */
    const suppressDismiss = suppressDismissOnce;
    suppressDismissOnce = false;

    // Tab 高亮
    for (const [t, b] of tabButtons) {
      b.classList.toggle('active', t === tab);
      b.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }

    /**
     * ⚠️ **必须在算 `updateDot.hidden` 之前、且不在 `about` 分支里**（2026-11-17 修）。
     *
     * ## 红点通道曾经整个是死的
     *
     * 原先这一句只写在 `if (tab === 'about')` 里面，于是：
     *
     * 1. 用户点进「关于」之前 `updateStatus` 恒为 `null` ⇒ 下面那行
     *    `updateDot.hidden = … !== 'available'` **恒为 true**，红点从来不亮；
     * 2. 而一旦点进「关于」，`ensureUpdateDismissed()` 立刻把 phase 改成 `'dismissed'`
     *    ⇒ 红点又隐藏。
     *
     * 净效果：红点只在"读到状态 → dismiss 应答"那一个消息往返里存在（毫秒级）。
     * `docs/02-ui-spec.md` §5.3「通知通道」承诺的 Tab 红点**从未对用户生效**，
     * 真正起作用的只有工具栏角标。**通知通道必须有独立于 Tab 的触发点**，
     * 否则它作为通知通道就不存在 —— 用户不点进来就永远看不到它。
     *
     * ## 与文件头注释一致
     *
     * 上面那段注释原文是「进入「关于」Tab **或重画时**才问后台」，本来就是两条触发路径，
     * 只是当时只实现了一条。
     *
     * ## 代价与递归安全性
     *
     * 面板挂载时会多发一条 `update/status`（每页只挂载一次，不是每次 render ——
     * 三条早退挡着）。递归方面：`ensureUpdateRead` 的 `.finally` 会调 `render()`，
     * 而 `render()` 又调它 —— 靠的就是 `updateStatus !== null` / `updateReading` /
     * `updateReadFailed` 那三条早退，**一条都不能删**。
     */
    ensureUpdateRead();

    updateDot.hidden = !updateAvailable();

    /**
     * 同一个判据喂给**贴边条**（2026-11-17）。
     *
     * ⚠️ 判据必须与上一行**完全一致**（同一个 `phase`），不要另算一遍 ——
     * 两条通道对"有没有新版"给出不同答案，比只有一条通道更糟。
     * `updateStatus === null`（读不到状态）⇒ 两个都灭：看不见的东西不许下结论。
     */
    updateSink?.(updateAvailable());

    /**
     * 「关于」Tab **不依赖页面模型**：面板在任何页面上都能看版本与更新。
     * 所以它排在 `!model` 早退之前 —— 否则加载中会看到一个空 Tab。
     */
    if (tab === 'about') {
      // 已读到状态且 phase === 'available' 时，进来即视为已读（内部自带防重）
      if (!suppressDismiss) ensureUpdateDismissed();
      replaceChildren(content, [
        aboutTab(updateStatus, {
          busy: updateBusy,
          check: () => {
            if (updateBusy) return;
            updateBusy = true;
            render();
            void requestUpdateCheck()
              .then((reply) => {
                if (reply.status) updateStatus = reply.status;
                /**
                 * ## 文案只由「有没有新版」决定，`ok` / `unchanged` **不参与**
                 *
                 * `unchanged` 来自 HTTP **304**，它的语义是「**远端**自上次检查以来没变」，
                 * 与「本地是否落后」没有半点关系。真机踩过：本地 1.0.0、远端 1.1.0、
                 * 上次已取到过 1.1.0 的元数据 ⇒ 这次条件请求 304 ⇒ 说「已是最新版本」，
                 * 而卡片正写着「有新版本 v1.1.0」—— **同一个面板两句话互相打架**。
                 *
                 * 所以 `ok` 与 `unchanged` 在用户可感知层面**没有区别**（区别只在 HTTP 层），
                 * 合并成一支；该说什么完全取决于 `isNewerThan`。
                 *
                 * ⚠️ **不能用 `phase` 判**：停在「关于」Tab 时 `ensureUpdateDismissed()`
                 * 已经把 phase 变成 `'dismissed'`，用它会在这个节骨眼上说"已是最新"。
                 *
                 * `rate-limited` / `failed` 仍各自一支：那是"该等"与"该报 bug"的区别，
                 * 混进成功里用户就不知道下一步做什么（`docs/02-ui-spec.md` §5.3 反模式表）。
                 */
                const next = reply.status ?? null;
                const hasNewer =
                  next !== null && isNewerThan(next.latestVersion, next.currentVersion);

                if (reply.outcome === 'rate-limited') {
                  showNotice(reply.reason ?? 'GitHub 限流', false);
                } else if (reply.outcome === 'failed') {
                  showNotice(reply.reason ?? '检查失败', false);
                } else if (hasNewer) {
                  showNotice(`发现新版本 v${String(next?.latestVersion)}`, true);
                } else if (next === null) {
                  /**
                   * `outcome` 是 `ok`/`unchanged` 却没带回 `status` ——
                   * 按构造不可达（`handleUpdateCheck` 每个分支都带 `status`），
                   * 但真出现时**不许**说「已是最新」：不知道就是不知道（§0 铁律）。
                   * 这里说中性的一句，用的还是原来 `ok` 支那四个字。
                   */
                  showNotice('检查完成', true);
                } else {
                  showNotice('已是最新版本', true);
                }
              })
              .finally(() => {
                updateBusy = false;
                render();
              });
          },
          toggleAuto: (next) => {
            // 乐观更新：先改本地镜像，避免开关在往返期间不动
            if (updateStatus) updateStatus = { ...updateStatus, autoCheckEnabled: next };
            render();
            void writeUpdateAuto(next).then((status) => {
              if (status) updateStatus = status;
              render();
            });
          },
          openUpdate: () => {
            void openUpdateWindow().then((opened) => {
              if (!opened) showNotice('更新窗口打不开', false);
            });
          },
          openReleases: () => {
            // content script 里没有 `chrome.tabs`，用 window.open（在点击手势内，不会被拦）
            window.open(UPDATE_RELEASES_PAGE, '_blank', 'noopener,noreferrer');
          },
        }),
      ]);
      return;
    }

    if (!model) {
      replaceChildren(content, [el('p', 'pane-note', '正在读取…')]);
      return;
    }

    // 二级浮层优先：栈非空时不管当前 Tab
    const top = stack[stack.length - 1];
    if (top?.kind === 'homeClean') {
      replaceChildren(content, [
        homeCleanPane(model.clean, {
          toggleOption: (k, n) => void writeOption(k, n),
          toggleCategory: (cat, n) => void writeCategory(cat, n),
          back: () => {
            stack = stack.slice(0, -1);
            render();
          },
        }),
      ]);
      return;
    }

    if (top?.kind === 'diagnostics') {
      /**
       * 诊断浮层。
       *
       * ## 进入即重取（2026-11-10 第七轮修）
       *
       * **重取发生在「进入」那一刻**（`openDiag` 里先清 `diagData` 再压栈），
       * 而不是靠 `render()` 猜。`render()` 只负责画：
       *   - 没有数据 → "正在采集…"（进入时已经发起了）
       *   - 有数据 → 画出来
       *
       * `loadDiag` 内部有 in-flight 去重，`render()` 被反复调用也不会重复发请求。
       */
      if (diagData === null) {
        replaceChildren(content, [el('p', 'pane-note', '正在采集诊断信息…')]);
        return;
      }
      replaceChildren(content, [
        diagnosticsPane(
          {
            rows: diagData.rows,
            logs: diagData.logs,
            version: diagVersion(),
            logsMeta: diagData.logsMeta,
            /**
             * 加载快照的通道结局（T7）。
             *
             * ⚠️ 传 `model.loading`（画质 Tab 速览行读的**同一份**），不在这里
             * 重新取数：诊断页要说的是"这一次加载"，重取只会得到同一份内存状态，
             * 却多一次 2 秒空窗。
             *
             * 2026-11-17（审计收尾）：`diagnosticsPane()` 里这个字段改成**必填**，
             * "还没读到"那条路（渲染成「不是播放页」的因果断言）被类型去掉了。
             *
             * 这里的 `?? { kind: 'absent' }` **不是**在把两者混回去：生产路径的
             * `buildPanelModel()` **恒填** `loading`（`input.loading ?? absent`），
             * 所以真相是"永远有值"。默认值的唯一用途是让**手工构造的 `PanelModel`
             * 字面量**（今天只有 13 处测试辅助函数）也能过类型 —— 那些字面量从不
             * 渲染诊断页。
             */
            loading: model.loading ?? { kind: 'absent' },
          },
          {
            back: () => {
              stack = stack.slice(0, -1);
              render();
            },
            refresh: () => {
              /**
               * 手动刷新：先清掉旧数据再拉，让 UI 立刻显示"正在采集…"，
               * 用户能感知到"点了"。
               */
              diagData = null;
              loadDiag();
              render();
            },
            exportJson: () => {
              const now = new Date();
              downloadJson(
                buildExportPayload({
                  rows: diagData?.rows ?? [],
                  logs: diagData?.logs ?? [],
                  /**
                   * `diagData === null`（还没采完就点了导出）= **没读过**。
                   * 兜底**必须和渲染侧共用 `describeLogsMetaFallback()`**
                   * （task-28：两侧各写一份，正是 `logsMeta` 缺失时崩溃的根因）。
                   * 唯一差别是这里多填了 `limit` / `readAt` —— 它们只用于展示与定位，
                   * **不参与"是否可信"的判断**（`ok` / `err` 与渲染侧完全一致）。
                   */
                  logsMeta: diagData?.logsMeta ?? {
                    ...describeLogsMetaFallback(),
                    limit: DIAG_LIMIT,
                    instanceId: instanceId(),
                    readAt: now.getTime(),
                  },
                  version: diagVersion(),
                  /**
                   * 第八个字段（T8）：本次加载。
                   *
                   * `model?.loading` 缺席时给 `{kind:'absent'}` —— 与渲染侧
                   * （`diagnosticsPane` 的 `data.loading`）**同一个兜底**，
                   * 导出与界面不会一个说"没有记录"、另一个说"读取失败"。
                   */
                  loading: model?.loading ?? { kind: 'absent' },
                  now,
                  trace: diagTrace,
                  echo: diagEcho,
                }),
                exportFileName(now),
              );
            },
          },
        ),
      ]);
      return;
    }

    if (top?.kind === 'loadingDetail') {
      /**
       * 加载详情浮层（T5）。
       *
       * ## 数据来自模型，**不在这里取数**
       *
       * `model.loading` 是首屏（或上一次 ⟳ / 写操作后的重取）已拿到的那一份。
       * 进入浮层时**不重新采集**：用户点进来就是为了看"刚才那一次加载"，
       * 而重新采集会把这个页面此刻的环形缓冲再读一遍 —— 结果通常一样，
       * 却多一次 2 秒的空窗（超时的那 2 秒里界面会闪一下"读取失败"）。
       * 想看最新的点 ⟳，那条路才重取。
       *
       * `undefined` 与 `{kind:'absent'}` 同义，交给浮层去画那句实话。
       */
      replaceChildren(content, [
        loadingDetailPane(model.loading, {
          back: () => {
            stack = stack.slice(0, -1);
            render();
          },
          refresh: () => {
            refreshLoading();
          },
          /**
           * 「查看完整诊断 ›」= **压栈**，不是跳转：用户按返回要回到这里，
           * 而不是回到一级 Tab。与 `openDiag` 同一手法，且进入即重取诊断数据。
           */
          openDiagnostics: () => {
            diagData = null;
            loadDiag();
            stack = [...stack, { kind: 'diagnostics' }];
            render();
          },
        }),
      ]);
      return;
    }

    switch (tab) {
      case 'quality': {
        /**
         * ── 总开关能不能点（2026-11-12，task-10）──
         *
         * ## 判据走 `isStreamingReady()`，**不在这里另写一份**
         *
         * | 取流身份 | 有凭据 | `isStreamingReady` | 开关 |
         * | --- | --- | --- | --- |
         * | `page` | 无 | **`true`** | 可点（本就不需要扩展参与） |
         * | `extension` | 有 | `true` | 可点 |
         * | `extension` | 无 | `false` | **灰** |
         *
         * ⚠️ **`page` 身份下 `hasCredential` 恒为 `false`** —— 只看它会把一个
         * **完全可用**的配置误禁。这正是 `isStreamingReady()` 存在的理由
         * （`streaming-identity.ts` 的注释：「这是一条判据，只许有一处实现」）。
         *
         * ⚠️ 身份用**面板本地镜像** `streamingIdentity`（与账号 Tab 的胶囊同源）：
         * `actions.streamingIdentity` 是挂载时的初值，用户点过胶囊后就过期了。
         *
         * ## 身份未知（`null`）时**不禁**
         *
         * 读不到身份 = 不知道"要不要代理"。此时禁用会让一个可能完全可用的配置
         * 变成不可用；而"不禁"最强也就是让用户点一下，`toggleProxy` 会照常发消息。
         * 与 `panel-data.ts` 的"缺参数不改口"同一纪律：**不知道就别替他下结论**。
         */
        const known = streamingIdentity;
        const proxyUsable = known === null || isStreamingReady(known, model.account.hasCredential);

        replaceChildren(content, [
          qualityTab(model.quality, {
            toggleProxy: (n) => void toggleProxy(n),
            proxyUsable,
            /**
             * 文案与「账号」Tab 的引导语**同一套说法**（「扫码登录取流账号」），
             * 不制造第二套术语。也不出现"凭据"/"proxy"/"DNR" 这类实现词。
             */
            proxyDisabledReason: proxyUsable
              ? null
              : '还没有可用的取流账号 —— 到「账号」Tab 扫码登录取流账号后就能打开',
            /**
             * 加载时间轴速览的「详情 ›」。
             *
             * 不在这里重新取数：浮层读 `model.loading`（首屏已拿到的同一份），
             * 见 `loadingDetail` 分支的注释。压栈而不是切 Tab，返回时回到画质 Tab。
             */
            openLoading: () => {
              stack = [...stack, { kind: 'loadingDetail' }];
              render();
            },
          }),
        ]);
        break;
      }
      case 'clean':
        replaceChildren(content, [
          cleanTab(model.clean, {
            toggleOption: (k, n) => void writeOption(k, n),
            openSub: () => {
              stack = [...stack, { kind: 'homeClean' }];
              render();
            },
          }),
        ]);
        break;

      /**
       * 「显示」Tab（2026-11-10 新增）：页内角标 + 诊断入口。
       *
       * 角标开关是**懒读**的（首次进这个 Tab 才读），不占首屏。
       */
      case 'display': {
        ensureBadgeRead();
        ensurePcdnFilterRead();
        /**
         * ## 角标能不能出现（2026-11-16）
         *
         * `buildBadge()` 的第一条判据是「没在代理 → 不显示」——角标的语义是
         * "我现在被接管了"。所以：
         *   - `page` 身份 → 不装规则 → 角标恒不出现
         *   - 没凭据 → 不装规则 → 同上
         *
         * 这两种状态下开关仍然可点就是 UI 的错：用户开了却什么也看不到。
         * 判据与「自动接管取流」同源（`hasCredential` 是 `proxy/status` 的硬证据，
         * 比身份更可靠），但**多一条 page 分支** —— 那个开关对 page 也算可用，
         * 因为 page 模式下它另有含义，而角标在 page 下是真的没有。
         */
        const badgeDisabledReason =
          streamingIdentity === 'page'
            ? '当前用浏览器账号取流 —— 角标只在扩展接管生效时出现'
            : !(model?.account.hasCredential ?? false)
              ? '还没有可用的取流账号 —— 到「账号」Tab 扫码登录后，角标才会出现'
              : null;
        replaceChildren(content, [
          displayTab(badgeEnabled, {
            toggleBadge: (n) => void writeBadge(n),
            badgeUsable: badgeDisabledReason === null,
            badgeDisabledReason,
            /**
             * ⚠️ 推荐流开关传**自己的**本地镜像 `feedAccountEnabled`，
             * **不是** `streamingIdentity` —— 那是"两个功能独立"在调用点上的落地。
             * 传错了（例如 `feedAccountEnabled: streamingIdentity === 'extension'`）
             * 会让开关跟着身份变，而那正是用户明确否定的行为。
             *
             * 2026-11-11 从「账号」Tab 迁来，**判据原样保留**。
             */
            feedAccountEnabled,
            toggleFeedAccount: (next) => void toggleFeedAccount(next),
            hasCredential: model?.account.hasCredential ?? false,
            badgeReadFailed,
            pcdnFilterEnabled,
            pcdnFilterReadFailed,
            togglePcdnFilter: (n) => void writePcdnFilter(n),
            openDiag: () => {
              /**
               * ## 进入诊断浮层 = 重新采集（2026-11-10 第七轮）
               *
               * 先清掉旧数据再压栈：`render()` 会立刻显示"正在采集…"，
               * 用户能感知到"进去了、正在拉"。旧实现不清，
               * 于是**第二次进入看到的是上一次的结果**（smoke 实测）。
               *
               * 诊断工具的语义就是"现在这一刻是什么样"，
               * 显示缓存比不显示更糟 —— 它会让人以为问题已经解决了。
               */
              diagData = null;
              loadDiag();
              stack = [...stack, { kind: 'diagnostics' }];
              render();
            },
          }),
        ]);
        break;
      }

      case 'account':
        replaceChildren(content, [
          accountTab(model.account, Date.now(), model.pageKind, {
            login: actions.login,
            logout: actions.logout,
            /**
             * ⚠️ 传**本地镜像**的 `streamingIdentity`，不是 `actions.streamingIdentity`。
             *
             * `actions` 那份是挂载时的初值，用户点过胶囊之后它就过期了。
             * 用本地镜像才能让乐观更新生效（否则点了看不到变化）。
             */
            streamingIdentity,
            toggleStreamingIdentity: (next) => void toggleStreamingIdentity(next),
            /**
             * 退出结果走 `showNotice()`（`root` 级，跨 `replaceChildren` 存活）。
             *
             * ⚠️ 这里**不能**写进 `content`（那个容器每次 `render()` 都被
             * `replaceChildren`），也不能让账号 Tab 自己往 `box` 里塞 ——
             * 那正是取证 A 节路径②的成因。
             */
            notifyResult: (text, ok) => showNotice(text, ok),
          }),
        ]);
        break;
    }
  };

  const showTab = (t: PanelTab): void => {
    tab = t;
    // 切 Tab 时清栈：用户点 Tab 的意思是"我要看那个 Tab"，不是"在浮层里切后台"
    stack = [];
    /**
     * 进「显示」Tab = **一次明确的重试意愿**（2026-11-12，task-5）。
     *
     * 角标开关读失败后 `badgeReadFailed` 会挡住自动重试（见 `ensureBadgeRead`
     * 的三重早退）。若不复位，用户就**永远**只能看到那个灰开关 + 那句"读不到"，
     * 只能靠重开面板恢复 —— 那是把一个瞬时故障变成永久故障。
     *
     * 复位后 `render()` → `ensureBadgeRead()` 会重新发一次请求。
     */
    if (t === 'display') badgeReadFailed = false;
    if (t === 'display') pcdnFilterReadFailed = false;
    /**
     * 进「关于」Tab 同理 —— **同一纪律，不是新发明**（2026-11-17 三轮）。
     *
     * `updateReadFailed` 是"本会话不再重试"的闸：它挡住了
     * `render → read → reject → render` 那个死循环（见 `ensureUpdateRead` 的注释）。
     * 但它也把**瞬时**失败变成了**永久**失败：读一次不成，这个 Tab 就只剩
     * 「读不到更新状态 —— 关掉面板再打开试试」一行，检查 / 更新 / 开关全不渲染，
     * 用户唯一的出路是关面板重开。
     *
     * 而 P1 把首次读取提前到了**面板挂载那一刻**（页面刚加载、SW 最可能还没醒），
     * 正是最容易撞上瞬时失败的时刻 —— 所以这个手动重试口不是可选项。
     *
     * 每次进 Tab 最多复位 1 次，读到就 `updateStatus !== null` 永久早退，
     * 读不到就再置 true，**不会成风暴**。
     */
    if (t === 'about') updateReadFailed = false;
    render();
  };

  render();

  return {
    showTab,
    /**
     * 接上「有新版本」信号（贴边条）。**接上时立刻用当前状态调一次** ——
     * 否则"先建 body 后建 sidebar"这个顺序会丢掉挂载那一刻已经读到的状态，
     * 用户得等下一次重画才看得到提示。
     */
    setUpdateSink(sink) {
      updateSink = sink;
      sink(updateAvailable());
    },
    setModel(next) {
      model = next;
      render();
    },
    applyUpdateStatus(next) {
      /**
       * ## 为什么要从外面推状态进来（2026-11-17 三轮）
       *
       * `updateStatus` 是**面板实例自己的缓存**：`ensureUpdateRead` 读到一次就不再重读。
       * 于是同一个 B 站页面开两个 Tab 各挂一个面板时，在 A 里看过之后，
       * **B 的红点还亮着** —— 后台其实已经记成已读了。
       *
       * 解法是由 `entrypoints/content-panel.content.ts` 订阅 `pluma:update-state`，
       * 把新状态推进来。这里只负责替换缓存并重画。
       *
       * ## ⚠️ 它**不算**"用户看过这一版"
       *
       * 推来的状态来自别的 Tab / 后台自动检查，不是用户打开的「关于」。
       * 所以置 `suppressDismissOnce`，让紧接着那次 `render()` **不触发** dismiss ——
       * 否则两个面板会互相踩：A 里刚查出 1.3.0，B 停在「关于」上就把它记成已读，
       * A 那边红点直接消失。
       */
      updateStatus = next;
      // 拿到了新鲜状态 ⇒ "读失败"这件事已经过去，闸门放开
      updateReadFailed = false;
      suppressDismissOnce = true;
      render();
    },
    currentTab: () => tab,
    depth: () => stack.length,
    showNotice,
    clearNotice,
    /**
     * 卸载：先摘 `window` 监听、再清待触发的补救定时器。
     *
     * ## 顺序为什么是"先摘监听"
     *
     * 反过来的话，两行之间到达的一条 `loading-changed` 会**再排一个定时器**，
     * 紧接着 `clearTimeout` 又把它清掉 —— 结果是运气决定有没有泄漏，
     * 而那正是最难复现的一类 bug。先摘掉消息源，后面的清理就是确定的。
     *
     * 幂等：`removeEventListener` 对同一个函数重复调用无害；
     * `clearLoadingRetry()` 自带 `null` 判断。
     */
    dispose() {
      stopLoadingPush();
      clearLoadingRetry();
    },
    root,
  };
}
