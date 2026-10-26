/**
 * 成功率缓冲的持久化。
 *
 * 存 `storage.local` 而不是 `session`：用户关浏览器前看到的趋势，
 * 下次打开时应还在。这对"这插件到底稳不稳"的判断很重要。
 */

import type { StatBucket } from '@core/playinfo/stats';
import { recordResult, toTimeline } from '@core/playinfo/stats';

const STATS_KEY = 'pluma:stats';

/** 读取原始缓冲（未补齐）。格式不对就当空 */
export async function readStats(): Promise<StatBucket[]> {
  try {
    const bag = await chrome.storage.local.get(STATS_KEY);
    const raw = bag[STATS_KEY];
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(
        (x): x is StatBucket =>
          !!x &&
          typeof x === 'object' &&
          typeof (x as StatBucket).start === 'number' &&
          typeof (x as StatBucket).ok === 'number' &&
          typeof (x as StatBucket).fail === 'number',
      )
      .map((x) => ({ start: x.start, ok: x.ok, fail: x.fail }));
  } catch {
    return [];
  }
}

/**
 * 记一次取流结果。
 *
 * 调用方是 `page/activate` 的成功/失败路径——那是**唯一**已知的真实取流结果，
 * 比 background 自己发请求统计更贴近用户体感。
 */
export async function recordStat(ok: boolean, now: number = Date.now()): Promise<void> {
  try {
    const next = recordResult(await readStats(), now, ok);
    await chrome.storage.local.set({ [STATS_KEY]: next });
  } catch {
    // 统计失败不能影响主流程
  }
}

/** 读取补齐成 12 个连续窗口的时序，直接给图表用 */
export async function readTimeline(now: number = Date.now()): Promise<StatBucket[]> {
  return toTimeline(await readStats(), now);
}

/** 清除（退出播放账号时） */
export async function clearStats(): Promise<void> {
  await chrome.storage.local.remove(STATS_KEY).catch(() => {});
}
