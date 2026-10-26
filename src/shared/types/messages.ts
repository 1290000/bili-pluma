/**
 * 跨环境消息协议。
 *
 * 用**判别联合**：新增消息若没在 switch 里处理，`assertNever` 会在编译期报错。
 * 文档：docs/protocols/messages.md（以本文件为准，文档从代码抄）
 *
 * 纪律：任何 `*:ok` 消息都**不得携带凭据**（见 AGENTS.md §4.2）。
 * `qr/poll:ok` 只回报"存了没"，不回传内容。
 */

import type { AccountSummary } from './account';
import type { ErrorCode } from './errors';
import type { QrLoginStatus } from './login';
import type { PlayInfo } from './playinfo';
import type { StatBucket } from './stats';

/** 这次请求用的是哪个身份 */
export type Identity = 'primary' | 'playback';

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
  /** 用**播放账号**身份取一次 playurl（options 体检表用） */
  | { type: 'playinfo/get'; bvid: string; cid: number; qn: number | null }
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
      bvid: string;
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
  | { type: 'playinfo/get:ok'; info: PlayInfo; via: Identity }
  | { type: 'playinfo/get:err'; code: ErrorCode; detail: string | null }
  | { type: 'qr/generate:ok'; qrContent: string; qrcodeKey: string }
  | { type: 'qr/generate:err'; detail: string }
  /** credentialSaved：凭据是否已读入并落库。**不回报凭据内容** */
  | { type: 'qr/poll:ok'; status: QrLoginStatus; credentialSaved: boolean }
  | { type: 'qr/poll:err'; detail: string }
  /** 页面代理是否已装规则。**不回报 Cookie** */
  | {
      type: 'page/activate:ok';
      activated: boolean;
      reason: 'ok' | 'not-configured' | 'same-account' | 'error';
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

/** 穷举检查：任何未处理的分支都会在这里编译失败 */
export function assertNever(value: never): never {
  throw new Error(`未处理的消息类型: ${JSON.stringify(value)}`);
}
