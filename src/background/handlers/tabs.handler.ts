/**
 * 「哪些已打开的视频页还挂着旧画质」—— 总开关切换后必须告诉用户这件事。
 *
 * ## 为什么这是个真问题
 *
 * Q3 实测：**playurl 只在页面加载和切 P 时调用一次**。切画质、拖进度、
 * 长时间播放都不会重新请求。
 *
 * 也就是说，一个已经打开的视频页，它的 dash 轨道列表在你按下开关**之前**
 * 就已经确定了。之后改 DNR 规则对它毫无作用——它的播放器手里没有新的轨道。
 *
 * 所以用户关掉开关、回到已打开的视频页，会发现"还是 4K"，
 * 然后合理地怀疑开关是坏的。必须主动提示"要刷新"。
 *
 * ## 为什么不用 `tabs.query({ url: ... })`
 *
 * 那会列出一堆"理论上可能受影响"的标签页，包括刚打开还没加载完的、
 * 以及没装规则的。用户看到"5 个页面需要刷新"，其中 3 个其实无关，就不会信这个提示。
 *
 * 这里用 **DNR 规则里的 tabIds** 作为判据：只有真的装了代理规则、
 * 且标签页还活着的，才算"已锁定旧画质"。
 */

import type { ResponseMsg } from '@shared/types/messages';

const TAB_RULE_BASE = 20000;
const TAB_RULE_SPAN = 10000;

/** B站视频详情页 URL。与 `shared/utils/video-page.ts` 的匹配范围保持一致 */
function isVideoUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\/(www\.)?bilibili\.com\/video\//.test(url);
}

/**
 * 找出**当前装了代理规则、且仍是视频页**的标签页。
 *
 * 过滤掉非视频页很重要：用户可能已经从视频页导航到首页，
 * 但标签页关闭事件还没到，规则还在。那种页面不需要刷新。
 */
export async function findAffectedTabs(): Promise<number[]> {
  const [rules, tabs] = await Promise.all([
    chrome.declarativeNetRequest.getSessionRules().catch(() => []),
    chrome.tabs.query({}).catch(() => []),
  ]);

  const ruledTabIds = new Set(
    rules
      .filter((r) => r.id >= TAB_RULE_BASE && r.id < TAB_RULE_BASE + TAB_RULE_SPAN)
      .flatMap((r) => r.condition.tabIds ?? []),
  );

  if (ruledTabIds.size === 0) return [];

  return tabs
    .filter((t) => typeof t.id === 'number' && ruledTabIds.has(t.id) && isVideoUrl(t.url))
    .map((t) => t.id as number);
}

export async function handleAffectedTabs(): Promise<ResponseMsg> {
  try {
    const tabIds = await findAffectedTabs();
    return { type: 'proxy/affected-tabs:ok', count: tabIds.length, tabIds };
  } catch {
    // 查不出来就不提示。提示一个可能错的数字比不提示更糟
    return { type: 'proxy/affected-tabs:ok', count: 0, tabIds: [] };
  }
}

/**
 * 刷新指定标签页。
 *
 * 只刷新传进来的那些——**不做"刷新所有 B站页面"**，
 * 那会连带毁掉用户没在看的页面上的输入（比如正在写的评论）。
 */
export async function handleTabsReload(tabIds: number[]): Promise<ResponseMsg> {
  let reloaded = 0;
  for (const id of tabIds) {
    try {
      await chrome.tabs.reload(id);
      reloaded += 1;
    } catch {
      // 标签页可能在用户点按钮前就被关了。跳过即可
    }
  }
  return { type: 'tabs/reload:ok', reloaded };
}
