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
  readRawCleanOptions,
  writeBadgeEnabled,
  writeCleanHideCategories,
  writeCleanOptionFlags,
} from '@platform/storage/ui-prefs-store';
import { collectFacts, readLastDiagEcho, type DiagRow } from '@platform/diagnostics/collect';
import { readDiag, readDiagTrace, type DiagEntry } from '@platform/storage/diag-store';
import { el, replaceChildren } from './dom';
import {
  patchCleanOption,
  toggleHideCategory,
  loadPanelModel,
  type PanelModel,
} from './panel-data';
import { accountTab, cleanTab, displayTab, homeCleanPane, qualityTab } from './tabs';
import { isStreamingReady, type StreamingIdentity } from '@shared/constants/streaming-identity';
import { buildExportPayload, diagnosticsPane, downloadJson, exportFileName } from './diagnostics';

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
export const PANEL_TABS = ['quality', 'clean', 'display', 'account'] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/**
 * Tab 显示文字。
 *
 * ⚠️ **四个 Tab 挤在 280px 里**，每个约 68px（扣掉 padding 与 gap）。
 * 两字中文在 13px 字号下约 26px，加 5px 左右 padding 完全放得下 ——
 * 所以**不需要缩字号或改成图标**。见 `PANEL_CSS` 里 `.tab` 的注释。
 */
const TAB_LABEL: Record<PanelTab, string> = {
  quality: '画质',
  clean: '净化',
  display: '显示',
  account: '账号',
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
type SubKind = 'homeClean' | 'diagnostics';

/** 编排层对外暴露的句柄 */
export interface PanelController {
  /** 切到某个一级 Tab */
  showTab(tab: PanelTab): void;
  /** 重画（模型变了） */
  setModel(model: PanelModel): void;
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
   * 诊断数据（阶段 3）。**懒加载**：只有进入诊断浮层时才去 `collectFacts()`。
   *
   * 理由：`collectFacts()` 要发多次 chrome API 调用（窗口 / cookie / DNR / manifest…），
   * 面板每次展开都跑一遍是浪费。诊断是排查时才看的东西。
   */
  let diagData: { rows: readonly DiagRow[]; logs: readonly DiagEntry[] } | null = null;
  /** 定位追踪（`pluma:diag-trace`）。`null` = 还没有记录 */
  let diagTrace: { at: number; step: string; detail: string; from: string } | null = null;
  /**
   * `diag/facts` 应答里的调试回显（**不经 storage**，2026-11-10 第八轮）。
   * `null` = 还没有 / 老版本 background。
   */
  let diagEcho: string | null = null;
  let diagLoading = false;

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
        const logs = await readDiag();
        diagData = { rows, logs };
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
      } catch {
        diagData = { rows: [], logs: [] };
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

  const render = (): void => {
    // Tab 高亮
    for (const [t, b] of tabButtons) {
      b.classList.toggle('active', t === tab);
      b.setAttribute('aria-selected', t === tab ? 'true' : 'false');
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
          { rows: diagData.rows, logs: diagData.logs, version: diagVersion() },
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
                  version: diagVersion(),
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
      case 'display':
        ensureBadgeRead();
        replaceChildren(content, [
          displayTab(badgeEnabled, {
            toggleBadge: (n) => void writeBadge(n),
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
    render();
  };

  render();

  return {
    showTab,
    setModel(next) {
      model = next;
      render();
    },
    currentTab: () => tab,
    depth: () => stack.length,
    showNotice,
    clearNotice,
    root,
  };
}
