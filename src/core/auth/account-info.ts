/**
 * 账号资料与会员信息的归一化 —— 纯函数，零 IO。
 *
 * ## 为什么需要它
 *
 * B站的 `nav` 接口（`/x/web-interface/nav`）同时承担两件事：
 *   1. **探活**：带某账号的凭据请求，`code === 0` 说明凭据有效，`-101` 说明失效
 *   2. **取资料**：返回 uname / mid / 头像 / 会员状态 / 到期日
 *
 * 两件事共用一次请求，所以放在同一个模块里。分层上它属于 `core/auth`：
 * 只有 `code` 的含义（`-101` = 未登录）是业务判断，属于 core；
 * 真正发请求在 `platform`，由注入的 `HttpClient` 完成。
 *
 * ⚠️ 本模块**不接触凭据**。凭据由调用方在请求头里带上，这里只处理响应。
 */

import type { AccountHealth, AccountSummary, VipLabel } from '@shared/types/account';

/**
 * B站 `nav` 的业务码。
 *
 * ⚠️ `-101` 是**唯一的"凭据失效"信号**。其他非 0 码（如 `-412` 风控、`-352`）
 * 都不代表凭据过期，不能据此让用户重新扫码。
 */
export const NAV_CODE = {
  /** 成功 */
  OK: 0,
  /** 账号未登录 / 凭据失效 */
  NOT_LOGGED_IN: -101,
} as const;

/** `nav` 响应的最小形状（只取我们用的字段，不做全量建模） */
export interface NavResponse {
  code: number;
  message?: string;
  data?: {
    isLogin?: boolean;
    mid?: number;
    uname?: string;
    face?: string;
    /** 1 = 有效，0 = 无 */
    vipStatus?: number;
    /** 1 = 月度大会员，2 = 年度大会员 */
    vipType?: number;
    /** Unix 秒；0 表示无到期 */
    vipDueDate?: number;
  };
}

/** 健康判定的输入：一次 nav 探测的结果 */
export interface NavProbe {
  /** HTTP 层是否拿到响应。false 表示网络失败 / 超时，**不是凭据问题** */
  reachable: boolean;
  /** 业务码。仅 `reachable` 为 true 时有意义 */
  code: number | null;
  data?: NavResponse['data'];
}

export type HealthVerdict =
  /** 凭据有效，账号是会员 */
  | { kind: 'healthy'; summary: AccountSummary }
  /** 凭据有效，但不是大会员 —— 代理装了也没用，必须如实告知 */
  | { kind: 'not-vip'; summary: AccountSummary }
  /** 确定失效（`-101`），需要重新扫码 */
  | { kind: 'expired'; reason: string }
  /** 网络不可达，无法判断。**不要当成失效** */
  | { kind: 'unknown'; reason: string };

/** 把 B站的两个 vipType 归一成 UI 用的三档 */
export function toVipLabel(vipStatus: number | undefined, vipType: number | undefined): VipLabel {
  if (vipStatus !== 1) return 'none';
  if (vipType === 2) return 'annual';
  if (vipType === 1) return 'monthly';
  // 有效但类型未知 —— 按月度处理，不夸大成年度
  return 'monthly';
}

/**
 * 把 `nav` 的 `data` 归一成下发给 UI 的摘要。
 *
 * 只有在 `mid` 有效时才可能返回摘要 —— 没有 mid 说明不是登录态，那是失效而不是"资料缺失"。
 *
 * @returns 摘要；`mid` 缺失时返回 null
 */
export function summarizeNav(data: NavResponse['data'], checkedAt: number): AccountSummary | null {
  const mid = data?.mid;
  if (typeof mid !== 'number' || !Number.isFinite(mid) || mid <= 0) return null;

  const vipLabel = toVipLabel(data?.vipStatus, data?.vipType);
  const dueDate = data?.vipDueDate;
  const expireAt =
    vipLabel !== 'none' && typeof dueDate === 'number' && dueDate > 0 ? dueDate * 1000 : null;

  const uname = typeof data?.uname === 'string' && data.uname.length > 0 ? data.uname : '(未知)';
  const face = typeof data?.face === 'string' && data.face.length > 0 ? data.face : null;

  return {
    profile: { mid, uname, avatarUrl: face },
    vipLabel,
    expireAt,
    health: { healthy: true, checkedAt, reason: null },
  };
}

/**
 * 判定一次探测的结论。
 *
 * ## 为什么要把"网络失败"和"凭据失效"分开
 *
 * 两者对用户的意义完全不同：
 *   - 网络失败：等一下就好，**不要**让用户重新扫码（重扫也解决不了）
 *   - 凭据失效：必须重扫，不重扫就一直拿不到高画质
 *
 * 把网络失败报成失效，会让用户在断网时白扫一次码，而且失去对提示的信任。
 *
 * @param probe 一次探测结果
 * @param checkedAt 探测时间戳（Unix ms），由调用方给，保证纯函数可测
 */
export function judgeNav(probe: NavProbe, checkedAt: number): HealthVerdict {
  if (!probe.reachable || probe.code === null) {
    return { kind: 'unknown', reason: '网络不可达，未能校验凭据' };
  }

  if (probe.code === NAV_CODE.NOT_LOGGED_IN) {
    return { kind: 'expired', reason: '账号未登录（-101）' };
  }

  if (probe.code !== NAV_CODE.OK) {
    // 既不是成功也不是未登录 —— 风控 / 限流 / 服务端异常，不能据此要求重扫
    return { kind: 'unknown', reason: `接口返回 code=${probe.code}` };
  }

  const summary = summarizeNav(probe.data, checkedAt);
  if (!summary) {
    // code=0 但拿不到 mid —— 数据形态变了。当未知处理，不当失效
    return { kind: 'unknown', reason: 'nav 未返回 mid' };
  }

  return summary.vipLabel === 'none' ? { kind: 'not-vip', summary } : { kind: 'healthy', summary };
}

/**
 * 判断"当前健康记录是否还新鲜"。
 *
 * 惰性检查的核心：不做定时任务，只在用户真的会看到时判断要不要重查。
 * 6 小时是权衡：太短会让 popup 每次打开都发请求；太长会让过期账号看起来仍健康。
 */
export const HEALTH_TTL_MS = 6 * 60 * 60 * 1000;

export function isHealthFresh(health: AccountHealth | null, now: number): boolean {
  if (!health) return false;
  if (typeof health.checkedAt !== 'number' || health.checkedAt <= 0) return false;
  return now - health.checkedAt < HEALTH_TTL_MS;
}
