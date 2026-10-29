/**
 * PGC 时长 / SSR 取数的纯判据（S3.3，2026-10-30 从 `entrypoints/content.ts` 下沉）
 *
 * ## 为什么放在 `core/`
 *
 * 这两个函数**没有任何副作用、不碰 `location` / `chrome` / DOM**，输入全由参数给。
 * 它们原先埋在 2000 行的入口文件里，**一个测试都没有** ——
 * 而 `expectedDurationMs` 直接决定「这条流算不算完整」，
 * `readSsrVideoInfo` 直接决定「SSR 里有没有 video_info」，
 * 两者判错都会让 PGC 换流走错分支。
 *
 * 按 `docs/04-project-structure.md` 原则 1，无副作用的判据属于 `core/`。
 * 放进 `core/playinfo/` 与 `pgc-merge` 等同类逻辑放在一起。
 */

/**
 * 从 SSR 数据里取 `video_info`。
 *
 * ## 为什么两个位置都找（`result` 与 `data.result`）
 *
 * 整页加载与 SPA 切集时 SSR 的**外壳形状不同**：
 *   - 整页：`{ result: { video_info } }`
 *   - 部分场景：`{ data: { result: { video_info } } }`
 *
 * 只认一种就会在另一种上拿到 `null` → 判成"没有 SSR 基线" → 走错分支。
 *
 * @returns `video_info` 对象；没有则 `null`（**不是 undefined**，调用方按 null 判）
 */
export function readSsrVideoInfo(ssr: unknown): unknown {
  if (!ssr || typeof ssr !== 'object') return null;
  const o = ssr as Record<string, unknown>;
  const result =
    (o.result as Record<string, unknown> | undefined) ??
    ((o.data as Record<string, unknown> | undefined)?.result as
      Record<string, unknown> | undefined);
  return result?.video_info ?? null;
}

/**
 * 从 `video_info` 上取预期总时长（毫秒）。
 *
 * ## 为什么字段叫 `timelength`
 *
 * 那是接口原名（B站 playurl / playview 都这么写），**不要改成 `duration`**：
 * `dash.duration` 是另一回事（DASH 分片时长，单位秒），
 * 两者混用会让"截断判据"整体偏掉一个数量级。
 *
 * @returns 时长毫秒；缺失/非法/非正数一律返回 `0`（表示"不知道"）
 */
export function expectedDurationMs(videoInfo: unknown): number {
  if (!videoInfo || typeof videoInfo !== 'object') return 0;
  const t = (videoInfo as Record<string, unknown>).timelength;
  return typeof t === 'number' && t > 0 ? t : 0;
}
