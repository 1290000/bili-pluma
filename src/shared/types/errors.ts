/**
 * 错误码与错误类型。
 *
 * 约定：错误对象**绝不携带凭据**。`detail` 只放可公开的技术信息（状态码、路径），
 * 放 cookie 或 token 属于严重违规（AGENTS.md §4.2）。
 */

export const ERROR_CODES = {
  /** 还没配置播放账号 */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** 播放账号凭据失效，需要重新扫码 */
  CREDENTIAL_EXPIRED: 'CREDENTIAL_EXPIRED',
  /** URL 不在白名单内，拒绝代理 */
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  /** DNR 规则池耗尽（并发过高） */
  RULE_POOL_EXHAUSTED: 'RULE_POOL_EXHAUSTED',
  /** B站返回非 0 code */
  UPSTREAM_REJECTED: 'UPSTREAM_REJECTED',
  /** 网络层失败 */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** 超时 */
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface PlumaError {
  code: ErrorCode;
  /** 可公开的技术细节，**不得包含凭据** */
  detail: string | null;
  /** B站返回的业务 code（如 -101 / -412） */
  upstreamCode: number | null;
}

export function plumaError(code: ErrorCode, detail?: string, upstreamCode?: number): PlumaError {
  return {
    code,
    detail: detail ?? null,
    upstreamCode: upstreamCode ?? null,
  };
}
