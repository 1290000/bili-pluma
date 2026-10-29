/**
 * 跨环境消息协议。
 *
 * 用**判别联合**定义：成功与失败靠 `type` 的 `:ok` / `:err` 后缀区分。
 *
 * ⚠️ **漏处理一条消息，`tsc` 不会报错。** 分发处（`entrypoints/background.ts`）用的是
 * `if (type === '...')` 链而不是 `switch`，判别联合的穷举能力用不上。
 * 真正的防线是 `scripts/check-messages.mjs`（比对类型定义与路由分支），已在 `verify` 链里。
 * 下面这个 `assertNever` 目前**没有任何调用方**，留着是为了将来改写成 `switch` 时能直接用。
 *
 * 纪律：任何 `*:ok` 消息都**不得携带凭据**（见 AGENTS.md §5.2）。
 * `qr/poll:ok` 只回报"存了没"，不回传内容。
 */

import type { AccountSummary } from './account';
import type { ErrorCode } from './errors';
import type { QrLoginStatus } from './login';
import type { PageTracksView } from './playinfo';
import type { StatBucket } from './stats';

/**
 * UI / content → background
 */
export type RequestMsg =
  /**
   * 账号摘要（不含凭据）。
   *
   * `recheck` 控制是否强制重新探测凭据：
   *   - `false` / 省略：惰性检查，健康记录新鲜就直接返回缓存
   *   - `true`：用户点了"重新检查"，或 popup 判断记录已过期
   *
   * 惰性检查的理由见 docs/04-project-structure.md §6「凭据健康检查：惰性，不用 alarms」。
   */
  | { type: 'account/summary'; recheck?: boolean }
  | { type: 'qr/generate' }
  | { type: 'qr/poll'; qrcodeKey: string }
  /** 请求打开登录窗口（走 InPrivate 分区，不污染主账号） */
  | { type: 'login/open' }
  /**
   * 退出播放账号：清凭据、关代理、清健康与统计。
   *
   * 三个一起清是有意的——留着"上次失效"的记录，下次打开会误导用户。
   */
  | { type: 'account/remove' }
  /** 查询总开关状态 */
  | { type: 'proxy/status' }
  /** 切换总开关。关闭 = 删掉所有规则，所有请求回退主账号身份 */
  | { type: 'proxy/set'; enabled: boolean }
  /**
   * 查"哪些已打开的视频页会因为总开关变化而失效"。
   *
   * 为什么需要它：playurl **只在页面加载和切 P 时调一次**（Q3 实测），
   * 已打开的视频页其画质早已锁定，改 DNR 规则对它无效——
   * 用户关了开关却没刷新，会以为开关坏了。UI 必须把这件事说出来。
   */
  | { type: 'proxy/affected-tabs' }
  /** 刷新这些标签页（用户点"全部刷新"时） */
  | { type: 'tabs/reload'; tabIds: number[] }
  /** 页面实际播放画质（诊断用）。height=0 表示只有 note 文本 */
  | { type: 'page/quality'; height: number; note?: string }
  /** content script 报到：这个标签页要代理 playurl */
  | {
      type: 'page/activate';
      /**
       * 页面类型。`pgc` = 番剧 / 国创 / 电影（ADR 0019）。
       *
       * 两类页面取流的接口不同（`/x/player/wbi/playurl` vs `/pgc/player/web/playurl`），
       * background 靠这个字段决定给标签页装哪条规则。
       */
      kind: 'video' | 'pgc';
      /** 视频页 = bvid；PGC 页 = `ep:3854821` / `ss:28747`。只用于日志与状态键 */
      pageKey: string;
      p: number;
      deviceCookies: Record<string, string>;
      /** 主账号 mid（从页面 cookie 读，普通分区）。null 表示未登录 */
      primaryMid: string | null;
    }
  /** 取最近 1 小时的取流成功率时序（popup「已降级」状态的条形图） */
  | { type: 'stats/recent' };
/** background → UI / content */
export type ResponseMsg =
  /**
   * 账号摘要。
   *
   * ## `configured` 与 `account` 是两个独立的事
   *
   * | configured | account | 含义 |
   * | --- | --- | --- |
   * | false | null | 从未配置过 → popup 显示「未配置」，引导扫码 |
   * | true | 有值 | 正常 → 显示昵称/会员/健康 |
   * | true | null | **已配置但探测不出资料**（首次探测就失败、缓存也没了） |
   *
   * 第三种如果只给 `account: null`，UI 会误判成「未配置」，
   * 于是引导用户去扫一个已经存在的账号——比不提示更糟。
   *
   * ⚠️ 不含任何凭据字段（`AccountSummary` 本身就排除了它们）。
   */
  | {
      type: 'account/summary:ok';
      configured: boolean;
      account: AccountSummary | null;
      needsRecheck: boolean;
    }
  | { type: 'account/summary:err'; code: ErrorCode; detail: string | null }
  /** 退出播放账号的结果 */
  | { type: 'account/remove:ok' }
  | { type: 'account/remove:err'; detail: string }
  | { type: 'qr/generate:ok'; qrContent: string; qrcodeKey: string }
  | { type: 'qr/generate:err'; detail: string }
  /** credentialSaved：凭据是否已读入并落库。**不回报凭据内容** */
  | { type: 'qr/poll:ok'; status: QrLoginStatus; credentialSaved: boolean }
  | { type: 'qr/poll:err'; detail: string }
  /** 页面代理是否已装规则。**不回报 Cookie** */
  | {
      type: 'page/activate:ok';
      activated: boolean;
      /**
       * `disabled` —— 总开关关着，**不装规则**（2026-10-27 新增）。
       *
       * 与 `not-configured` 不同：那时是还没配置账号；这里是用户主动关了开关。
       * 两者都不能算"取流失败"，`recordStat` 要区分对待，
       * 否则关掉开关会把统计打成一片红。
       */
      reason: 'ok' | 'not-configured' | 'same-account' | 'disabled' | 'error';
    }
  /**
   * 登录窗口是否打开成功。
   *
   * - `incognito-disabled` → 用户要去勾选「在 InPrivate 中允许」，且说明页已弹
   * - `already-open` → 窗口本来就在，已聚焦
   * - `assumed` → `windows.create` 返回 undefined 但权限正常，按已创建处理
   *   （split 模式下无痕窗口对本实例不可见，这是正常现象，不是失败）
   */
  | {
      type: 'login/open:ok';
      opened: boolean;
      reason?: 'incognito-disabled' | 'already-open' | 'assumed' | 'unknown';
    }
  /**
   * 总开关状态。**不回报 Cookie**。
   * `hasCredential` 与 `enabled` 分开：可能有凭据但用户关掉了开关。
   */
  | { type: 'proxy/status:ok'; enabled: boolean; hasCredential: boolean; ruleCount: number }
  | { type: 'proxy/set:ok'; enabled: boolean }
  | { type: 'proxy/set:err'; detail: string }
  /**
   * 受影响的视频标签页数。
   *
   * `count === 0` 时 UI 什么都不说——没有已打开的页面就不用提醒用户。
   */
  | { type: 'proxy/affected-tabs:ok'; count: number; tabIds: number[] }
  | { type: 'tabs/reload:ok'; reloaded: number }
  /**
   * 取流成功率时序。`buckets` 恒为 12 个连续窗口（无数据的桶 ok=fail=0）。
   * `rate` 为 null 表示样本数为 0——UI 要画灰而不是画红。
   */
  | { type: 'stats/recent:ok'; buckets: StatBucket[]; rate: number | null }
  | { type: 'stats/recent:err'; detail: string };

export type Msg = RequestMsg | ResponseMsg;

// ── content ↔ 扩展页面（popup / 诊断页）的**直连**查询 ──
//
// 为什么不走 SW：这份数据只对"当前这个标签页"有意义，而 content 本来就在那个页面里。
// 绕一圈到 SW 再回来，除了多一份要维护的缓存（和缓存过期问题）没有任何收益。
// 用 `chrome.tabs.sendMessage(tabId, …)` 直连，拿到的一定是最新的。
//
// ⚠️ 目标标签页没有 content script（不是视频页 / 还没注入）时，
// `sendMessage` 会**抛异常**而不是返回 `none` —— 调用方必须自己 catch。

/** 扩展页面 → content：要当前页的取流数据 */
export type PageQueryMsg = { type: 'page/summary:get' };

export type PageQueryReply =
  | { type: 'page/summary:ok'; view: PageTracksView }
  /** content 在，但还没报到（脚本刚注入、页面还没解析出 bvid） */
  | { type: 'page/summary:none'; reason: 'not-ready' };

/**
 * 页面 → content：要一份 **popup 渲染结果的完整快照**（给自动化/bsk 用）。
 *
 * ## 为什么需要它（2026-10-29）
 *
 * `chrome-extension://` 页面被 bsk 的 Agent Window sandbox 拒绝 `evaluate`，
 * 于是 popup 到底渲染成什么样**只能靠用户手点截图**。UI bug 因此只能靠肉眼，
 * 每个都要用户配合一轮，极慢。
 *
 * 这条消息把"popup 会渲染成什么"变成一段可读 JSON。
 *
 * ## 为什么挂在 content 侧，而不是 background
 *
 * 快照要三样东西：`describePopup()`（`core`，纯函数）、账号摘要（`background`）、
 * 当前页数据（`content` 独有）。**只有 content 侧能一次凑齐** ——
 * 它在页面里，能顺手向 background 转发一次 `account/summary`。
 *
 * 反过来（放 background）则要 background 反查活动标签页的 content，
 * 多一次往返，且 background 拿不到 `pageState`。
 *
 * ## ⚠️ 只读，且**不带凭据**
 *
 * `AGENTS.md §5.2`：任何 `*:ok` 消息都不得携带凭据。
 * 这里的账号部分只用 `AccountSummary` 级字段（uname / mid / vipLabel / expireAt / healthy），
 * **绝不带 SESSDATA / bili_jct / 完整 Cookie**。
 *
 * ## ⚠️ 不在 popup 的渲染路径上
 *
 * popup 仍然自己发 `proxy/status` + `account/summary` + `stats/recent` + `page/summary:get`。
 * 这条消息只给自动化用 —— 让 popup 依赖它会多一层调试代码，
 * 而且快照与真实渲染之间的偏差会变成新的 bug 来源。
 */
export type PageSnapshotMsg = { type: 'page/snapshot:get' };

/** `page/snapshot:get` 的应答。字段与 popup 的渲染输入一一对应 */
export interface PopupSnapshotReply {
  /**
   * 胶囊状态（`describePopup()` 的产出）。
   *
   * `null` 表示拿不到 `proxy/status`（SW 未就绪 / 上下文失效）——
   * 与 popup 的 `load.kind === 'error'` 同义。
   */
  view: {
    state: string;
    pill: string;
    tone: string;
    line?: string;
    needsLogin: boolean;
  } | null;
  /** 主账号卡片（**不含** mid 以外的任何标识性凭据） */
  primary: {
    uname: string | null;
    level: number | null;
    loggedIn: 'yes' | 'no' | 'unknown';
    source: 'live' | 'cached' | 'none';
    /** 没有昵称时 popup 实际会显示的那句话 */
    placeholder: string;
  };
  /** 播放账号摘要。`null` = 未配置或读不出来 */
  playbackAccount: {
    uname: string;
    mid: number;
    vipLabel: 'none' | 'monthly' | 'annual';
    expireAt: number | null;
    healthy: boolean;
  } | null;
  /** §2.3 画质区。`null` = 不是播放页 / 还没数据 / **总开关关着** */
  unlock: {
    title: string;
    badges: string[];
    anchor: string;
    improved: boolean;
  } | null;
  /** 当前页 */
  page: { kind: 'play' | 'other'; pageKey: string | null; p: number | null };
  /** 总开关与规则数，方便直接判"现在生效了吗" */
  proxy: { enabled: boolean; hasCredential: boolean; ruleCount: number };
  /** popup 会用到的全部"原始字符串"，方便断言文案 */
  texts: {
    /** 主账号栏那一行（昵称或占位文案） */
    primaryLine: string;
    /** 画质卡标题 + 锚点拼起来（`null` 表示不渲染画质卡） */
    unlockLine: string | null;
  };
}

export type PageSnapshotReply = { type: 'page/snapshot:ok'; snapshot: PopupSnapshotReply };

/**
 * 穷举检查工具 —— ⚠️ **当前没有任何调用方**（分发处用 `if` 链，不是 `switch`）。
 *
 * 保留它是为了将来把 `entrypoints/background.ts` 改写成 `switch` 时能直接接上。
 * **不要以为它已经在起作用**——现在的穷举保障来自 `scripts/check-messages.mjs`。
 */
export function assertNever(value: never): never {
  throw new Error(`未处理的消息类型: ${JSON.stringify(value)}`);
}
