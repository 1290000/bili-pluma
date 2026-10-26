/**
 * 设备 Cookie 缓存 —— 解决"后台挂久了再回来就卡死"。
 *
 * ## 为什么必须缓存
 *
 * 原本的链路是：content script 在 `document_start` 从 `document.cookie` 读设备 Cookie
 * → 发给 background → 拼进 DNR 规则的 Cookie 头。
 *
 * **`document_start` 时 `document.cookie` 是空的。** 新开标签页尤其明显：
 * 此时文档还没建立，cookie 尚未就绪（实测踩过，ADR 0010 提到"`document_start` 补报一次"就是为此）。
 *
 * 结果：规则里的 Cookie 只有三个凭据字段、没有 `buvid3`，B站风控认不出设备，
 * 返回 `-412`。表现就是用户说的"时好时坏"——首次打开正常（DOMContentLoaded 补报带上了），
 * 后台恢复 / 标签页被丢弃后重新加载就坏（只走了 document_start 那一次）。
 *
 * ## 为什么要跨标签页共享
 *
 * 设备 Cookie 是**浏览器级**标识，同一浏览器的所有 B站标签页一致。
 * 所以任一标签页读到就能给所有标签页用，不需要每个都读。
 *
 * ⚠️ 这些都不是 httpOnly（Q5 实测），可以经 `document.cookie` 读到，
 * 不需要 `cookies` 权限。
 */

const DEVICE_KEY = 'pluma:device-cookies';

/** 设备 Cookie 的有效期。浏览器自己会刷新，我们保守取 1 天 */
const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;

interface DeviceCache {
  cookies: Record<string, string>;
  at: number;
}

/** 读出缓存的设备 Cookie；过期或不存在返回 null */
export async function readDeviceCookies(): Promise<Record<string, string> | null> {
  try {
    const bag = await chrome.storage.local.get(DEVICE_KEY);
    const cache = bag[DEVICE_KEY] as DeviceCache | undefined;
    if (!cache || typeof cache !== 'object') return null;

    const cookies = cache.cookies;
    if (!cookies || typeof cookies !== 'object') return null;

    // 至少要有一个 buvid，否则等于没缓存（缺 buvid 是 -412 的直接原因）
    const hasBuvid = typeof cookies.buvid3 === 'string' && cookies.buvid3.length > 0;
    if (!hasBuvid) return null;

    if (typeof cache.at !== 'number' || Date.now() - cache.at > DEVICE_TTL_MS) return null;

    return cookies;
  } catch {
    return null;
  }
}

/**
 * 缓存设备 Cookie。
 *
 * 只有拿到 `buvid3` 才写 —— 空对象覆盖已有缓存会让原本正常的标签页突然缺 buvid，
 * 那比缓存陈旧更糟。
 */
export async function writeDeviceCookies(cookies: Record<string, string>): Promise<void> {
  const hasBuvid = typeof cookies.buvid3 === 'string' && cookies.buvid3.length > 0;
  if (!hasBuvid) return;

  const cache: DeviceCache = { cookies, at: Date.now() };
  await chrome.storage.local.set({ [DEVICE_KEY]: cache }).catch(() => {});
}

/** 清除（退出播放账号时不需要清，但保留给诊断页用） */
export async function clearDeviceCookies(): Promise<void> {
  await chrome.storage.local.remove(DEVICE_KEY).catch(() => {});
}
