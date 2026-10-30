/**
 * 主世界「纯诊断」消息的路由表（S3.4 · 2026-10-30）
 *
 * ## 为什么要有这张表
 *
 * 原先这 6 条消息在 `listenMainWorld` 里各占一个 `if (d.type === ...)` + 一段
 * 模板字符串，混在 365 行的大函数里。它们**没有任何副作用**（只上报一条日志），
 * 却和真正有状态写入的分支（`ssr-playinfo` / `hdr` / `playurl-tracks`）并列，
 * 读代码时分不清哪条重要。
 *
 * 收成表之后：
 *   - 加一条诊断消息 = 表里加一行，不碰别的分支
 *   - 文案逻辑在 `diagnostic-text.ts`，可单测
 *   - 有状态写入的分支在调用处一眼可辨（它们**不**在这张表里）
 *
 * ## ⚠️ 这张表**只放纯诊断**
 *
 * 任何要写 `pageState` / `badgeState` / `pgcCacheTried` 的消息都**不许**进来。
 * 一旦混入有副作用的分支，"纯诊断"这个前提就没了，改动会重新变得不可预测。
 */
import {
  describeCodec,
  describePatch,
  describePgcStage,
  describeRequest,
  describeSourceBuffer,
} from './diagnostic-text';

export interface DiagnosticRoute {
  /** 该消息对应的一行诊断文案 */
  describe: (msg: Record<string, unknown>) => string;
}

/**
 * 按消息 `type` 索引的诊断路由。
 *
 * `sb-ok` 与 `sb-error` 共用一条（差异体现在 `describe` 里），
 * 所以它们同源、不会各自漂移。
 */
export const DIAGNOSTIC_ROUTES: Readonly<Record<string, DiagnosticRoute>> = {
  patch: {
    describe: (m) => describePatch(m as { path?: string }),
  },
  'sb-ok': {
    describe: (m) =>
      describeSourceBuffer(true, m as { mime?: string; kind?: string; buffered?: number }),
  },
  'sb-error': {
    describe: (m) =>
      describeSourceBuffer(false, m as { mime?: string; kind?: string; buffered?: number }),
  },
  codec: {
    describe: (m) => describeCodec(m as { mime?: string; from?: string; kind?: string }),
  },
  req: {
    describe: (m) => describeRequest(m as { method?: string; url?: string }),
  },
  pgc: {
    describe: (m) => describePgcStage(m as { stage?: string; detail?: string }),
  },
};

/** 这条消息是不是"纯诊断"（可由路由表直接处理） */
export function isDiagnosticType(type: string | undefined): boolean {
  return typeof type === 'string' && Object.hasOwn(DIAGNOSTIC_ROUTES, type);
}

/**
 * 取这条诊断消息对应的文案。
 *
 * @returns 文案；不是诊断类型时返回 `null`（调用方继续走别的分支）
 */
export function describeDiagnostic(
  msg: { type?: string } & Record<string, unknown>,
): string | null {
  if (!isDiagnosticType(msg.type)) return null;
  const route = DIAGNOSTIC_ROUTES[msg.type as string];
  return route ? route.describe(msg) : null;
}
