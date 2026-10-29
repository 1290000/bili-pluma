/**
 * `ssr-playinfo` 消息的门控链（S3.4 · 2026-10-30 从 `entrypoints/content.ts` 下沉）
 *
 * ## 这个模块解决的问题
 *
 * 原来这 5 层判定散在一个 357 行的大函数里，连着 5 个 `return`。
 * 2026-10-28 真机踩到的坑正是这个形状：
 *
 * ```
 * cacheBytes=0、lastStage='boot' —— 主世界从未收到 cfg，
 * 但诊断页里一行 PGC 日志都没有，无法判断是"消息没到"还是"到了但判定没过"。
 * ```
 *
 * **静默返回是这类 bug 的最大帮凶。**
 *
 * 现在把判定抽成**返回原因**的纯函数：每一层退出的原因都是有名字的，
 * 调用方把它写进诊断日志，测试也能逐层断言。
 *
 * ## 为什么要传 `cid` 而不是自己读
 *
 * "上次处理的 cid"是跨消息的状态。把它显式传进来，这个函数就是纯的 ——
 * 可以在测试里任意构造 SPA 切集 / 重复上报两种场景。
 */

/** 门控结论 */
export type SsrGateResult =
  /** 通过全部判定，应当调用 `orchestratePgc` */
  | { kind: 'proceed'; cid: string }
  /** 不是 PGC 播放页 */
  | { kind: 'skip'; reason: 'not-pgc' }
  /** 读不出 cid */
  | { kind: 'skip'; reason: 'no-cid' }
  /** 同一个 cid 已经处理过（防重复取流） */
  | { kind: 'skip'; reason: 'already-tried' };

export interface SsrGateInput {
  /** `parsePlayPage(location.href)` 的结果（调用方传入，避免本模块碰 `location`） */
  pageKind: string | null;
  /** 从 SSR 数据里读出的 cid */
  cid: string | null;
  /** 上一次成功处理过的 cid（空串 = 还没有） */
  handledCid: string;
  /** 本会话是否已经试过一次 */
  alreadyTried: boolean;
}

/**
 * 判定这条 `ssr-playinfo` 要不要继续走取流流程。
 *
 * ## 顺序不能换
 *
 * 1. **先判页面类型**：不是 PGC 页就没必要读 cid
 * 2. **再判 cid**：读不出就无法编排
 * 3. **cid 变了 → 重置 `alreadyTried`**（SPA 切集要让新集重新走完整流程）
 * 4. **最后判 alreadyTried**：同一个 cid 重复上报时不再取流
 *
 * ⚠️ 第 3 步与第 4 步的顺序是 2026-10-28 真机踩出来的：
 * 先重置、再判断。写反了会让 SPA 切集后的新集**永远不走取流**。
 */
export function gateSsrPlayinfo(input: SsrGateInput): SsrGateResult {
  if (input.pageKind !== 'pgc') return { kind: 'skip', reason: 'not-pgc' };
  if (!input.cid) return { kind: 'skip', reason: 'no-cid' };

  // cid 变了 = SPA 切集 → 重置"只做一次"的状态
  const tried = input.cid !== input.handledCid ? false : input.alreadyTried;
  if (tried) return { kind: 'skip', reason: 'already-tried' };

  return { kind: 'proceed', cid: input.cid };
}

/** 判定结果的诊断文案（每层退出都要能在日志里看到） */
export function describeSsrGate(r: SsrGateResult): string {
  if (r.kind === 'proceed') return `[PGC] 通过门控 cid=${r.cid}，开始编排`;
  switch (r.reason) {
    case 'not-pgc':
      return '[PGC] 跳过：不是 PGC 播放页';
    case 'no-cid':
      return '[PGC] 跳过：读不出 cid';
    case 'already-tried':
      return '[PGC] 跳过：本集已试过（防重复取流）';
  }
}
