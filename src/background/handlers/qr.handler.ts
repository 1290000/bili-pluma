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
      //
      // ⚠️ **必须重试**。扫码成功的那一刻浏览器刚收到 `Set-Cookie`，
      // cookie 落盘和 `chrome.cookies.get` 之间可能有几百毫秒的延迟。
      // 读一次拿不到就放弃，会表现为"扫码明明成功了却提示凭据失效"——
      // 这是用户最容易卡住、又最难自查的一类失败。
      let credential = await readPlaybackCredential();
      for (let attempt = 1; !credential && attempt <= 3; attempt += 1) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        credential = await readPlaybackCredential();
        await diag('qr/poll', `凭据读取重试 ${attempt} 次 → ${credential ? '成功' : '仍为空'}`);
      }

      if (credential) {
        await persistCredential(credential);
        credentialSaved = true;
        // ★ 配置好播放账号后**自动开启代理**（ADR 0006 的总开关）
        // 装全局常驻规则，值全局一致，之后所有白名单请求自动带播放账号凭据
        //
        // ⚠️ 这里**单独 try**：装规则失败（比如白名单里没有启用项）不该让
        // 整个登录变成失败——凭据已经存好了，用户下次还能手动开开关。
        // 把两者绑在一起会导致"码扫成功了却提示登录失败"，非常误导。
        try {
          const cookie = serializeCookie({
            SESSDATA: credential.sessdata,
            bili_jct: credential.biliJct,
            DedeUserID: credential.dedeUserId,
          });
          await enableProxy(cookie);
          await diag('qr/poll', '凭据已存并开启代理');
        } catch (e) {
          await diag(
            'qr/poll',
            `凭据已存但开启代理失败: ${e instanceof Error ? e.message.slice(0, 60) : '未知'}`,
          );
        }
      } else {
        // 读不到凭据。记下**具体缺什么**——否则只有"失败了"三个字，
        // 无法区分是权限没开、还是 cookie 落在别的域、还是用户其实没登录成功。
        // 注意：这里只记字段名和布尔，**绝不记值**。
        await diag('qr/poll', `⚠️ 登录成功但读不到凭据（${await describeMissingCookies()}）`);
      }
    }

    return { type: 'qr/poll:ok', status, credentialSaved };
  } catch (e) {
    return { type: 'qr/poll:err', detail: redactError(e) };
  }
}

/**
 * 诊断用：列出三个凭据字段各自"有没有"。
 *
 * ⚠️ **只返回字段名与有无，绝不返回值**。这个方法的存在本身是为了解决
 * "扫码成功了却读不到凭据"——那种时候用户和开发者都无从判断原因，
 * 必须有一行能直接说清是哪个字段缺失。
 */
async function describeMissingCookies(): Promise<string> {
  const names = ['SESSDATA', 'bili_jct', 'DedeUserID'] as const;
  const parts: string[] = [];

  for (const name of names) {
    try {
      const c = await chrome.cookies.get({ url: 'https://www.bilibili.com', name });
      parts.push(`${name}=${c?.value ? '有' : '无'}`);
    } catch {
      parts.push(`${name}=读取异常`);
    }
  }

  return parts.join(' ');
}
