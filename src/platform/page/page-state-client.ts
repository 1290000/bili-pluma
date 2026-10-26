/**
 * 查询"当前视频页的取流数据" —— 扩展页面（设置页 / 自检页）共用的一个入口。
 *
 * ## 为什么抽出来
 *
 * 这段逻辑有两个使用者（`entrypoints/diagnostics` 与 `entrypoints/options`），
 * 而它里面埋着一个很容易再踩的坑：**不能只看 `active` 标签页**。
 * 设置页与自检页都是 `open_in_tab` 打开的，它们自己就是活动标签页 ——
 * 用 `query({active:true})` 查到的永远是自己，`sendMessage` 必然失败，
 * 表现却像"这个页面没有 content script"，极难排查。
 *
 * 分层：`platform/` 是唯一允许碰 `chrome.*` 的地方；本文件只做"找标签页 + 转发消息"，
 * 不解析业务（解析在 `src/content/isolated/page-state.ts`）。
 */

import type { PageTracksView } from '@shared/types/playinfo';

/** 只有这些 URL 上的 content script 会应答 */
const VIDEO_TAB_QUERY = { url: ['*://*.bilibili.com/video/*'] };

export type PageStateResult =
  /** 拿到了当前页数据 */
  | { kind: 'ok'; view: PageTracksView; tabId: number; title: string }
  /** 一个 B站视频页都没开着 */
  | { kind: 'no-tab' }
  /** 有视频页，但那个标签页里没有 content script（扩展刚装/更新，页面是旧的） */
  | { kind: 'no-content-script'; title: string }
  /** content script 在，但还没报到（刚注入、页面还没解析出 bvid） */
  | { kind: 'not-ready'; title: string };

/**
 * 挑一个视频标签页：优先活动的，否则最近访问的。
 *
 * 按 URL 过滤而不是按 active —— 见文件头注释。
 */
export async function pickVideoTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query(VIDEO_TAB_QUERY).catch(() => [] as chrome.tabs.Tab[]);
  if (tabs.length === 0) return null;

  const active = tabs.find((t) => t.active);
  if (active) return active;

  return tabs.reduce<chrome.tabs.Tab>((best, t) => {
    const a = t.lastAccessed ?? 0;
    const b = best.lastAccessed ?? 0;
    return a > b ? t : best;
  }, tabs[0] as chrome.tabs.Tab);
}

/**
 * 查当前视频页的两侧取流数据。
 *
 * ⚠️ 目标标签页没有 content script 时 `sendMessage` 会**抛异常**（不是返回空），
 * 所以这里必须 catch，并把"没有脚本"和"还没报到"区分开 —— 两者的处理方式完全不同：
 * 前者要用户刷新页面，后者只要等一下。
 */
export async function queryPageState(): Promise<PageStateResult> {
  const tab = await pickVideoTab();
  if (!tab || typeof tab.id !== 'number') return { kind: 'no-tab' };

  const title = tab.title ?? tab.url ?? '?';

  let reply: { type?: string; view?: PageTracksView } | undefined;
  try {
    reply = (await chrome.tabs.sendMessage(tab.id, { type: 'page/summary:get' })) as
      { type?: string; view?: PageTracksView } | undefined;
  } catch {
    return { kind: 'no-content-script', title };
  }

  if (reply?.type !== 'page/summary:ok' || !reply.view) return { kind: 'not-ready', title };
  return { kind: 'ok', view: reply.view, tabId: tab.id, title };
}
