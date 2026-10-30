/**
 * 主世界「纯诊断」消息的文案构造（S3.4 · 2026-10-30 从 `entrypoints/content.ts` 下沉）
 *
 * ## 这些分支的共同点
 *
 * `patch` / `sb-ok` / `sb-error` / `codec` / `req` / `pgc` 六条消息**只写诊断日志**，
 * 不改任何状态。它们在 365 行的大函数里各占一个 `if` + 一段模板字符串，
 * 改动它们要在十几个分支之间翻找，而且**任何一条文案写错都没有测试会红**。
 *
 * 抽出来之后：文案是纯函数，可以逐条断言；分支表见 `diagnostic-routes.ts`。
 *
 * ## 为什么这些文案值得测
 *
 * 它们不是给用户看的，是**排查时唯一的线索**。2026-10-28 那次真机坑就是
 * "诊断页一行 PGC 日志都没有" —— 日志本身是诊断资产，
 * 文案里少了 `stage` 或 `mime` 就等于那条线索断了。
 */

/** `patch`：会员状态响应已被改写 */
export function describePatch(p: { path?: string }): string {
  return `已改写会员状态响应: ${p.path ?? '?'}`;
}

/**
 * `sb-ok` / `sb-error`：SourceBuffer 装载结果。
 *
 * ⚠️ `buffered` 用 `Math.round` 取整秒 —— 保留小数会让日志噪音变大，
 * 而排查时关心的只是"有没有数据、大概几秒"。
 */
export function describeSourceBuffer(
  ok: boolean,
  s: { mime?: string; kind?: string; buffered?: number },
): string {
  const label = s.kind === 'video' ? '视频轨' : '音轨';
  return ok
    ? `${label}装载成功: ${s.mime ?? '?'} (缓冲 ${Math.round(s.buffered ?? 0)}s)`
    : `${label}装载失败: ${s.mime ?? '?'}`;
}

/** `codec`：播放器实际创建的 SourceBuffer 编码 */
export function describeCodec(c: { mime?: string; from?: string; kind?: string }): string {
  return `${c.kind === 'audio' ? '音频' : '视频'}编码(${c.from ?? '?'}): ${c.mime ?? '?'}`;
}

/**
 * `req`：页面真的发出了 playurl 请求。
 *
 * ⚠️ **只保留路径，丢掉 query** —— 这是 DNR 能不能生效的前提记录，
 * 而 query 里可能带 `cid` 等页面数据。日志不该比诊断需要的信息更多。
 */
export function describeRequest(d: { method?: string; url?: string }): string {
  const path = (d.url ?? '').split('?')[0];
  return `playurl 请求出现: ${d.method ?? 'GET'} ${path}`;
}

/** `pgc`：主世界 PGC 分支的阶段（`cfg` / `patch` / `error`） */
export function describePgcStage(p: { stage?: string; detail?: string }): string {
  return `[PGC] ${p.stage ?? '?'} ${p.detail ?? ''}`.trim();
}
