/**
 * 账号相关类型。
 *
 * 分层铁律（AGENTS.md §4.2）：`Credential` 只在 background 与 core 之间流动，
 * **绝不下发给 content script / popup / options**。UI 只能拿 `AccountSummary`。
 */

/** 主账号不归扩展管理（Q7），所以这里只有播放账号需要完整类型 */
export type AccountRole = 'primary' | 'playback';

/**
 * 播放账号的登录凭据。
 *
 * ⚠️ 绝不下发给 UI
 * ⚠️ 绝不写入日志、绝不进错误详情
 */
export interface Credential {
  /** httpOnly cookie，只能由 background 持有 */
  sessdata: string;
  /** CSRF token，POST 类接口需要 */
  biliJct: string;
  /** 账号 UID，同时用于校验 sessdata 与 biliJct 是否同源 */
  dedeUserId: string;
}

export type VipLabel = 'none' | 'monthly' | 'annual';

export interface AccountProfile {
  mid: number;
  uname: string;
  avatarUrl: string | null;
}

export interface AccountHealth {
  healthy: boolean;
  /** Unix ms */
  checkedAt: number;
  reason: string | null;
}

/** 下发给 UI 的账号视图，**不含任何凭据字段** */
export interface AccountSummary {
  profile: AccountProfile;
  vipLabel: VipLabel;
  /** Unix ms；非会员为 null */
  expireAt: number | null;
  health: AccountHealth;
}

/** 内部完整账号（含凭据），只在 background 内使用 */
export interface PlaybackAccount {
  credential: Credential;
  summary: AccountSummary;
}
