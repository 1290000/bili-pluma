/**
 * 取流成功率 —— 环形缓冲，供 popup「已降级」状态的条形图使用。
 *
 * ## 为什么要环形缓冲而不是计数器
 *
 * UI 规范 §3 状态 4 要求画 **8–12 根柱**，每根代表一段时间窗。
 * 计数器只能给出"总成功率"，画不出趋势；而"刚才突然全失败"和
 * "一直偶尔失败"对用户的判断完全不同。
 *
 * ## 粒度选择
 *
 * 12 个桶 × 5 分钟 = 最近 1 小时。理由：
 *   - playurl 只在**页面加载和切 P** 时调用（Q3 实测），频率极低
 *   - 5 分钟粒度足够聚合，不会出现"一半的桶是空的"那种稀疏图
 *   - 1 小时窗口覆盖了用户"我刚才试了但没效果"的典型时间范围
 *
 * 逻辑在 core（纯函数、可单测），持久化在 platform。
 */

/** 每个桶覆盖的时长 */
export const BUCKET_MS = 5 * 60 * 1000;

/** 桶数量 */
export const BUCKET_COUNT = 12;

/**
 * 一个时间窗。
 *
 * `ok + fail` 才是有意义的样本数。两者都为 0 的桶表示"这段时间没请求过"，
 * UI 应画成灰色而不是红色——没发生 ≠ 失败。
 */
export interface StatBucket {
  /** 窗口起点（Unix ms，按 BUCKET_MS 对齐） */
  start: number;
  ok: number;
  fail: number;
}

/** 把时间戳对齐到所属桶的起点 */
export function bucketStart(at: number): number {
  return Math.floor(at / BUCKET_MS) * BUCKET_MS;
}

/**
 * 记录一次结果，返回新的缓冲（不改原数组）。
 *
 * 环形特性：只保留最近 `BUCKET_COUNT` 个窗口，更早的直接丢弃。
 * 用"按时间戳归一"而不是"push + shift"，因为请求是稀疏的——
 * 可能 40 分钟一个都没有，那时 shift 出来的桶其实是错的。
 */
export function recordResult(
  buckets: readonly StatBucket[],
  at: number,
  ok: boolean,
): StatBucket[] {
  const start = bucketStart(at);
  const kept = buckets.filter(
    (b) => b.start <= start && start - b.start < BUCKET_MS * BUCKET_COUNT,
  );

  const idx = kept.findIndex((b) => b.start === start);
  if (idx >= 0) {
    const cur = kept[idx];
    if (!cur) return [...kept];
    const next: StatBucket = ok
      ? { start: cur.start, ok: cur.ok + 1, fail: cur.fail }
      : { start: cur.start, ok: cur.ok, fail: cur.fail + 1 };
    return kept.map((b, i) => (i === idx ? next : b));
  }

  return [...kept, { start, ok: ok ? 1 : 0, fail: ok ? 0 : 1 }].sort((a, b) => a.start - b.start);
}

/**
 * 补齐成固定长度的连续窗口，直接喂给图表。
 *
 * **为什么必须补齐**：图表需要 12 根等宽的柱。如果只给"有数据的桶"，
 * 稀疏时段会在图上看起来像"连续失败"，与事实相反。
 *
 * @param now 当前时间，用于算出最新窗口
 */
export function toTimeline(buckets: readonly StatBucket[], now: number): StatBucket[] {
  const latest = bucketStart(now);
  const out: StatBucket[] = [];

  for (let i = BUCKET_COUNT - 1; i >= 0; i -= 1) {
    const start = latest - i * BUCKET_MS;
    const hit = buckets.find((b) => b.start === start);
    out.push({ start, ok: hit?.ok ?? 0, fail: hit?.fail ?? 0 });
  }

  return out;
}

/** 汇总统计，用于"成功率 87%"这类文案 */
export function summarize(buckets: readonly StatBucket[]): {
  total: number;
  ok: number;
  rate: number | null;
} {
  let total = 0;
  let ok = 0;
  for (const b of buckets) {
    total += b.ok + b.fail;
    ok += b.ok;
  }
  return { total, ok, rate: total === 0 ? null : ok / total };
}
