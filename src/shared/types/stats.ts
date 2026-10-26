/**
 * 取流成功率的类型定义。
 *
 * ⚠️ 这里只有**类型**，纯逻辑在 `core/playinfo/stats.ts`。
 * 原因：`shared/` 不许依赖 `core/`（依赖只能从外往里流），
 * 所以消息协议要用的类型必须定义在最底层。
 */

/**
 * 一个时间窗的统计。
 *
 * `ok + fail` 才是有意义的样本数。两者都为 0 的桶表示"这段时间没请求过"，
 * UI 应画成灰色而不是红色——没发生 ≠ 失败。
 */
export interface StatBucket {
  /** 窗口起点（Unix ms，按 5 分钟对齐） */
  start: number;
  ok: number;
  fail: number;
}
