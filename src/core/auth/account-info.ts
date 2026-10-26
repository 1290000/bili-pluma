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
    /**
     * 会员到期时间。
     *
     * ⚠️ **单位没有实测确认。** 这里的注释长期写"Unix 秒"，但 2026-10-26
     * 用户界面显示"698197 个月后到期"——反推 `expireAt ≈ 1.81e15`，
     * 即原始值 ≈ 1.81e12：按秒是 2084 年（不可能），按毫秒是 2027-05（合理）。
     * 所以真实单位**很可能是毫秒**，旧代码的 `* 1000` 多乘了一次。
     * 处理方式见 `dueDateToMs`。
     */
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
 * `vipDueDate` → 毫秒时间戳，**单位自适应**。
 *
 * 为什么不直接按秒：见 `NavResponse.vipDueDate` 的注释 —— 真实单位很可能是毫秒，
 * 旧代码固定 `* 1000` 会把 2027-05 的到期日显示成"69 万个月后到期"。
 *
 * 阈值取 `1e11`：
 *   - 任何合理的**秒**级时间戳都 < 1e10（1e10 秒 = 2286 年）
 *   - 任何 2000 年之后的**毫秒**时间戳都 > 1e11（1e11 ms = 1973 年）
 * 两者不重叠，所以判据稳定，不依赖"猜"。
 */
function dueDateToMs(value: number): number {
  return value >= 1e11 ? value : value * 1000;
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
    vipLabel !== 'none' && typeof dueDate === 'number' && dueDate > 0 ? dueDateToMs(dueDate) : null;

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

/**
 * 到期日的合理上限：**距今 100 年**。
 *
 * B站最长的大会员有效期就是个位数年，100 年宽到不可能误判真实数据，
 * 又窄到一定能抓住「多乘了 1000」这类量级错误（1.81e12 → 1.81e15 = 5 万年后）。
 */
const MAX_EXPIRE_AHEAD_MS = 100 * 365 * 86_400_000;

/**
 * 判定一个到期时间戳是否**明显算错了**（不可信）。
 *
 * ## 为什么需要它（2026-10-26 真实踩到）
 *
 * 修了 `vipDueDate` 的单位乘错之后，用户界面**仍然显示「57386 年后到期」**。
 * 原因不是代码没改对，而是**缓存是持久化的**：旧构建用 `* 1000` 算出
 * `expireAt = 1.81e15` 写进了 `storage.local`，新构建读的仍是这份脏数据。
 *
 * **改算法不等于修好，存量数据得自己失效。**
 *
 * ## 阈值取 100 年
 *
 * B站最长的大会员有效期就是个位数年。100 年是**极宽的**下界 ——
 * 宽到不可能误判真实数据，窄到一定能抓住"多乘了 1000"这类量级错误
 * （1.81e12 乘 1000 后变成 1.81e15，即 5 万年后，远超 100 年）。
 *
 * @param expireAt 缓存里的到期时间戳（ms）
 * @param now      当前时间戳（ms）
 */
export function isExpireAtImplausible(expireAt: number | null, now: number): boolean {
  if (typeof expireAt !== 'number' || !Number.isFinite(expireAt)) return false;
  return expireAt - now > MAX_EXPIRE_AHEAD_MS;
}

/**
 * 尝试把一个脏的 `expireAt` **还原**成合理值。
 *
 * ## 为什么是还原，而不是清掉（2026-10-27 的第二版实现）
 *
 * 第一版直接返回 `null`。那造成了一个更糟的 bug：
 * **到期日从"显示错的"变成了"完全不显示"**。
 *
 * 原因是结构性约束：播放账号的 cookie 只活在扫码时的无痕分区，
 * 窗口一关就没了（见 `probeAndCacheSummary` 的注释）。所以在普通分区
 * **再也探测不到这个账号** —— `expireAt` 一旦清成 null 就永远补不回来。
 * 用户得重新扫码才能看到到期日，而他并不知道这一点。
 *
 * 而脏值本身是可逆的：它只是被多乘了一次 1000（旧代码 `dueDate * 1000`）。
 * 除以 1000 就回到真实值（实测：1.81e15 / 1000 = 1.81e12 = 2027-05-28）。
 *
 * ## 判据顺序（重要）
 *
 * 1. 值合理 → 原样返回（**最常见路径，不碰它**）
 * 2. 不合理，但除以 1000 后合理 → 返回除后的值（**这就是修复**）
 * 3. 怎么都不合理 → `null`（宁可没有，不能显示错）
 *
 * @param expireAt 缓存里的到期时间戳（ms），可能是脏的
 * @param now      当前时间戳（ms）
 * @returns 合理的时间戳，或 null 表示无法还原
 */
export function repairExpireAt(expireAt: number | null, now: number): number | null {
  if (typeof expireAt !== 'number' || !Number.isFinite(expireAt) || expireAt <= 0) return null;
  if (!isExpireAtImplausible(expireAt, now)) return expireAt;

  /**
   * 多乘一次 1000 是最可能的成因：除以 1000 就是原值。
   *
   * ⚠️ 但**不能无条件除**。只有除完的结果本身**像一个真实到期日**才算还原成功：
   * 必须距今至少 1 天（排除"除完已经过去了"）且在 100 年以内。
   *
   * 反例（测试抓到的）：`now + 101 年` 除以 1000 后是「36 天后」——
   * 数字上不算离谱，但它显然不是"多乘了 1000"，而是别的原因造成的坏值。
   * 无条件接受会**凭空造出一个到期日**，比显示 null 更糟。
   */
  const halved = Math.round(expireAt / 1000);
  const oneDay = 86_400_000;
  if (halved - now >= oneDay && !isExpireAtImplausible(halved, now)) return halved;

  return null;
}

export function isHealthFresh(health: AccountHealth | null, now: number): boolean {
  if (!health) return false;
  if (typeof health.checkedAt !== 'number' || health.checkedAt <= 0) return false;
  return now - health.checkedAt < HEALTH_TTL_MS;
}
