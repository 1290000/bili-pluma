/**
 * 扫码登录的消息处理 —— 只做三件事：解析参数 → 调 core/platform → 返回结果。
 *
 * 业务逻辑不在这里（在 `core/auth/qrcode.ts`），凭据读取也不在这里
 * （在 `platform/storage/cookies.ts`）。
 *
 * ⚠️ **凭据必须从登录窗口所在的分区读**（见 docs/decisions/0011-isolated-window-login.md）。
 *
 * 怎么保证读对分区：
 *   `incognito: "split"` 下无痕窗口有**独立的 background 实例**。
 *   登录窗口的页面发消息，会被路由到它自己分区的 background。
 *   所以在这个实例里 `chrome.cookies.get` 不传 storeId，默认读的就是无痕分区。
 *
 *   **不要用 `getAllCookieStores()` 拿无痕分区 id**：跨分区不可见，永远是空
 *   （这正是之前"明明开出了 InPrivate 窗口却提示需要授权"的原因）。
 *
 * ⚠️ 错误详情必须脱敏：`e.message` 可能包含完整 URL（含 `qrcode_key`）。
 */

import { generateQr, pollQr } from '@core/auth/qrcode';
import { diag } from '@/src/background/login-window';
import { createHttpClient } from '@platform/http/fetcher';
import { enableProxy } from '@platform/http/dnr';
import { readPlaybackCredential } from '@platform/storage/cookies';
import { persistCredential } from '@platform/storage/credential-store';
import type { ResponseMsg } from '@shared/types/messages';
import { serializeCookie } from '@shared/utils/cookie';

/** 只保留错误类型，去掉可能带凭据/查询参数的文本 */
function redactError(e: unknown): string {
  if (e instanceof Error) {
    // DOMException（AbortSignal.timeout 触发）显示为 TimeoutError
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return '请求超时';
    // 只取第一行，且截断到 80 字符，避免整条 URL 漏出去
    const firstLine = e.message.split('\n')[0] ?? '';
    return firstLine.slice(0, 80);
  }
  return '未知错误';
}

export async function handleQrGenerate(): Promise<ResponseMsg> {
  try {
    const { qrContent, qrcodeKey } = await generateQr(createHttpClient());
    return { type: 'qr/generate:ok', qrContent, qrcodeKey };
  } catch (e) {
    return { type: 'qr/generate:err', detail: redactError(e) };
  }
}

export async function handleQrPoll(qrcodeKey: string): Promise<ResponseMsg> {
  try {
    const status = await pollQr(createHttpClient(), qrcodeKey);

    // 登录成功的那一次，才去读凭据并加密落库。明文不出这个函数的栈。
    let credentialSaved = false;
    if (status.kind === 'success') {
      // 不传 storeId：当前实例所在的分区就是登录窗口的分区
      const credential = await readPlaybackCredential();

      if (credential) {
        await persistCredential(credential);
        credentialSaved = true;

        // ★ 配置好播放账号后**自动开启代理**（ADR 0006 的总开关）
        // 装全局常驻规则，值全局一致，之后所有白名单请求自动带播放账号凭据
        const cookie = serializeCookie({
          SESSDATA: credential.sessdata,
          bili_jct: credential.biliJct,
          DedeUserID: credential.dedeUserId,
        });
        await enableProxy(cookie);
        await diag('qr/poll', '凭据已存并开启代理');
      }
    }

    return { type: 'qr/poll:ok', status, credentialSaved };
  } catch (e) {
    return { type: 'qr/poll:err', detail: redactError(e) };
  }
}
