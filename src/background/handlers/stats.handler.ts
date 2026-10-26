/**
 * 取流成功率的读取端。
 *
 * 写入在 `page/activate` 的成败路径（那里才有**真实**的取流结果）。
 * 这里只负责把 12 个时间窗补齐后交给 UI。
 */

import { summarize } from '@core/playinfo/stats';
import { readTimeline } from '@platform/storage/stats-store';
import type { ResponseMsg } from '@shared/types/messages';

export async function handleStatsRecent(): Promise<ResponseMsg> {
  try {
    const buckets = await readTimeline();
    // rate 为 null 表示窗口内一次请求都没有 —— UI 要画灰，不要画成 0% 红条
    return { type: 'stats/recent:ok', buckets, rate: summarize(buckets).rate };
  } catch (e) {
    return {
      type: 'stats/recent:err',
      detail: e instanceof Error ? e.message.slice(0, 80) : '未知错误',
    };
  }
}
