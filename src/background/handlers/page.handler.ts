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

import { diag } from '@platform/storage/diag-store';
import { buildCookieHeader } from '@platform/http/playurl';
import { installTabRule, isProxyEnabled, removeTabRule, type PageKind } from '@platform/http/dnr';
import { readPersistedCredential } from '@platform/storage/credential-store';
import { readDeviceCookies, writeDeviceCookies } from '@platform/storage/device-cookies-store';
import type { ResponseMsg } from '@shared/types/messages';

export interface ActivatePayload {
  tabId: number;
  /** `video` = 普通视频；`pgc` = 番剧 / 国创 / 电影（ADR 0019） */
  kind: PageKind;
  /** 视频页 = bvid；PGC 页 = `ep:…` / `ss:…`。只进日志 */
  pageKey: string;
  p: number;
  deviceCookies: Record<string, string>;
  /** 主账号 mid，由 content script 从页面 cookie 读取（普通分区） */
  primaryMid: string | null;
}

/**
 * `page/activate` 的结果。
 *
 * ⚠️ `reason` **从消息协议派生**，不在这里另写一份字面量联合。
 *
 * 踩过：这里原本是独立的 `'ok' | 'not-configured' | 'same-account' | 'error'`，
 * 与 `messages.ts` 里的定义各存一份。2026-10-27 加 `'disabled'` 时只改了一处，
 * `tsc` 立刻报"两个类型不重叠" —— **是类型系统救了这次**，
 * 但那说明这个重复本身就该消掉。现在只有一个真相源。
 */
export interface ActivateResult {
  activated: boolean;
  reason: Extract<ResponseMsg, { type: 'page/activate:ok' }>['reason'];
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
    await diag(
      'page/activate 收到',
      `tab=${payload.tabId} kind=${payload.kind} page=${payload.pageKey} p=${payload.p}`,
    );

    const credential = await readPersistedCredential();
    if (!credential) {
      await diag('page/activate', '未配置凭据 → 不代理');
      // 没配置就静默退出——用户还没扫码，不该弹错
      return { activated: false, reason: 'not-configured' };
    }

    /**
     * ## 总开关关着就必须拒绝（2026-10-27 修的真实 bug）
     *
     * 踩到的现象：用户关掉总开关 → 刷新视频页 → **画质没回落**，还是 4K/杜比。
     *
     * 原因是这里**从来没检查过 `enabled`**：只要页面报到就装标签页规则。
     * 而那条规则 priority 2（高过全局的 1）、带 `tabIds`，刷新后 tabId 不变，
     * 于是它一直生效 —— popup 显示「已停用」，实际还在代理。
     *
     * `disableProxy()` 现在也会清标签页规则，但那只管"关的那一刻"。
     * 之后任何一次刷新都会把规则重新装回来，所以**必须在这里也拦住**。
     *
     * 判据是 `isProxyEnabled()` 而不是参数传入：这是唯一真相源，
     * 避免"调用方以为开着、实际已关"的分歧。
     */
    if (!(await isProxyEnabled())) {
      await diag('page/activate', '总开关已关闭 → 不装规则');
      return { activated: false, reason: 'disabled' };
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

    // ── 游客态：`primaryMid === null` 也继续代理 ──
    //
    // **2026-10-26 已实测**（InPrivate 窗口，见 `poc/verify/RESULT.md` §六「补充实测 B」）：
    //   - 网络层成功：playurl 响应确实返回 2160p · 19 条轨 · Hi-Res
    //   - 播放器层失败：只播 360p —— 它按**本地登录态**决定可选画质，游客态下不选高清
    // 所以游客拿不到高清，收益为零。
    //
    // **但仍然保留这个分支**，理由是"拒绝装规则并不能真的不代理"：
    // 全局路径规则（`enableProxy`，10000 段）对**所有标签页**生效，装不装 tab 规则
    // 都会代理。拒绝只会多一个风险 —— `document_start` 时 `document.cookie` 常为空，
    // 那时判成游客就会漏装 tab 规则，而 playurl 只在页面加载时调一次。
    //
    // 用户可见的诚实性由 UI 承担：§2.3 在未登录时说「未登录主账号，无对比基线」
    // （`core/playinfo/summary-view.ts`），角标报的是实际播放高度（360P），不吹牛。
    //
    // 只有"两个账号是同一个"时才拒绝 —— 那种情况代理毫无意义。

    // ── 设备 Cookie：页面给的为空就回退到缓存 ──
    //
    // `document_start` 时 `document.cookie` 是空的（新标签页尤其明显），
    // 页面传来的 `deviceCookies` 于是也是空对象。缺 `buvid3` 会被风控判成陌生设备，
    // 取流返回 -412 —— 这正是"首屏正常、后台恢复后坏掉"的根因。
    //
    // 缓存来自**之前某个能读到 cookie 的时刻**（DOMContentLoaded 或另一标签页）。
    // 设备标识是浏览器级的，跨标签页共用是对的。
    let deviceCookies = payload.deviceCookies;
    if (!hasBuvid(deviceCookies)) {
      const cached = await readDeviceCookies();
      if (cached) {
        deviceCookies = { ...cached, ...deviceCookies };
        await diag(
          'page/activate',
          `设备 Cookie 回退到缓存（来自 ${Object.keys(cached).length} 项）`,
        );
      } else {
        await diag('page/activate', '⚠️ 无 buvid3 且无缓存 → 该请求可能被判风控');
      }
    } else {
      // 页面上读到了就顺手更新缓存，供其它标签页 / 后续 reload 使用
      void writeDeviceCookies(deviceCookies);
    }

    const cookie = buildCookieHeader(credential, deviceCookies);
    await diag(
      'page/activate',
      `Cookie 字段=${cookie
        .split('; ')
        .map((s) => s.split('=')[0])
        .join(',')}`,
    );

    await installTabRule(payload.tabId, cookie, payload.kind);
    await diag('page/activate', `已装 DNR 规则（${payload.kind}）`);

    return { activated: true, reason: 'ok' };
  } catch (e) {
    await diag('page/activate 异常', e instanceof Error ? e.message.slice(0, 100) : String(e));
    return { activated: false, reason: 'error' };
  }
}

/** 判断设备 Cookie 里有没有可用的 buvid（缺它必被判风控） */
function hasBuvid(cookies: Record<string, string>): boolean {
  return typeof cookies.buvid3 === 'string' && cookies.buvid3.length > 0;
}

export async function handlePageDeactivate(tabId: number): Promise<void> {
  await removeTabRule(tabId);
}
