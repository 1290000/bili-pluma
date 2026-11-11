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
import type { StreamingIdentity } from '@shared/constants/streaming-identity';
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

  /** 读一次角标开关（进入净化 Tab 或重画前用） */
  const ensureBadgeRead = (): void => {
    if (badgeEnabled !== null) return;
    void readBadgeEnabled()
      .then((v) => {
        badgeEnabled = v;
        render();
      })
      .catch(() => {
        /* 读不到就保持禁用，不画成"关" */
      });
  };

  /** 角标开关写入：不需要面板做别的，`content.ts` 监听 `onChanged` 自己重画 */
  const writeBadge = async (next: boolean): Promise<void> => {
    const prev = badgeEnabled;
    badgeEnabled = next; // 乐观更新：开关要跟手
    render();
    try {
      await writeBadgeEnabled(next);
    } catch {
      badgeEnabled = prev;
      render();
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

  /** 当前动作集：所有写操作统一从这里过，保证写前重读 */
  const writeOption = async (key: CleanOptionKey, next: boolean): Promise<void> => {
    /**
     * ## 必须**重新读**，不能复用 `model.clean`
     *
     * `model` 是上一次取数的快照。用户可能刚在别的标签页的设置页里改过，
     * 也可能这中间 `storage.onChanged` 又触发了一次。
     * 用旧快照做"改一个键"，写回去的就是**过期数据** —— 那是"读—改—写"的经典错误。
     */
    const fresh = normalizeCleanPreferences(await readRawCleanOptions());
    const updated = patchCleanOption(fresh.options, key, next);

    await writeCleanOptionFlags(updated);
    applyCleanNow();
    await refreshModel();
  };

  /** 分类切换：同样是读—改—写，但写的是另一半（`hideCategories`） */
  const writeCategory = async (cat: string, next: boolean): Promise<void> => {
    const fresh = normalizeCleanPreferences(await readRawCleanOptions());
    const cats = toggleHideCategory(fresh.hideCategories, cat, next);

    await writeCleanHideCategories(cats);
    applyCleanNow();
    await refreshModel();
  };

  /** 总开关：走 background 消息（与 popup 同一条通道，不新增消息类型） */
  const toggleProxy = async (next: boolean): Promise<void> => {
    await chrome.runtime.sendMessage({ type: 'proxy/set', enabled: next }).catch(() => null);
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

  /** 重取一次模型并重画 */
  const refreshModel = async (): Promise<void> => {
    const next = await loadPanelModel({
      pageKind: model?.pageKind ?? 'other',
      primary: model?.account.primary ?? {
        uname: null,
        level: null,
        loggedIn: 'unknown',
        source: 'none',
      },
    });
    model = next;
    render();
  };

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
      case 'quality':
        replaceChildren(content, [
          qualityTab(model.quality, { toggleProxy: (n) => void toggleProxy(n) }),
        ]);
        break;
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
          }),
        ]);
        break;
    }
  };

  const showTab = (t: PanelTab): void => {
    tab = t;
    // 切 Tab 时清栈：用户点 Tab 的意思是"我要看那个 Tab"，不是"在浮层里切后台"
    stack = [];
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
     * @param text 提示文案
     * @param ok   `true` 中性/成功色，`false` 危险色
     */
    showNotice(text: string, ok: boolean): void {
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
    },
    root,
  };
}
