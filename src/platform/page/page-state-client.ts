/**
 * 查询"当前视频页的取流数据" —— 从**扩展页面**（popup / 设置页等特权脚本）发起。
 *
 * ## ⚠️ 2026-11-10 起**没有生产调用方**（请读完再决定要不要删）
 *
 * options 页废除后（ADR 0033），`queryPageState()` 的唯一调用点是
 * `src/platform/diagnostics/collect.ts` 里 `pageTracksRows()` 的
 * **`injected === undefined` 分支**。而页内面板**总是传 `null` 或一个对象**
 * （见 `CollectOptions.pageView`），所以真机上**走不到这里**。
 *
 * ### 为什么仍然保留
 *
 * 1. **`CollectOptions.pageView` 的三态语义依赖它**：
 *    `undefined` = "我不知道，你去查" / `null` = "查过了，没有" / 对象 = "用这份"。
 *    删掉 `queryPageState()`，`undefined` 这一态就失去了实现，整个三态设计塌了一半。
 * 2. **它是"扩展页面查视频标签页"的唯一现成实现**，`PageStateResult` 的
 *    四态（`ok` / `no-tab` / `no-content-script` / `not-ready`）已经过真机验证。
 *    将来若加回任何扩展页面（独立设置窗口等），它就是现成的。
 *
 * ### 若要删，**不是一个文件的事**
 *
 * - 必须同时改 `scripts/check-page-gate.mjs` 规则 2b/3 的注释
 *   （那两处专门讲这个文件是边界说明，删文件不改注释会让它们指向空气）
 * - 必须把 `CollectOptions.pageView` 的 `undefined` 态**重新设计**
 * - 按 `AGENTS.md` §7，改检查脚本前**先问**
 *
 * ## 当初为什么抽出来
 *
 * 这段逻辑曾有两个使用者（已删除的 `entrypoints/diagnostics` 与 options），
 * 而它里面埋着一个很容易再踩的坑：**不能只看 `active` 标签页**。
 * 设置页与自检页都是 `open_in_tab` 打开的，它们自己就是活动标签页 ——
 * 用 `query({active:true})` 查到的永远是自己，`sendMessage` 必然失败，
 * 表现却像"这个页面没有 content script"，极难排查。
 *
 * 分层：`platform/` 是唯一允许碰 `chrome.*` 的地方；本文件只做"找标签页 + 转发消息"，
 * 不解析业务（解析在 `src/content/isolated/page-state.ts`）。
 */

import type { PageTracksView } from '@shared/types/playinfo';
import { PLAY_PAGE_URL_PATTERNS } from '@shared/utils/video-page';

/**
 * 只有这些 URL 上的 content script 会应答。
 *
 * ⚠️ 用共享常量，**不要在这里写字面量**：这里曾写死 `*://*.bilibili.com/video/*`，
 * 于是开着番剧页时 `pickVideoTab()` 返回 null，options 的主账号卡片与诊断页的
 * 「当前页取流数据」都显示"打开任意视频页后可见"（2026-10-28 修）。
 */
const VIDEO_TAB_QUERY = { url: [...PLAY_PAGE_URL_PATTERNS] };

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
