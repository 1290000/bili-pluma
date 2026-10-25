/**
 * 扫码登录的状态机 —— 纯逻辑，不碰 DOM / chrome API。
 *
 * 接口来自 2026-10-25 实测（poc/verify/probe-qrlogin.cjs）：
 *   生成  GET /x/passport-login/web/qrcode/generate
 *   轮询  GET /x/passport-login/web/qrcode/poll?qrcode_key=...
 *
 * 注意 B站有**两层** code：
 *   - 外层 `code`：请求是否成功（0 = HTTP 层成功）
 *   - 内层 `data.code`：业务状态（86101 / 86090 / 86038 / 0）
 * 混用会写出"扫码成功却当成失败"的 bug。
 */

const PASSPORT_BASE = 'https://passport.bilibili.com/x/passport-login/web/qrcode';

/** 轮询间隔。官方前端实测约 3 秒，跟着做，别自己发明 */
export const POLL_INTERVAL_MS = 3000;

/** 二维码有效期。B站未明确给出，取 180 秒（官方前端行为） */
export const QR_TTL_MS = 180_000;

export type { QrLoginStatus } from '@shared/types/login';

import type { QrLoginStatus } from '@shared/types/login';

export interface QrGenerateResult {
  qrcodeKey: string;
  /** 要编码进二维码的字符串 */
  qrContent: string;
}

/** core 只依赖这个接口，真实实现在 platform/http/fetcher.ts */
export interface HttpClient {
  getJson<T>(url: string): Promise<T>;
}

interface GenerateResponse {
  code: number;
  message: string;
  data?: {
    url?: string;
    qrcode_key?: string;
  };
}

interface PollResponse {
  code: number;
  message: string;
  data?: {
    url?: string;
    refresh_token?: string;
    timestamp?: number;
    code?: number;
    message?: string;
  };
}

export async function generateQr(http: HttpClient): Promise<QrGenerateResult> {
  const res = await http.getJson<GenerateResponse>(`${PASSPORT_BASE}/generate?source=main_web`);

  const url = res.data?.url;
  const key = res.data?.qrcode_key;
  if (res.code !== 0 || typeof url !== 'string' || typeof key !== 'string' || url.length === 0) {
    throw new Error(`二维码生成失败: code=${res.code} ${res.message}`);
  }

  return { qrcodeKey: key, qrContent: url };
}

export async function pollQr(http: HttpClient, qrcodeKey: string): Promise<QrLoginStatus> {
  const res = await http.getJson<PollResponse>(
    `${PASSPORT_BASE}/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main_web`,
  );

  if (res.code !== 0) {
    return { kind: 'error', code: res.code, message: res.message };
  }

  const inner = res.data?.code;
  switch (inner) {
    case 86101:
      return { kind: 'pending' };
    case 86090:
      return { kind: 'scanned' };
    case 86038:
      return { kind: 'expired' };
    case 0:
      return { kind: 'success', crossDomainUrl: res.data?.url ?? '' };
    default:
      return {
        kind: 'error',
        code: inner ?? -1,
        message: res.data?.message ?? '未知的轮询状态',
      };
  }
}

/** 状态是否已经终止（UI 据此停止轮询） */
export function isTerminal(status: QrLoginStatus): boolean {
  return status.kind === 'expired' || status.kind === 'success' || status.kind === 'error';
}
