/**
 * 探测播放账号凭据是否仍然有效 —— 用 `nav` 接口。
 *
 * ## 为什么不能用「手动拼 Cookie 头 + fetch」
 *
 * 曾经的实现：
 *
 * ```js
 * fetch(NAV_URL, { credentials: 'omit', headers: { cookie: '...' } })
 * ```
 *
 * **这行不通。** `Cookie` 是 **forbidden request header**——脚本设置它会被浏览器
 * 静默丢弃（Web 平台硬限制，和 MV3 无关）。结果请求以"未登录"身份发出，
 * 返回 `-101`，于是被判定成"凭据失效"，而实际上凭据完全正常。
 *
 * 这个 bug 的表现极具迷惑性：**画质能正常播到 2160p，popup 却说凭据失效。**
 * 因为 DNR 换 Cookie 是网络层的，不受这个限制；而探活走的是 JS `fetch`，受限。
 *
 * ## 现在的做法
 *
 * 用 `credentials: 'include'`，让**浏览器自己**带上该域名在本分区的 cookie。
 *
 * 前提是这条探测请求要跑在**播放账号所在的那个分区**。
 * `incognito: "split"` 下无痕分区有独立 SW 实例，扫码头就落在那里，
 * 所以登录窗口触发的探测天然正确。
 *
 * 分区不对时会探测到主账号 —— 用 `mid` 比对来识别这种情况（见 `checkCredential`）。
 */

import { judgeNav, type NavProbe, type NavResponse } from '@core/auth/account-info';
import { NAV_URL } from '@shared/constants/routes';
import type { Credential } from '@shared/types/account';

/** 探测超时。nav 通常 200ms 内返回，8 秒足够容错 */
const NAV_TIMEOUT_MS = 8_000;

/**
 * 用**当前分区的登录态**探测 nav。
 *
 * 注意：不再接收 credential 参数——因为无法用它构造 Cookie 头（见文件头说明）。
 * 凭据只用来**核对探测结果属于哪个账号**，不参与构造请求。
 */
export async function probeNav(): Promise<NavProbe> {
  let res: Response;
  try {
    res = await fetch(NAV_URL, {
      method: 'GET',
      // include：让浏览器带上本分区 bilibili.com 的 cookie。
      // 这是唯一合法的"以某个身份请求"的方式——手动设 Cookie 头会被丢弃
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(NAV_TIMEOUT_MS),
    });
  } catch {
    // 网络失败 / 超时 —— 不是凭据问题，交给 judgeNav 归为 unknown
    return { reachable: false, code: null };
  }

  if (!res.ok) {
    // HTTP 层失败（5xx / 412 页面拦截）。同样是 unable-to-confirm，不是失效
    return { reachable: false, code: null };
  }

  let body: NavResponse;
  try {
    body = (await res.json()) as NavResponse;
  } catch {
    return { reachable: false, code: null };
  }

  return {
    reachable: true,
    code: typeof body.code === 'number' ? body.code : null,
    data: body.data,
  };
}

/**
 * 探测 + 用 `mid` 核对"这次探测到的确实是我们的播放账号"。
 *
 * ## 为什么要核对 mid
 *
 * `credentials: 'include'` 带的是**当前分区**的登录态。
 * 如果探测请求跑在了普通分区（主账号在那里），会拿到主账号的 mid / 会员状态，
 * 于是把一个完全正常的配置判定成"不是会员"或"两个号相同"。
 *
 * 拿到的 mid 与凭据里的 `dedeUserId` 不一致 → 说明探测跑错了分区，
 * 结论**不可用**，应当报 `unknown` 而不是 `expired`。
 *
 * @param credential 只用来核对 mid，不参与构造请求
 * @param now 时间戳，保证判定可测
 */
export async function checkCredential(credential: Credential, now: number) {
  const probe = await probeNav();

  // 探测到了别的账号 → 分区不对，结论作废
  if (probe.reachable && probe.code === 0 && probe.data?.mid !== undefined) {
    const probedMid = String(probe.data.mid);
    if (probedMid !== credential.dedeUserId) {
      return {
        kind: 'unknown' as const,
        reason: '探测请求跑在了错误的浏览器分区（拿到的账号不是播放账号）',
      };
    }
  }

  return judgeNav(probe, now);
}
