/**
 * 页内面板的**数据层** —— 取数 + 组装。
 *
 * ## 为什么面板自己取数，而不是走 `content.ts` 的 postMessage 桥
 *
 * 面板覆盖 `www` + `live` 全站，而 `content.ts` 只在播放页注入。两者是**不同的
 * content script 实例**，内存状态互不可见 —— 面板那一侧没有 `pageState` 可用。
 *
 * 所以面板自己发消息取数。**不新增消息类型**（`messages.ts` 那些全部复用）。
 *
 * ## ⚠️ 消息通道：两条 chrome 路都不通，只能走 postMessage（2026-11-10 真机，两轮修正）
 *
 * 这一节是根据**两次真机失败**改的。原始推断错了两轮，保留经过以便后人不再踩：
 *
 * | 尝试 | 结果 | 原因 |
 * | --- | --- | --- |
 * | `chrome.runtime.sendMessage` | ❌ 拿不到应答 | 从 content script 发出时只到 background / popup / options，**到不了同页 content script** |
 * | `chrome.tabs.sendMessage(tabId, …)` | ❌ 拿不到应答 | MDN：发送方必须是 **privileged script**（background / popup / options）。**content script 不是 privileged**，发不出去 |
 * | **`window.postMessage`** | ✅ | 两个 content script **同页共享一个 `window`** |
 *
 * 真机症状（BV1jt421t7XH）：画质 Tab 只有胶囊、**没有解锁卡**，等 15 秒也不出现；
 * 而同期 snapshot 桥（同页 `content.ts` 实例）能拿到完整数据 —— **数据在，只是问不到**。
 *
 * ### 为什么 `page-state-client.ts` 能用 `tabs.sendMessage`
 *
 * 因为它**跑在 popup / options 里**（privileged），条件与面板不同。**照抄会失败。**
 *
 * ### `tabs.getCurrent()` 这条路已废弃
 *
 * 拿到 tabId 也没用 —— 发不出去。已从实现里删掉，避免后人以为"再拿到 tabId 就行"。
 *
 * ### 面板自己绝不能监听 `page-summary`
 *
 * 本项目里只有 `entrypoints/content.ts` 监听它。**一旦面板也监听，
 * 就可能自己回给自己**，拿到一个永远是 null 的答案，
 * 而且连"没人应答（超时）"这个唯一能暴露问题的信号都会消失。
 * 若将来面板要监听，必须用 `reply` 里回带的一次性 id 去重。
 *
 * 也就是说现在**分开发**：
 *   - 三条 background 消息 → `runtime.sendMessage`
 *   - 当前页取流数据 → **`window.postMessage`**（见 `fetchPageStateViaPage`）
 *
 * ## 文件分成两半，边界是"有没有副作用"
 *
 * | 半边 | 内容 | 可测性 |
 * | --- | --- | --- |
 * | **纯函数**（本文件上半部分） | 输入 → 面板渲染模型 | jsdom 单测直接跑 |
 * | **取数**（下半部分） | `chrome.*` 调用、storage 读 | 靠单测注入 fake chrome |
 *
 * 这个切法与 `core/playinfo/summary-view.ts` 同一个理由：
 * **判据可测，"去哪拿"不可测**。把所有 `if` 都留在纯函数里。
 *
 * ## ⚠️ 不许编数据
 *
 * 非播放页（首页 / 直播）**没有取流数据**。画质 Tab 在这里必须如实说"未生效"。
 * `docs/02-ui-spec.md` §3 状态 5 的定稿是：非视频页**不渲染任何解释文字** ——
 * 用户已经知道自己在哪个页面。面板尺寸比 popup 大，但"不废话"的原则一样。
 */

import { describePopup, type PopupAccount, type PopupSnapshot } from '@core/ui/popup-state';
import type { AccountSummary } from '@shared/types/account';
import { describeUnlock, type UnlockSummary } from '@core/playinfo/summary-view';
import {
  normalizeCleanPreferences,
  type CleanOptions,
  type CleanPreferences,
} from '@/src/content/site-clean/clean-options';
import { readRawCleanOptions } from '@platform/storage/ui-prefs-store';
import { diag } from '@platform/storage/diag-store';
import type { StatBucket } from '@shared/types/stats';
import type { PageTracksView } from '@shared/types/playinfo';
import type { PrimaryCard } from '@shared/utils/primary-card';

// ─────────────────────────── 渲染模型 ───────────────────────────

/** 当前页是不是受支持的播放页。判据由调用方用 `parsePlayPage()` 算好传进来 */
export type PanelPageKind = 'play' | 'other';

/** 画质 Tab 要画什么 */
export interface QualityView {
  /** 胶囊文案（`已接管` / `已停用` / `未生效` …） */
  pill: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  /**
   * 胶囊下面那句解释。
   *
   * **`null` 表示不渲染** —— `not-video` / `stopped` 这两种状态本来就是
   * "用户看得懂结果"的情况，再补一句是把已经知道的事说一遍
   * （`describePopup()` 的 `line` 已经是可选的，这里原样透传，**不自己发明文案**）。
   */
  line: string | null;
  /**
   * 解锁画质卡。**`null` 时整块不渲染**。
   *
   * 三种 `null` 来源：非播放页 / 总开关关着 / 取流数据还没到
   * （后者由 `describeUnlock()` 返回「等待取流…」而不是 null，所以实际只有前两种）。
   */
  unlock: UnlockSummary | null;
  /** 总开关开着吗。`null` = 读不到 `proxy/status`（此时开关显示为不可操作） */
  proxyEnabled: boolean | null;
  /** 当前页是不是播放页 —— 决定画质区显不显示 */
  pageKind: PanelPageKind;
}

/** 账号 Tab 的双卡 */
export interface AccountView {
  primary: PrimaryCard;
  /**
   * 播放账号摘要（**不含凭据**）。`null` = 没配置或读不出资料。
   *
   * ⚠️ 凭据健康状态**就在这里面**（`healthy` / `checkedAt` / `reason` 三个扁平字段，
   * 见 `PopupAccount`），不需要另开一个 `health` 对象 —— 那是同两份数据。
   */
  playback: PopupAccount | null;
  /** 读不到 `account/summary` 时为 `true`，UI 要区分"没配"与"没读到" */
  unknown: boolean;
  /** 凭据在不在（`proxy/status.hasCredential`，同步硬证据） */
  hasCredential: boolean;
  needsLogin: boolean;
}

/** 面板的完整渲染模型 */
export interface PanelModel {
  quality: QualityView;
  /** 净化偏好。`null` = 还没读出来 */
  clean: CleanPreferences | null;
  account: AccountView;
  /** 当前页类型，供净化 Tab 判断"适不适用" */
  pageKind: PanelPageKind;
  /**
   * 取流数据的**通道结局**（`PageStateOutcome.kind`）。
   *
   * ## 为什么把它放进模型（2026-11-10 真机教训）
   *
   * 播放页 + 拿不到 `pageView` 有**两种截然不同的原因**：
   *
   * | 结局 | 含义 | 用户该做什么 |
   * | --- | --- | --- |
   * | `not-ready` | 同页 content 在、数据还没到 | **等一下** |
   * | `no-content-script` / `timeout` | 没人答 / 超时 | **功能没生效** |
   *
   * 而这两种在旧实现里**都画成"没有解锁卡"**，用户和排查者都分不出 ——
   * 这一轮真机就是因此猜了两次。
   *
   * ⚠️ 注意：**只有播放页**才有"等数据"这回事。首页 / 直播页本来就没有取流，
   * 那里 `not-ready` 不该显示占位卡（那会让用户等一个永远不会来的东西）。
   * 所以占位只在 `pageKind === 'play'` 时出现，见 `buildQualityView`。
   */
  pageStateKind: PageStateOutcome['kind'];
  /**
   * 面板**手里那份**取流数据（`null` = 本页没有 / 没拿到）。
   *
   * ## 为什么要留在模型里（阶段 3 加）
   *
   * 诊断浮层要调 `collectFacts({ pageView })`。那个参数区分三态：
   * `undefined` = "你去查标签页"、`null` = "本页就是没有"、对象 = "用这份"。
   *
   * 面板**必须传** `null` 或对象，**绝不能传 `undefined`** ——
   * 后者会让 `collectFacts` 用 `chrome.tabs.query` 找到**别的**视频标签页，
   * 于是诊断页显示另一页的数据（或"打开任意视频页后可见"）。
   *
   * 所以模型必须保留原始 view，不能只留 `describeUnlock()` 的产出。
   */
  pageView: PageTracksView | null;
}

// ─────────────────────────── 纯函数 ───────────────────────────

/** 组装画质 Tab */
export function buildQualityView(input: {
  /** `describePopup()` 的产物；`null` = 拿不到 `proxy/status` */
  view: { pill: string; tone: 'neutral' | 'good' | 'warn' | 'bad'; line?: string } | null;
  /** `describeUnlock()` 的结果 */
  unlock: UnlockSummary | null;
  proxyEnabled: boolean | null;
  pageKind: PanelPageKind;
  /** 取流通道的结局，见 `PanelModel.pageStateKind` */
  pageStateKind: PageStateOutcome['kind'];
}): QualityView {
  const { view, unlock, proxyEnabled, pageKind, pageStateKind } = input;

  /**
   * ## 非播放页：连解锁卡都不给
   *
   * 非播放页没有取流数据，画一张"等待取流…"的卡等于让用户一直等一个不会来的东西。
   * 这是「不许编数据」在面板上的落地。
   */
  if (pageKind !== 'play') {
    return {
      pill: view?.pill ?? '未知',
      tone: view?.tone ?? 'neutral',
      line: view?.line ?? null,
      unlock: null,
      proxyEnabled,
      pageKind,
    };
  }

  /**
   * ## 播放页 + 通道在但没数据 → 显示「等待取流…」
   *
   * `describeUnlock()` 只在**拿到 view** 时才返回「等待取流…」（`playback` 为 null 那条分支）。
   * 但 `pageView` 整体为 null（通道断了）时它直接返回 null，于是 UI 上什么都不画 ——
   * 而"等着"和"断了"看起来一样，这正是本轮真机排查卡住的地方。
   *
   * 所以这里补一个**如实的占位**：`not-ready` = 内容脚本在、数据还没到 → 说"等待"。
   * 其余非 ok 结局（`no-content-script` / `timeout`）**不摆占位**：
   * 那是"通道不通"，摆一个"等待中"等于骗用户继续等。
   *
   * ⚠️ 占位的标题/锚点都取自 `describeUnlock` 已有的语义，**不新造文案**。
   */
  const unlockForPage =
    unlock ??
    (pageStateKind === 'not-ready'
      ? {
          // 与 describeUnlock 的 `!playback` 分支同一句话（02-ui-spec §2.3 六种标题之一）
          title: '等待取流…',
          badges: [],
          anchor: '主账号基线未知',
          improved: false,
        }
      : null);

  return {
    pill: view?.pill ?? '未知',
    tone: view?.tone ?? 'neutral',
    line: view?.line ?? null,
    unlock: unlockForPage,
    proxyEnabled,
    pageKind,
  };
}

/**
 * `AccountSummary`（消息形状，**嵌套**）→ `PopupAccount`（UI 形状，**扁平**）。
 *
 * ## 为什么必须显式映射（2026-11-10 真机假警报）
 *
 * 两种形状**不同**：
 *
 * | 字段 | `AccountSummary` | `PopupAccount` |
 * | --- | --- | --- |
 * | 昵称 | `profile.uname` | `uname` |
 * | mid | `profile.mid` | `mid` |
 * | 头像 | `profile.avatarUrl` | （未用） |
 * | 会员档 | `vipLabel` | `vipLabel` |
 * | 到期 | `expireAt` | `expireAt` |
 * | **健康** | **`health.healthy`** | **`healthy`** |
 * | **校验时刻** | **`health.checkedAt`** | **`checkedAt`** |
 * | **异常原因** | **`health.reason`** | **`reason`** |
 *
 * 原来面板用 `as` 把前者断言成后者（**编译器不校验 `as` 的字段**），
 * 于是 `healthy` 是 `undefined` → 假警报「凭据异常」。
 *
 * ⚠️ 这段映射 popup 里原本就有（`popup/main.tsx` 的 `refresh()`），
 * popup 瘦身后那段被删了，面板重写时漏掉 —— 现在是**唯一一份**，别在别处再抄。
 *
 * ⚠️ 字段用了可选链：真实应答里 `health` 一定在，但**测试与老版本 background**
 * 可能缺。缺了就当"未知"（`healthy: false` 都不给，让 `describeHealth` 走未知分支），
 * **不要默认 `true`** —— 那会把"读不到"谎报成"健康"。
 */
export function toPopupAccount(s: AccountSummary | null | undefined): PopupAccount | null {
  if (!s) return null;
  return {
    uname: s.profile?.uname ?? '',
    mid: s.profile?.mid ?? 0,
    vipLabel: s.vipLabel,
    expireAt: s.expireAt ?? null,
    /**
     * ⚠️ 这里**不能**写 `?? true` 或 `?? false`：
     * - `?? true` → 读不到时报"健康"，是谎报
     * - `?? false` → 读不到时报"异常"，正是本次要修的假警报
     *
     * 缺字段时**原样传 `undefined`**，让 `describeHealth` 的严格判据走"未知"分支。
     * 类型上 `AccountHealth.healthy` 是必填，所以正常路径不会是 `undefined`;
     * 这一句防的是"老版本 background / 测试造的数据"。
     */
    healthy: s.health?.healthy as boolean,
    checkedAt: s.health?.checkedAt ?? 0,
    reason: s.health?.reason ?? null,
  };
}

/**
 * 把 `proxy/status` / `account/summary` / `stats/recent` 三条应答拼成 `PopupSnapshot`。
 *
 * ## 为什么复用 `PopupSnapshot` 而不是新定义一个模型
 *
 * `describePopup()` 吃的是 `PopupSnapshot`，而它的判据（尤其是"凭据失效 vs 探测不确定"
 * 那一组边界）有真机踩出来的注释。**在面板里重写一份判据 = 把那些 bug 重犯一遍。**
 *
 * 所以面板只负责"取三条消息 → 拼成同一个形状 → 交给同一个函数"。
 *
 * @param replies 三条应答，任一失败传 `null`
 * @param pageKind 当前页类型
 */
export function buildPopupSnapshot(input: {
  proxy: { enabled: boolean; hasCredential: boolean; ruleCount: number } | null;
  account: { configured: boolean; account: PopupAccount | null } | null;
  buckets: StatBucket[];
  pageKind: PanelPageKind;
}): PopupSnapshot | null {
  const { proxy, account, buckets, pageKind } = input;

  // `proxy/status` 都拿不到：`describePopup()` 没法判，如实返回 null
  if (!proxy) return null;

  return {
    proxy,
    /**
     * 与 `popup/main.tsx` 同一判据：两个来源任一为真就算已配置。
     * 一个看密文在不在（同步、不依赖网络），一个看资料能不能读出来。
     */
    configured: (account?.configured ?? false) || proxy.hasCredential,
    account: account?.account ?? null,
    buckets,
    page: pageKind === 'play' ? { kind: 'play' } : { kind: 'other' },
  };
}

/**
 * 把"取到的原始材料"组装成面板模型 —— **唯一的组装入口**。
 *
 * 判据全部委托给既有纯函数（`describePopup` / `describeUnlock`），
 * 本函数只做拼装，**不自己发明任何新判断**。
 */
export function buildPanelModel(input: {
  snapshot: PopupSnapshot | null;
  pageView: PageTracksView | null;
  primary: PrimaryCard;
  clean: CleanPreferences | null;
  pageKind: PanelPageKind;
  /** `account/summary` 的应答是否拿到了（区分"没配置"与"没读到"） */
  accountKnown: boolean;
  /** 取流通道的结局（区分"等数据"与"通道断了"） */
  pageStateKind: PageStateOutcome['kind'];
}): PanelModel {
  const { snapshot, pageView, primary, clean, pageKind, accountKnown, pageStateKind } = input;

  const view = snapshot ? describePopup(snapshot) : null;

  /**
   * ⚠️ `describeUnlock()` 的第二个参数是"开关是否开着"，**默认 `true`**。
   *
   * 这里必须显式传 `snapshot?.proxy.enabled !== false`：
   * 不传的话，用户关掉总开关后画质卡仍然会渲染
   * 「主账号基线未知（本页没有 SSR 数据）」—— 而那时根本没在代理，
   * 那行字描述的是一个不存在的东西。这条在 `summary-view.ts` 里有完整的现场记录。
   */
  const unlock = describeUnlock(pageView, snapshot?.proxy.enabled !== false);

  const quality = buildQualityView({
    view,
    unlock,
    proxyEnabled: snapshot ? snapshot.proxy.enabled : null,
    pageKind,
    pageStateKind,
  });

  return {
    quality,
    clean,
    account: {
      primary,
      playback: snapshot?.account ?? null,
      unknown: snapshot === null || !accountKnown,
      hasCredential: snapshot?.proxy.hasCredential ?? false,
      needsLogin: view?.needsLogin ?? false,
    },
    pageKind,
    pageStateKind,
    pageView,
  };
}

// ─────────────────────────── 净化开关的读—改—写 ───────────────────────────

/**
 * **一次只改一个布尔项，其余原样带回**。
 *
 * ## ⚠️ 为什么不能直接 `{...options, [key]: next}` 就写回去
 *
 * `writeCleanOptionFlags()` 是**整块覆盖**（见 `ui-prefs-store.ts` 的注释），
 * 它收到什么就写什么。所以"改一个键"这个动作天然要求调用方**先拿到完整集合**。
 *
 * 本函数把那条纪律变成代码形状：**输入完整 options，输出完整 options，差恰好一个键**。
 * 调用方拿不到 `options` 时根本调不了它（类型上要求非 null），
 * 于是"某处只写了一个键"在类型层就写不出来。
 *
 * ## 为什么 `adDebug` 需要特殊提示
 *
 * `adDebug` 与 `adEnabled` 是**两个独立布尔**，但 `resolveAdRenderMode()` 让
 * 调试模式优先于隐藏：`adEnabled=true` + `adDebug=true` 的结果是**不隐藏**。
 * 用户看到"删除广告"开着却没效果，会以为功能坏了。
 *
 * 所以这里只**推导**一个提示，不改写值 —— 改写值会让"我明明开了调试"变成"我的勾没了"。
 *
 * @returns 新集合（**不含** hideCategories —— 那是另一份写入，见 `writeCleanHideCategories`）
 */
export function patchCleanOption<K extends keyof CleanOptions>(
  current: CleanOptions,
  key: K,
  next: CleanOptions[K],
): CleanOptions {
  return { ...current, [key]: next };
}

/**
 * 开 `adDebug` 时，告诉 UI 一句"现在不会隐藏广告"。
 *
 * `null` = 不需要提示。判据与 `resolveAdRenderMode()` 一致（调试优先于隐藏），
 * 但这里**只产出文案**，不改任何值 —— 见 `patchCleanOption` 的注释。
 */
export function describeAdDebugCaveat(options: CleanOptions): string | null {
  if (!options.adEnabled || !options.adDebug) return null;
  return '调试模式开着：广告不会被隐藏，只会用红框标出。';
}

/**
 * **切换一个分类**（多选集合）。
 *
 * 与布尔项同一个纪律：输入完整集合、输出完整集合。分类**必须**保持去重 ——
 * 重复项会让 `buildHomeCleanCss()` 生成重复规则（无害但脏）。
 */
export function toggleHideCategory(current: readonly string[], cat: string, on: boolean): string[] {
  const set = new Set(current);
  if (on) set.add(cat);
  else set.delete(cat);
  return [...set];
}

// ─────────────────────────── 取数（有副作用，靠注入 fake chrome 单测） ───────────────────────────

/**
 * 取当前页取流数据时的四种结局。
 *
 * ## 为什么要把它们分开（2026-11-10 真机修正后新增）
 *
 * 原来的实现对 `page/summary:get` 只做 `.catch(() => null)` ——
 * 于是**三种完全不同的情况被归并成同一个 `null`**：
 *
 * | 真实情况 | 归并后 | 该做什么 |
 * | --- | --- | --- |
 * | 没有 `content.ts`（首页 / 直播页，或扩展刚重载页面是旧的） | `null` | 什么都不做（非播放页本来就没有） |
 * | `content.ts` 在但还没报到（`page/summary:none`） | `null` | **稍后重取** |
 * | 通道用错了（用 `runtime` 而不是 `tabs`） | `null` | **这是 bug** |
 *
 * 第三行就是真机抓到的那个 bug —— 它和前两种混在一起，所以
 * **UI 看不出来、单测也验不出来**，藏了两轮才被真机冒烟发现。
 *
 * 现在分开发：`kind` 至少让"为什么是 null"可辨，`fetchPageState` 的返回值可以断言。
 * UI 目前仍然只消费 `view`（三种 null 的表现都是"不渲染卡"），
 * 但**测试与将来排查**能分清。
 */
export type PageStateOutcome =
  | { kind: 'ok'; view: PageTracksView }
  /** 同页没有 `content.ts` 应答（非播放页 / 页面比扩展旧） */
  | { kind: 'no-content-script' }
  /** `content.ts` 在，但 `pageState.view()` 还是 null（还没报到） */
  | { kind: 'not-ready' }
  /** 等超时了 —— **无法区分**"没人在听"与"在听但很慢" */
  | { kind: 'timeout' };

/**
 * 通过 `window.postMessage` 问**同页的 `content.ts`** 要当前页取流数据。
 *
 * ## 为什么必须走 postMessage（2026-11-10 真机，两轮修正后的最终结论）
 *
 * `content.ts` 与 `content-panel.content.ts` 是同一个标签页里的**两个 content script**，
 * 共享同一个 `window`。两条 chrome 通道都不通，各有明确原因：
 *
 * | 通道 | 为什么不行 |
 * | --- | --- |
 * | `chrome.runtime.sendMessage` | 从 content script 发出时只到 background / popup / options，**到不了同页 content script** |
 * | `chrome.tabs.sendMessage` | MDN：发送方必须是 **privileged script**（background / popup / options）。**content script 不是 privileged**，发不出去 |
 *
 * 两者都表现为"拿不到应答"，于是画质 Tab 只有胶囊、没有解锁卡 ——
 * 而同期 snapshot 桥能拿到完整数据。**数据在，只是问不到。**
 *
 * 项目里 `page-state-client.ts` 用 `tabs.sendMessage` 是对的，因为**它跑在 popup/options 里**
 * （privileged）。面板跑在 content script 里，条件不同，不能照抄。
 *
 * ## 为什么必须带超时
 *
 * `postMessage` 是**单向广播**：没有"对方不存在"的概念，发包本身永不失败。
 * 所以没有超时就会永远挂住。超时归到 `timeout` 而不是 `no-content-script` ——
 * 因为我们**确实分不清**"没人在听"和"在听但慢"。
 *
 * ## 为什么不会被自己收到
 *
 * 本项目里只有 `content.ts` 监听 `page-summary`（`entrypoints/content.ts`），
 * 面板**不监听**它，所以不会自己回自己。
 * 若将来面板要监听，必须用 `reply` 里回带的一次性 id 去重，否则会自激。
 *
 * ## 安全边界
 *
 * 只读、不含凭据、无写操作 —— 完整说明写在接收侧
 * （`entrypoints/content.ts` 那个 `page-summary` 分支的注释里，**改之前先读**）。
 *
 * @param timeoutMs 等待上限。默认 2000ms：面板是交互界面，超过 2 秒用户已经在怀疑"没反应"了。
 */
export function fetchPageStateViaPage(timeoutMs = 2000): Promise<PageStateOutcome> {
  return new Promise<PageStateOutcome>((resolve) => {
    let settled = false;

    const finish = (out: PageStateOutcome): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      void diag('panel/page-state', `kind=${out.kind}`).catch(() => {});
      resolve(out);
    };

    const onMessage = (ev: MessageEvent): void => {
      const d = ev.data as { __ns?: string; type?: string; view?: unknown } | null;
      if (!d || d.__ns !== PAGE_NS || d.type !== 'page-summary-reply') return;

      /**
       * ⚠️ 只认形状正确的 view。`null` 也认（= "我在，但还没数据" → `not-ready`），
       * 因为那是 `content.ts` 明确表达"content 在、数据没有"的唯一方式，
       * 与"没人应答（超时）"是不同的结局。
       */
      const v = d.view as PageTracksView | null | undefined;
      if (v && typeof v === 'object' && typeof v.pageKey === 'string') {
        finish({ kind: 'ok', view: v });
        return;
      }
      finish({ kind: 'not-ready' });
    };

    const timer = window.setTimeout(() => {
      finish({ kind: 'timeout' });
    }, timeoutMs);

    window.addEventListener('message', onMessage);
    window.postMessage({ __ns: PAGE_NS, type: 'page-summary' }, '*');
  });
}

/**
 * 跨 world 通信的命名空间，**必须与 `entrypoints/content.ts` 的 `NS` 一致**。
 *
 * 那边是 `const NS = '__PLUMA__'`（模块内私有），这里是第二个副本 ——
 * 两处漂移会让整条桥静默失效（发出去没人认，或者认了不同名）。
 * `entrypoints/content.ts` 里那条注释互相指向对方，改一处必须改另一处。
 */
const PAGE_NS = '__PLUMA__';

/**
 * 从 background 与同页 content script 取数。
 *
 * ## 四条消息，**全部复用现有类型**（没有新增）
 *
 * | 消息 | 通道 | 谁答 | 拿到时 |
 * | --- | --- | --- | --- |
 * | `proxy/status` | `runtime` | background | 总开关 / 凭据 / 规则数 |
 * | `account/summary` | `runtime` | background | 播放账号摘要 |
 * | `stats/recent` | `runtime` | background | 成功率统计 |
 * | `page/summary:get` | **`tabs`** | **同页的 `content.ts`** | 当前页取流数据 |
 *
 * ⚠️ 前三条与第四条**通道不同**，这是本文件最容易再写错的地方。
 * 规则见文件头那张表：`runtime` 到不了同页 content script。
 *
 * ## 为什么每条都单独 `.catch(() => null)`
 *
 * 面板是**常驻页面的 UI**，任何一条消息失败（SW 冷启动、扩展刚重载）
 * 都不该让整个面板报错消失。缺哪条就降级哪一块：
 *
 * | 缺哪条 | 面板表现 |
 * | --- | --- |
 * | `proxy/status` | 总开关禁用 + 画质区显示「未知」（`snapshot` 为 null） |
 * | `account/summary` | 账号卡降级，但**不谎报"未配置"**（`accountKnown: false`） |
 * | `stats/recent` | 没有统计，不影响任何判据（样本不足时 `describePopup` 不下降级结论） |
 * | `page/summary:get` | 非播放页 / 超时 → 画质卡不渲染（播放页会在 `not-ready` 时摆占位） |
 *
 * ⚠️ 四条**并行**发：串行会让面板慢四倍，而用户点开面板只想看一眼。
 */
export async function fetchPanelReplies(): Promise<{
  proxy: { enabled: boolean; hasCredential: boolean; ruleCount: number } | null;
  account: { configured: boolean; account: PopupAccount | null } | null;
  buckets: StatBucket[];
  pageState: PageStateOutcome;
}> {
  const [proxyRes, acctRes, statsRes, pageState] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'proxy/status' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'account/summary' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'stats/recent' }).catch(() => null),
    // ⚠️ `window.postMessage`，**不是** `runtime` / `tabs` —— 见 `fetchPageStateViaPage`
    fetchPageStateViaPage(),
  ]);

  const p = proxyRes as {
    type?: string;
    enabled?: boolean;
    hasCredential?: boolean;
    ruleCount?: number;
  } | null;
  const a = acctRes as {
    type?: string;
    configured?: boolean;
    /**
     * ⚠️ **`AccountSummary`，不是 `PopupAccount`**（2026-11-10 真机假警报的根因）
     *
     * 这里原本写的是 `account?: PopupAccount | null`，而 `account/summary` 实际返回
     * 的是 `AccountSummary` —— 两者**形状不同**：
     *
     * | 字段 | `AccountSummary` | `PopupAccount` |
     * | --- | --- | --- |
     * | 昵称 | `profile.uname` | `uname` |
     * | mid | `profile.mid` | `mid` |
     * | 健康状态 | **`health.healthy`** | **`healthy`** |
     * | 到期 | `expireAt` | `expireAt` |
     *
     * 因为这是 `as` 断言（**编译器不校验字段**），错配在编译期完全看不出来。
     * 真机后果：`account.healthy` 是 `undefined` → 假警报「凭据异常」。
     *
     * 所以这里必须声明成真实形状，并显式映射（见 `toPopupAccount()`）。
     */
    account?: AccountSummary | null;
  } | null;
  const s = statsRes as { type?: string; buckets?: StatBucket[] } | null;

  return {
    proxy:
      p?.type === 'proxy/status:ok'
        ? {
            enabled: p.enabled === true,
            hasCredential: p.hasCredential === true,
            ruleCount: typeof p.ruleCount === 'number' ? p.ruleCount : 0,
          }
        : null,
    account:
      a?.type === 'account/summary:ok'
        ? { configured: a.configured === true, account: toPopupAccount(a.account) }
        : null,
    buckets: s?.type === 'stats/recent:ok' && Array.isArray(s.buckets) ? s.buckets : [],
    pageState,
  };
}

/**
 * 面板的**完整取数流程**：消息 + storage，一次拿齐。
 *
 * ## `pageView` 由本函数自己拿，不由调用方传
 *
 * 面板自己用 `tabs.sendMessage` 定向问同页的 `content.ts`（见 `fetchPageState`）。
 * 入口**不需要**先算好一份 pageView 再传进来 ——
 * 那样反而会诱使入口去 import `content.ts` 的东西（跨实例，拿不到）。
 *
 * @param pageKind 当前页类型（由入口用 `parsePlayPage()` 算好传入 ——
 *   面板自己不判 URL，那样会在 `check-page-gate` 里多出一份手写判据）
 * @param primary 主账号卡片原料（由入口用 `resolvePrimaryCard()` 算好）
 */
export async function loadPanelModel(input: {
  pageKind: PanelPageKind;
  primary: PrimaryCard;
}): Promise<PanelModel> {
  const { pageKind, primary } = input;

  const [replies, rawClean] = await Promise.all([fetchPanelReplies(), readRawCleanOptions()]);

  const clean = normalizeCleanPreferences(rawClean);
  const snapshot = buildPopupSnapshot({
    proxy: replies.proxy,
    account: replies.account,
    buckets: replies.buckets,
    pageKind,
  });

  return buildPanelModel({
    snapshot,
    /**
     * 四种 `PageStateOutcome` 里只有 `ok` 有数据。
     * 但**结局本身要传下去**：`not-ready`（等数据）与 `no-content-script`（通道断）
     * 在播放页的表现**必须不同**，否则用户和排查者都分不清该不该等 —— 见 `pageStateKind`。
     */
    pageView: replies.pageState.kind === 'ok' ? replies.pageState.view : null,
    pageStateKind: replies.pageState.kind,
    primary,
    clean,
    pageKind,
    accountKnown: replies.account !== null,
  });
}
