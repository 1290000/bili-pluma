/**
 * 凭据健康判定 —— 纯逻辑，不碰网络也不碰存储。
 *
 * 与 `account-info.ts` 的分工：
 *   - `account-info.ts`：把**一次** nav 探测的原始响应解释成结论
 *   - 本文件：把**多次**结论累积成"用户该看到什么状态"
 *
 * 分开的原因：前者是"这次请求是什么结果"，后者是"整体该不该报警"。
 * 混在一起会导致每加一个 UI 状态就要动解析逻辑。
 */

import type { AccountHealth } from '@shared/types/account';

import { type HealthVerdict, isHealthFresh } from './account-info';

/**
 * 累积状态。
 *
 * `consecutiveFailures` 的存在是为了**抑制抖动**：
 * 网络抖一次就弹「凭据失效」，用户会重扫一次码，然后发现什么都没变——
 * 下次真的失效时他就不信这个提示了。
 */
export interface HealthRecord {
  /** 已确认失效（只有 -101 或连续失败才置 true） */
  expired: boolean;
  /** 最近一次**成功**校验的时间（Unix ms）。0 = 从未成功 */
  checkedAt: number;
  /** 连续「无法确认」的次数（网络失败 / 非 -101 的业务码） */
  consecutiveFailures: number;
  /** 归因文案。正常时为 null */
  reason: string | null;
}

/** 连续多少次无法确认才降级为失效 */
export const FAILURE_THRESHOLD = 2;

export const INITIAL_HEALTH: HealthRecord = {
  expired: false,
  checkedAt: 0,
  consecutiveFailures: 0,
  reason: null,
};

/**
 * 用一次探测结论更新状态。
 *
 * | 结论 | 处理 |
 * | --- | --- |
 * | `healthy` / `not-vip` | 清空累计，`checkedAt` 刷新，`expired=false` |
 * | `expired`（明确 -101） | **立即**失效，不等阈值 |
 * | `unknown`（网络/风控） | 计数 +1，达到阈值才失效 |
 */
export function applyVerdict(
  prev: HealthRecord,
  verdict: HealthVerdict,
  now: number,
): HealthRecord {
  switch (verdict.kind) {
    case 'healthy':
    case 'not-vip':
      return {
        expired: false,
        checkedAt: now,
        consecutiveFailures: 0,
        reason: null,
      };

    case 'expired':
      return {
        expired: true,
        checkedAt: prev.checkedAt,
        consecutiveFailures: prev.consecutiveFailures + 1,
        reason: verdict.reason,
      };

    case 'unknown': {
      const failures = prev.consecutiveFailures + 1;
      const nowExpired = failures >= FAILURE_THRESHOLD;
      return {
        expired: nowExpired ? true : prev.expired,
        checkedAt: prev.checkedAt,
        consecutiveFailures: failures,
        reason: nowExpired ? verdict.reason : prev.reason,
      };
    }
  }
}

/**
 * 是否**必须**重新校验。
 *
 * 三个条件任一成立就返回 true：
 *   - 从未成功校验过（`checkedAt === 0`）
 *   - 已判定失效（失效状态要持续复查，因为用户可能已在别处重登）
 *   - 记录已过期（超过 `HEALTH_TTL_MS`）
 *
 * 惰性检查在这里落地：不靠定时任务，靠"要展示时问一句该不该查"。
 */
export function needsRecheck(health: HealthRecord, now: number): boolean {
  if (health.expired) return true;
  if (health.checkedAt === 0) return true;
  return !isHealthFresh(
    { healthy: !health.expired, checkedAt: health.checkedAt, reason: null },
    now,
  );
}

/** 归一成下发给 UI 的健康视图 */
export function toAccountHealth(record: HealthRecord): AccountHealth {
  return {
    healthy: !record.expired,
    checkedAt: record.checkedAt,
    reason: record.reason,
  };
}
