/**
 * 读取播放账号凭据 —— 全项目**唯一**碰 `chrome.cookies` 的地方。
 *
 * 为什么需要 `cookies` 权限：B站扫码登录成功后，凭据只通过 `Set-Cookie` 下发，
 * `data.url` 里没有，`fetch` 也读不到 `Set-Cookie`（forbidden response header）。
 * 见 docs/decisions/0007-cookies-permission-for-playback-credential.md。
 *
 * ⚠️ **必须在隔离的存储分区里读**（见 docs/decisions/0010-playback-login-overwrites-primary.md）：
 * 如果直接在普通窗口登录播放账号，会覆盖主账号的 SESSDATA。
 * 所以登录流程在无痕/隔离窗口里完成，读 cookie 时也要指定那个 storeId，
 * 否则读到的是主账号的（或者什么都读不到）。
 *
 * 纪律：
 *   - 只在登录那一刻调用一次
 *   - 返回值立即交给 core/vault 加密存储，内存中的明文用完即弃
 *   - 绝不打印、绝不写日志、绝不放进错误详情
 *
 * ⚠️ 用 `chrome.*` 而不是 `wxt/browser` 的 `browser`，原因见 entrypoints/background.ts 顶部注释。
 */

import type { Credential } from '@shared/types/account';

/**
 * 读 cookie 时要指定的存储分区。
 *
 * - `undefined` / 空字符串：默认分区（普通窗口，主账号所在）
 * - `'0'`：同上（Chrome 用 "0" 表示默认分区）
 * - 其他值：无痕 / 独立分区的 storeId
 *
 * **读播放账号凭据时必须传无痕分区的 storeId**，否则会读到主账号的凭据。
 */
export type StoreId = string | undefined;

/**
 * 读一个 cookie，**依次尝试多个域**。
 *
 * ## 为什么不能只查一个域
 *
 * `chrome.cookies.get({ url })` 是**按 URL 精确匹配**的。B站的 `SESSDATA` 可能挂在
 * `www.bilibili.com`（host-only），也可能挂在 `.bilibili.com`（domain cookie）。
 * 只查 `www` 会漏掉后者——表现就是"扫码明明成功了，扩展说读不到凭据"。
 *
 * 顺序很重要：先 `www`（最常见），再裸域，最后 `api` 子域。
 * 拿到第一个非空就返回，不做合并——三个字段必须来自**同一份**会话。
 */
const COOKIE_URLS = [
  'https://www.bilibili.com',
  'https://bilibili.com',
  'https://api.bilibili.com',
] as const;

async function readOne(name: string, storeId: StoreId): Promise<string | null> {
  for (const url of COOKIE_URLS) {
    try {
      const details: chrome.cookies.CookieDetails = { url, name };
      if (storeId) details.storeId = storeId;

      const cookie = await chrome.cookies.get(details);
      const value = cookie?.value;
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      // 某个域查失败不影响继续试下一个
    }
  }
  return null;
}

/**
 * 读三个必要的凭据。任一缺失就返回 null（说明没登录成功，或 cookie 没落到 www 域）。
 *
 * `DedeUserID` 同时承担"校验 sessdata 与 bili_jct 是否同源"的作用：
 * 三者来自同一个账号才是一套有效凭据。
 *
 * @param storeId 无痕分区的 storeId。**登录播放账号后必须传**，否则读到主账号
 */
export async function readPlaybackCredential(storeId?: StoreId): Promise<Credential | null> {
  const [sessdata, biliJct, dedeUserId] = await Promise.all([
    readOne('SESSDATA', storeId),
    readOne('bili_jct', storeId),
    readOne('DedeUserID', storeId),
  ]);

  if (!sessdata || !biliJct || !dedeUserId) return null;

  return { sessdata, biliJct, dedeUserId };
}

/**
 * 列出所有存在的 cookie 分区。
 *
 * 用来找"哪个分区里有播放账号的 cookie"——用户可能在任意一个无痕窗口里登录。
 * 主账号在默认分区（storeId 为空或 "0"），要排除掉。
 */
export async function listNonDefaultStores(): Promise<string[]> {
  try {
    const all = await chrome.cookies.getAll({ domain: 'bilibili.com' });
    const stores = new Set<string>();
    for (const c of all) {
      const id = c.storeId;
      if (id && id !== '0') stores.add(id);
    }
    return [...stores];
  } catch {
    return [];
  }
}
