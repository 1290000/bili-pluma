/**
 * 「检查一次有没有新版本」这个用例 —— core 侧，网络从端口注入（这里不出现 `fetch`）。
 *
 * ## 为什么不把这段塞进 `platform/update/github.ts`
 *
 * 因为**要不要发请求**是业务判断，不是网络细节。它必须能被测到"闸门不成立时一次请求都不发"，
 * 而这件事只有在 core 里才测得干净。
 *
 * ## 失败语义（最容易写错的一段）
 *
 * | 情况 | `lastCheckAt` | `latest` | 为什么 |
 * | --- | --- | --- | --- |
 * | 成功拿到 200 | 更新 | 更新 | —— |
 * | `304` | **更新** | 保留 | 服务端明确说"没变"，这就是一次成功的检查 |
 * | 限流 403/429 | **不动** | 保留 | 限流不是"没新版本"，动了会让用户以为自己是新版 |
 * | 网络/解析失败 | **不动** | 保留 | 下次加载要重试 |
 */

import type { LatestRelease, UpdateState } from '@core/update/state';
import {
  withCheckResult,
  withFailedCheck,
  withManualCheckAt,
  withNoChange,
} from '@core/update/state';
import { canManualCheck, shouldCheck } from '@core/update/gate';
import { compareVersions } from '@core/update/version';
import type { UpdateCheckOutcome } from '@shared/types/update';

export type LatestReleaseResult =
  | { kind: 'ok'; release: LatestRelease; etag: string | null }
  | { kind: 'not-modified'; etag: string | null }
  | { kind: 'rate-limited'; resetAt: number | null }
  | { kind: 'error'; message: string };

/** 端口：由 `platform/update/github.ts` 实现。 */
export interface ReleaseSource {
  latest(etag: string | null): Promise<LatestReleaseResult>;
}

export interface RunCheckOptions {
  state: UpdateState;
  /** 当前安装的版本（`chrome.runtime.getManifest().version`） */
  currentVersion: string;
  now: number;
  /** `true` = 用户点了「检查更新」；`false` = 自动触发 */
  manual: boolean;
  /** 手动检查的冷却（毫秒） */
  manualCooldownMs: number;
  source: ReleaseSource;
}

export type CheckOutcome = UpdateCheckOutcome;

export interface CheckResult {
  state: UpdateState;
  outcome: CheckOutcome;
  /** 失败/跳过时的可读原因，给诊断用 */
  reason: string | null;
  release: LatestRelease | null;
}

/**
 * 执行一次检查。
 *
 * ⚠️ 闸门判断在**调用 source 之前**。把这段顺序写反（先请求再判闸门）在测试里
 * 表现为"skipped 但 source 被调用过"——单测钉住了这一条。
 */
export async function runCheck(options: RunCheckOptions): Promise<CheckResult> {
  const { state, now, manual, source } = options;

  if (manual) {
    if (!canManualCheck(state.lastManualCheckAt, now, options.manualCooldownMs)) {
      return { state, outcome: 'skipped', reason: '手动检查冷却中', release: null };
    }
  } else if (
    !shouldCheck({
      now,
      lastCheckAt: state.lastCheckAt,
      intervalDays: state.intervalDays,
      autoEnabled: state.autoCheckEnabled,
    })
  ) {
    return { state, outcome: 'skipped', reason: '自动检查闸门未到', release: null };
  }

  const markManual = (next: UpdateState): UpdateState =>
    manual ? withManualCheckAt(next, now) : next;

  let result: LatestReleaseResult;
  try {
    result = await source.latest(state.etag);
  } catch (error) {
    // 端口实现约定"不抛"，但万一抛了也不许把异常漏给 UI
    const reason = error instanceof Error ? error.message : String(error);
    return {
      state: markManual(withFailedCheck(state, now, manual)),
      outcome: 'failed',
      reason,
      release: null,
    };
  }

  switch (result.kind) {
    case 'ok': {
      const next = withCheckResult(state, { at: now, etag: result.etag, latest: result.release });
      return { state: markManual(next), outcome: 'ok', reason: null, release: result.release };
    }
    case 'not-modified': {
      // 304 是一次**成功**的检查：时间要推进，否则会每次都发条件请求
      const next = withNoChange(state, { at: now, etag: result.etag });
      return { state: markManual(next), outcome: 'unchanged', reason: null, release: null };
    }
    case 'rate-limited': {
      const reason =
        result.resetAt === null
          ? 'GitHub 限流'
          : `GitHub 限流，${new Date(result.resetAt).toISOString()} 后可重试`;
      return {
        state: markManual(withFailedCheck(state, now, manual)),
        outcome: 'rate-limited',
        reason,
        release: null,
      };
    }
    case 'error': {
      return {
        state: markManual(withFailedCheck(state, now, manual)),
        outcome: 'failed',
        reason: result.message,
        release: null,
      };
    }
  }
}

/** 有没有"比当前版本新"的版本。**只判断，不改状态**。 */
export function releaseIsNewer(release: LatestRelease | null, currentVersion: string): boolean {
  if (!release) return false;
  try {
    return compareVersions(release.version, currentVersion) > 0;
  } catch {
    // 版本号解析不了 ⇒ 当作"没有更新"（与 state.ts 的 isUpdateAvailable 保持同一口径）
    return false;
  }
}
