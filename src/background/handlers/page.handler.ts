/**
 * 页面激活处理 —— content script 报到后，给这个标签页装代理规则。
 *
 * 流程：
 *   1. 检查是否配置了播放账号，没有就什么都不做（用户还没登录）
 *   2. 读凭据（解密）
 *   3. 拼 Cookie 头（播放账号凭据 + 页面设备 Cookie）
 *   4. 装 tabIds 限定的长驻规则
 *
 * ⚠️ 凭据只在这个函数栈里出现，不进返回值、不进日志。
 */

import { diag } from '@/src/background/login-window';
import { buildCookieHeader } from '@platform/http/playurl';
import { installTabRule, removeTabRule } from '@platform/http/dnr';
import { readPersistedCredential } from '@platform/storage/credential-store';

export interface ActivatePayload {
  tabId: number;
  bvid: string;
  p: number;
  deviceCookies: Record<string, string>;
  /** 主账号 mid，由 content script 从页面 cookie 读取（普通分区） */
  primaryMid: string | null;
}

export interface ActivateResult {
  activated: boolean;
  reason: 'ok' | 'not-configured' | 'same-account' | 'error';
}

/**
 * 同账号判断用**页面传来的 mid**，不从 background 发 nav 请求。
 *
 * ⚠️ 踩过的坑：原来在 background 里 `fetch(nav)` 读 mid，
 * 但 `incognito: "split"` 下扩展可能跑在无痕实例里，
 * 那个 fetch 带的是**无痕分区**的 cookie（播放账号），
 * 于是得出"两账号相同"的错误结论，把正常情况也拒绝掉了。
 *
 * 页面 cookie 里的 `DedeUserID` 才是主账号的真实 mid。
 */
export async function handlePageActivate(payload: ActivatePayload): Promise<ActivateResult> {
  try {
    await diag('page/activate 收到', `tab=${payload.tabId} bvid=${payload.bvid} p=${payload.p}`);

    const credential = await readPersistedCredential();
    if (!credential) {
      await diag('page/activate', '未配置凭据 → 不代理');
      // 没配置就静默退出——用户还没扫码，不该弹错
      return { activated: false, reason: 'not-configured' };
    }

    await diag(
      'page/activate',
      `播放账号 mid=${credential.dedeUserId} 主账号 mid=${String(payload.primaryMid)}`,
    );

    // 同账号检查：两个账号相同时代理毫无意义，明确拒绝而不是假装在工作
    if (payload.primaryMid !== null && payload.primaryMid === credential.dedeUserId) {
      await diag('page/activate', '两账号相同 → 拒绝代理');
      return { activated: false, reason: 'same-account' };
    }

    const cookie = buildCookieHeader(credential, payload.deviceCookies);
    await diag(
      'page/activate',
      `Cookie 字段=${cookie
        .split('; ')
        .map((s) => s.split('=')[0])
        .join(',')}`,
    );

    await installTabRule(payload.tabId, cookie);
    await diag('page/activate', '已装 DNR 规则');

    return { activated: true, reason: 'ok' };
  } catch (e) {
    await diag('page/activate 异常', e instanceof Error ? e.message.slice(0, 100) : String(e));
    return { activated: false, reason: 'error' };
  }
}

export async function handlePageDeactivate(tabId: number): Promise<void> {
  await removeTabRule(tabId);
}
