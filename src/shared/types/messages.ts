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

/** 这次请求用的是哪个身份 */
export type Identity = 'primary' | 'playback';

/**
 * UI / content → background
 *
 * ⚠️ 标注 `【P2 预留】` 的两条**当前无处理方**，是给 popup / options 用的占位。
 * 加处理方之前不要从 UI 调用，否则消息会永远悬着。
 */
export type RequestMsg =
  /** 【P2 预留】popup 显示账号摘要（不含凭据） */
  | { type: 'account/summary' }
  /** 【P2 预留】options 页的画质体检：用主账号身份取一次 playurl 做对比 */
  | { type: 'playinfo/get'; bvid: string; cid: number; qn: number | null }
  | { type: 'qr/generate' }
  | { type: 'qr/poll'; qrcodeKey: string }
  /** 请求打开登录窗口（走 InPrivate 分区，不污染主账号） */
  | { type: 'login/open' }
  /** 查询总开关状态 */
  | { type: 'proxy/status' }
  /** 切换总开关。关闭 = 删掉所有规则，所有请求回退主账号身份 */
  | { type: 'proxy/set'; enabled: boolean }
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
    };

/** background → UI / content */
export type ResponseMsg =
  | { type: 'account/summary:ok'; account: AccountSummary | null }
  | { type: 'account/summary:err'; code: ErrorCode; detail: string | null }
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
   * `incognito-disabled` 时 UI 要告诉用户去勾选「在 InPrivate 中允许」。
   */
  | {
      type: 'login/open:ok';
      opened: boolean;
      reason?: 'incognito-disabled' | 'already-open' | 'unknown';
    }
  /**
   * 总开关状态。**不回报 Cookie**。
   * `hasCredential` 与 `enabled` 分开：可能有凭据但用户关掉了开关。
   */
  | { type: 'proxy/status:ok'; enabled: boolean; hasCredential: boolean; ruleCount: number }
  | { type: 'proxy/set:ok'; enabled: boolean }
  | { type: 'proxy/set:err'; detail: string };

export type Msg = RequestMsg | ResponseMsg;

/** 穷举检查：任何未处理的分支都会在这里编译失败 */
export function assertNever(value: never): never {
  throw new Error(`未处理的消息类型: ${JSON.stringify(value)}`);
}
