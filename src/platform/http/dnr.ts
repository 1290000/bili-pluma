/**
 * DNR 规则管理 —— **整个项目风险最高的文件**。
 *
 * 设计依据：[ADR 0006](../../../docs/decisions/0006-no-per-request-nonce.md)
 * （Q2 实测：180 并发零串号，**不需要 per-request nonce**）
 *
 * ## 核心模型
 *
 * 白名单路径**每条一条常驻 session 规则**，规则 ID 由路径索引固定分配，
 * Cookie 值全局一致（整个会话内都是同一个播放账号）。
 *
 * 没有 per-request 的 add/remove，因此没有：
 *   - 规则 ID 池与回收
 *   - nonce 与 urlFilter 精确匹配
 *   - try/finally 清理
 *   - 并发撞车（不存在的请求区分问题）
 *
 * ## 三条硬性配套（ADR 0006 点名的，缺一条就不算实现完）
 *
 * 1. **总开关**：凭据失效时必须能一键停用（= 删掉所有规则）。
 *    规则常驻意味着凭据一失效，所有白名单路径一起变未登录 —— 没有开关就是不可用。
 * 2. **SW 启动自愈**：`sessionRules` 在浏览器重启后清空，SW 启动时必须**重建**。
 * 3. **`playview` 例外**：`/ogv/player/playview`（GET）**绝不能进白名单**。
 *    一开 Cookie 就换成播放账号，服务端返回的流形态从「durl 4 组 × 6 分钟」变成
 *    「完整集 dash」，而播放器已按 durl 分支准备好 → **灰屏**（两次实测）。
 *    正确做法是主世界拦它的响应换流（[ADR 0023](../../../docs/decisions/0023-intercept-playview-durl-swap.md)）。
 *    ⚠️ 曾在这里写「它是 POST、csrf 在 body 里，所以 DNR 改不了」——**方法就写错了**，
 *    而且那个理由会把人引向"改成 JS 重建请求"的错路上。
 *
 * ⚠️ **本文件无法用 Vitest 测**（DNR 在 Node 里不存在）。
 * 改动后必须重跑 `poc/q2-dnr-concurrency/`，那是它唯一的自动化验证手段。
 */

import { readPersistedCredential } from '@platform/storage/credential-store';
import { BILI_API_HOSTS, ENABLED_ROUTE_PATHS, isProxyPath } from '@shared/constants/routes';
import { serializeCookie } from '@shared/utils/cookie';

/**
 * 规则 ID 分配。
 *
 * 按路径索引固定分配：同一路径永远用同一个 ID，不轮转、不复用。
 * 分三个区段避免与将来的其他规则集撞车：
 *   10000–10999  路径常驻规则（全局，整个浏览器范围）
 *   20000–29999  标签页限定规则（ADR 0010，页面代理用）
 */
const PATH_RULE_BASE = 10000;

/** 标签页规则区段（ADR 0010） */
const TAB_RULE_BASE = 20000;

/** 标签页规则区段大小，用于识别"哪些是我们的" */
const TAB_RULE_SPAN = 10000;

/** 路径常驻规则区段大小 */
const PATH_RULE_SPAN = 1000;

/**
 * 路径 → 规则 ID。**按白名单下标止式分配**（B-05，2026-10-29）。
 *
 * ## 为什么不再用哈希
 *
 * 原实现把路径散列到 1000 个槽：
 * ```js
 * let h = 0;
 * for (...) h = (h * 31 + path.charCodeAt(i)) % PATH_RULE_SPAN;
 * return PATH_RULE_BASE + h;
 * ```
 * 白名单只有 3 条时实测不碰撞（10170 / 10891 / 10900），但**碰撞概率随条数平方增长**：
 * 按生日问题估算，扩到约 40 条时碰撞概率已过半。
 *
 * 碰撞的后果不是报错，是**静默覆盖**：两条路径算出同一个 ID →
 * `updateSessionRules` 后一条顶掉前一条 → 有一条 playurl 永远不带播放账号 Cookie →
 * 那条路径的画质静默回落，而 popup 上一切正常。
 * 属于「能骗过用户的 bug」，比报错严重（`docs/plans/1.0.0-release-plan.md` §6.2 判据 1）。
 *
 * 止式分配天然无碰撞：数组下标就是 ID 的偏移。
 *
 * ## ⚠️ ID 稳定性依赖白名单（`ENABLED_ROUTE_PATHS`）的顺序
 *
 * **改顺序 = 改 ID**，会让已装的规则失效一次（旧 ID 的规则留在 `sessionRules` 里
 * 直到 SW 重启或 `removeAllPathRules()`，新 ID 的规则同时存在 → 短暂重复）。
 * 实际影响很小（规则内容一样，都是同一条 Cookie），但要知道这件事存在：
 * 增删路径时**往后追加**，不要插到中间。
 *
 * ## 不在白名单里就返回 -1
 *
 * 选 -1 而不是抛错：调用方 `buildPathRule()` 已经在前面用 `isProxyPath()` 过滤了一道，
 * 走到这里是"调用方漏了守卫"的编程错误。返回 -1 会让 `buildPathRule()` 之后的
 * `.filter((r) => r !== null)` 之外多出一个"ID 非法"的规则，**加一条显式断言更好**——
 * 见 `buildPathRule()` 里的 `if (id < 0) return null`。
 *
 * 为什么不抛错：`enableProxy()` / `installPathRules()` 都在异步链上，
 * 抛错会变成一次未处理的 rejection（SW 里表现为"什么都没发生"）。
 * 静默返回 null + 一条 `console.error` 更容易定位。
 *
 * @param path 白名单里的路径
 * @returns 规则 ID；不在白名单里返回 -1
 */
function ruleIdForPath(path: string): number {
  const index = ENABLED_ROUTE_PATHS.indexOf(path);
  if (index < 0) return -1;
  return PATH_RULE_BASE + index;
}

// ── 总开关 ──

/**
 * 总开关状态。存在 `storage.local`，跨 SW 重启保留。
 *
 * 默认：**配置好播放账号后自动开启**（见 `enableProxy()`）。
 * 用户手动关闭后保持关闭，直到再次手动开启。
 */
const ENABLED_KEY = 'pluma:proxy-enabled';

/**
 * 总开关在 `storage.local` 里的键名，**对外只读导出**。
 *
 * ## 为什么必须导出
 *
 * `entrypoints/content.ts` 要监听这个键的变化来同步 `localStorage` 的
 * 「开关关着」标记（ADR 0028 第一层）。那边原来只能照着注释里写的字面量
 * 再抄一份 —— 那就成了**第二个真相源**，改一处忘一处就是"门控静默失效"。
 *
 * ⚠️ **只读权限**：这里只导出常量，不导出任何写入口。写仍然只走
 * `enableProxy()` / `disableProxy()`，两者都是 async 且带规则增删的完整语义。
 * 拿到这个字符串直接 `chrome.storage.local.set` 会绕过 DNR 规则维护，
 * 造出"开关 true、规则 0 条"的不一致状态 —— **不要那么做**。
 */
export const PROXY_ENABLED_KEY = ENABLED_KEY;

export async function isProxyEnabled(): Promise<boolean> {
  const bag = await chrome.storage.local.get(ENABLED_KEY);
  return bag[ENABLED_KEY] === true;
}

/**
 * 开启代理：装规则、置状态。
 *
 * ## 为什么"一条规则都没装"时要报错而不是照置 true
 *
 * 白名单的 `enabled` 是可能全为 false 的（B站改路径、或临时禁掉某条时）。
 * 那种情况下如果仍然写 `ENABLED_KEY: true`，就会出现
 * **"总开关显示已接管，实际一条规则都没有"** 的不一致状态——
 * 用户看到的和实际发生的不一样，这是最难排查的一类 bug。
 *
 * @param cookie 播放账号的完整 Cookie 头值
 * @param paths  要代理的路径列表（默认取白名单）
 * @throws 当没有任何可代理的路径时
 */
export async function enableProxy(cookie: string, paths?: string[]): Promise<void> {
  const targets = paths ?? defaultProxyPaths();

  const addRules = targets
    .map((p) => buildPathRule(p, cookie))
    .filter((r): r is chrome.declarativeNetRequest.Rule => r !== null);

  if (addRules.length === 0) {
    throw new Error('白名单里没有启用中的代理路径，无法开启');
  }

  // ⚠️ 必须先清整个路径规则段，不能只删"当前白名单算出的 ID"——见 installPathRules 的注释（O1）
  await removeAllPathRules();

  await chrome.declarativeNetRequest.updateSessionRules({ addRules });

  await chrome.storage.local.set({ [ENABLED_KEY]: true });
}

/**
 * 关闭代理：删掉所有常驻规则、置状态。
 *
 * 这是凭据失效时的兜底 —— 不删的话所有 playurl 会一起变未登录，
 * 用户会以为网站坏了。
 *
 * ## ⚠️ 必须同时删**两类**规则（2026-10-27 修的真实 bug）
 *
 * 曾经这里只调 `removeAllPathRules()`，删的是 10000 段的全局路径规则。
 * **20000 段的标签页规则从来没被删过。**
 *
 * 后果：用户关掉总开关 → 刷新视频页 → **画质不回落，还是 4K/杜比**。
 * 因为标签页规则 priority 2（高于全局的 1）、带 `tabIds`、覆盖 playurl，
 * 刷新不换标签页 ID，它就一直在生效。而 popup 因为读了 `enabled=false`
 * 而显示「已停用」—— **界面说停了，实际还在代理**，这是最坏的一类不一致。
 *
 * 验收判据 5（关开关 → 刷新后画质回落）当时就是这么漏过去的：
 * 它验的是"界面显示对"，没验"真的没在代理"。
 */
export async function disableProxy(): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: false });
  await removeAllPathRules();
  await removeAllTabRules();
}

// ── 规则构建 ──

/**
 * 把路径变成一条 DNR 规则。
 *
 * 两个条件分开写，比挤在一个 `||` 里更好读：
 *   - `urlFilter`：只负责"路径里有没有这一截"
 *   - `requestDomains`：只负责"是不是 api.bilibili.com"
 *
 * ⚠️ DNR 的 `||` 是域名锚点，`||api.bilibili.com/path` 也能用（已验证），
 * 但拆开后语义更清楚，改路径时不容易出错。
 */
function buildPathRule(path: string, cookie: string): chrome.declarativeNetRequest.Rule | null {
  if (!isProxyPath(path)) return null;

  /**
   * `isProxyPath()` 与 `ruleIdForPath()` 的判定**不是同一件事**，两道都要：
   *   - `isProxyPath()` 用 `===` / `startsWith(path + '/')`，会放行 `/x/player/playurl/xxx`
   *   - `ruleIdForPath()` 用 `indexOf()`，只认**完全相等**的路径
   *
   * 于是存在一种输入两个都"不管"：白名单是 `/x/player/playurl`、
   * 传进来的是 `/x/player/playurl/extra` —— 第一道放行，第二道返回 -1。
   * 此时它的名字是 `buildPathRule(path)`，拼出来的 `urlFilter` 会是一条**没被授权**的路径，
   * 所以这里直接丢弃（返回 null），而不是造一条 ID 为 -1 的规则。
   *
   * 当前唯一调用方 `defaultProxyPaths()` 直接取 `ENABLED_ROUTE_PATHS`，走不到这条路；
   * 这个守卫是给 `enableProxy(cookie, paths)` 的显式传参留的 —— 那是公开 API。
   */
  const id = ruleIdForPath(path);
  if (id < 0) {
    console.error(`[dnr] 路径不在白名单里，无法分配规则 ID：${path}（已忽略）`);
    return null;
  }

  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'set', value: cookie }],
    },
    condition: {
      urlFilter: path,
      requestDomains: [...BILI_API_HOSTS],
      resourceTypes: ['xmlhttprequest'],
      // 只代理 GET。白名单里全部是 GET；`playview` 也是 GET，但**不能进白名单**
      // （换 Cookie 后返回 dash，与播放器期望的 durl 冲突 → 灰屏，见文件头第 3 条）
      requestMethods: ['get'],
    },
  };
}

/** 默认要代理的路径。直接取白名单的 enabled 项，避免两处维护 */
function defaultProxyPaths(): string[] {
  return [...ENABLED_ROUTE_PATHS];
}

// ── SW 启动自愈 ──

/**
 * SW 启动自愈 —— **ADR 0006 点名的硬性配套**。
 *
 * 做两件事：
 *   1. 清掉残留规则（浏览器崩溃/强杀留下的，不属于当前会话）
 *   2. **如果总开关是开的，重建规则** —— `sessionRules` 浏览器重启即清空，
 *      不重建的话代码以为在代理，实际一条规则都没有，功能静默失效。
 *
 * 重建需要 Cookie，从 vault 读。读不到（未配置/解密失败）就关掉总开关，
 * 避免"开关开着但规则没有"的不一致状态。
 *
 * @returns rebuilt 重建条数，cleared 清理的残留条数
 */
export async function rebuildRulesIfEnabled(): Promise<{ rebuilt: number; cleared: number }> {
  const cleared = await removeAllPathRules();

  if (!(await isProxyEnabled())) {
    return { rebuilt: 0, cleared };
  }

  // 开关是开的 → 需要 Cookie 重建
  const credential = await readPersistedCredential().catch(() => null);
  if (!credential) {
    // 配置丢了但开关还开着 —— 关掉，避免不一致
    await chrome.storage.local.set({ [ENABLED_KEY]: false });
    return { rebuilt: 0, cleared };
  }

  const cookie = serializeCookie({
    SESSDATA: credential.sessdata,
    bili_jct: credential.biliJct,
    DedeUserID: credential.dedeUserId,
  });

  const count = await installPathRules(cookie);
  return { rebuilt: count, cleared };
}

/**
 * 装全局路径规则（不含标签页规则），返回装了几条。
 *
 * ## ⚠️ `removeRuleIds` 必须覆盖**整个路径规则段**，不能只算当前白名单的 ID
 *
 * 2026-10-30 修（O1）。原实现是：
 *
 * ```ts
 * removeRuleIds: addRules.map((r) => r.id)   // 只删"当前白名单算出的那几个 ID"
 * ```
 *
 * 这在**插入**路径时没问题：新旧 ID 集合互相覆盖。
 * 但**删掉白名单中间一项**时会留下残留 —— 旧的后位 ID 不在新集合里：
 *
 * ```
 * 旧白名单 [wbi, playurl, pgc] → ID 10000 / 10001 / 10002（Cookie=旧账号）
 * 新白名单 [wbi, pgc]          → ID 10000 / 10001（Cookie=新账号）
 *                                ↑ 10002 原属 pgc，且**不被删除** → 残留
 * ```
 *
 * 残留那条规则的 Cookie 是**上一次的**。若用户在此期间换过播放账号，
 * 它会继续带着**旧账号凭据**发请求 —— 正是本文件开头说的那种
 * 「能骗过用户的 bug」：画质静默异常，而 popup 上一切正常。
 *
 * 所以这里改为先**扫出该段所有现存规则**再一起删（`listPathRuleIds()`），
 * 让"白名单增删"这件事不再依赖"只能往后追加"这条需要人记住的纪律。
 *
 * 代价：多一次 `getSessionRules()`（微秒级，且本来 `removeAllPathRules` 也在做同样的事）。
 */
async function installPathRules(cookie: string): Promise<number> {
  const addRules = defaultProxyPaths()
    .map((p) => buildPathRule(p, cookie))
    .filter((r): r is chrome.declarativeNetRequest.Rule => r !== null);

  // 先清掉整个路径规则段（含已不在白名单里的残留 ID），再原子性 add。
  // 顺序不能反：反了就等于"先加新的再删旧的"，中间态会有重复规则。
  await removeAllPathRules();

  if (addRules.length === 0) return 0;

  await chrome.declarativeNetRequest.updateSessionRules({ addRules });

  return addRules.length;
}

/** 删掉所有路径常驻规则，返回删除数量 */
async function removeAllPathRules(): Promise<number> {
  const rules = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  const ours = rules
    .filter((r) => r.id >= PATH_RULE_BASE && r.id < PATH_RULE_BASE + PATH_RULE_SPAN)
    .map((r) => r.id);

  if (ours.length === 0) return 0;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ours }).catch(() => {});
  return ours.length;
}

/**
 * 删掉**所有**标签页限定规则，返回删除数量。
 *
 * 与 `removeStaleTabRules` 的区别：那个只删"标签页已不存在"的，
 * 这个**无条件全删**——关总开关时用。两者不能互相代替：
 * 关开关时标签页还活着，`removeStaleTabRules` 一条都不会删。
 */
async function removeAllTabRules(): Promise<number> {
  const rules = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  const ours = rules
    .filter((r) => r.id >= TAB_RULE_BASE && r.id < TAB_RULE_BASE + TAB_RULE_SPAN)
    .map((r) => r.id);

  if (ours.length === 0) return 0;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ours }).catch(() => {});
  return ours.length;
}

/** 删掉指向已关闭标签页的规则（ADR 0010） */
async function removeStaleTabRules(): Promise<number> {
  const [rules, tabs] = await Promise.all([
    chrome.declarativeNetRequest.getSessionRules().catch(() => []),
    chrome.tabs.query({}).catch(() => []),
  ]);

  const tabRules = rules.filter(
    (r) => r.id >= TAB_RULE_BASE && r.id < TAB_RULE_BASE + TAB_RULE_SPAN,
  );

  if (tabRules.length === 0) return 0;

  const liveTabs = new Set(tabs.map((t) => t.id).filter((x): x is number => typeof x === 'number'));

  /**
   * ⚠️ **不能用 `r.id - TAB_RULE_BASE` 反推 tabId。**
   *
   * 规则 ID 是 `TAB_RULE_BASE + (tabId % TAB_RULE_SPAN)`，取模之后信息已经丢了：
   * tabId 10005 的规则 ID 是 20005，反推得 5，于是去问"标签页 5 还在吗"——
   * 不在就**删掉 tab 10005 那条有效规则**，该页画质静默回落到主账号，且没有任何报错。
   *
   * 单个会话累计开满 10000 个标签页就会碰到（长期不重启的机器可达）。
   * 正确做法是读规则自己带的 `tabIds` —— `tabs.handler.ts` 一直是这么写的。
   */
  const stale = tabRules
    .filter((r) => {
      const ids = r.condition.tabIds ?? [];
      // 一条 tab 规则只该挂一个 tabId；挂了多个说明规则被人改过，按"任一存活即保留"处理
      return ids.length > 0 && ids.every((id) => !liveTabs.has(id));
    })
    .map((r) => r.id);

  if (stale.length === 0) return 0;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale }).catch(() => {});
  return stale.length;
}

// ── 页面代理：标签页限定规则（ADR 0010） ──

/**
 * 标签页规则要代理的取流路径 —— 按页面类型分。
 *
 * 两类页面取流接口不同：
 *   - 普通视频：页面自己发 `/x/player/wbi/playurl`
 *   - PGC（番剧/国创/电影）：页面**不发**，由主世界主动调 `/pgc/player/web/playurl`（ADR 0019）
 *
 * 一个标签页只会是其中一种，所以两者共用一个规则 ID 段、按 `kind` 选 `urlFilter` 即可。
 */
const PLAYURL_PATH_BY_KIND = {
  video: '/x/player/wbi/playurl',
  pgc: '/pgc/player/web/playurl',
} as const;

/** 页面类型。与 `page/activate` 载荷的 `kind` 同源 */
export type PageKind = keyof typeof PLAYURL_PATH_BY_KIND;

/**
 * 给某个标签页装一条规则，把它的取流请求 Cookie 换成播放账号的。
 *
 * 与全局路径规则的区别：多了 `tabIds` 限定，只对这一个标签页生效。
 * 用于普通视频页 / PGC 页 —— 页面自己发请求，我们预测不到完整 URL（含实时 `w_rid`）。
 *
 * ## 幂等性（重要）
 *
 * 同一条规则会被装**很多次**：`document_start` 一次、`DOMContentLoaded` 一次、
 * 标签页从后台恢复时再一次。每次 `updateSessionRules` 都会让浏览器的规则表重算，
 * 同时触发所有已打开 B站标签页的 content script 重评估。
 *
 * 所以这里先比对现有规则：**Cookie 值与 urlFilter 都一样就什么都不做**。
 * 这不是微优化——反复重建规则是"恢复标签页时卡一下"的直接来源之一。
 */
export async function installTabRule(
  tabId: number,
  cookie: string,
  kind: PageKind = 'video',
): Promise<void> {
  const id = TAB_RULE_BASE + (tabId % TAB_RULE_SPAN);
  const urlFilter = PLAYURL_PATH_BY_KIND[kind];

  const existing = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  const current = existing.find((r) => r.id === id);
  if (current) {
    const currentValue = current.action?.requestHeaders?.[0]?.value;
    const currentFilter = current.condition?.urlFilter;
    if (currentValue === cookie && currentFilter === urlFilter) return; // 完全一致，跳过重建
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 2, // 高于全局路径规则
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'cookie', operation: 'set', value: cookie }],
        },
        condition: {
          urlFilter,
          requestDomains: [...BILI_API_HOSTS],
          resourceTypes: ['xmlhttprequest'],
          requestMethods: ['get'],
          tabIds: [tabId],
        },
      },
    ],
  });
}

/** 删掉某个标签页的规则 */
export async function removeTabRule(tabId: number): Promise<void> {
  const id = TAB_RULE_BASE + (tabId % TAB_RULE_SPAN);
  // 先查再删：没有这条规则时不必触发一次规则表重算
  const existing = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  if (!existing.some((r) => r.id === id)) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

/** 校正标签页规则：删掉不属于任何现存标签页的（标签页崩溃时留下） */
export const reconcileTabRules = removeStaleTabRules;

/**
 * 本实例能看到的路径规则条数。
 *
 * ## 为什么单独包一层
 *
 * `incognito: "split"` 下 `sessionRules` 疑似**按实例独立**：
 * 诊断页（页面上下文）能数到 2 条，而 background 里数到 0 条。
 * 这意味着"数规则"不能跨实例用作判据。
 *
 * 所以 `proxy/status` 只用这个值做**本实例视角**的展示，
 * 不能拿它断言"全局是否生效"。
 */
export async function countPathRules(): Promise<number> {
  const rules = await describeRules().catch(() => []);
  return rules.filter((r) => r.kind === 'path').length;
}

/** 当前已装的规则摘要（诊断用） */
export async function describeRules(): Promise<
  Array<{ id: number; kind: 'path' | 'tab'; urlFilter: string; tabIds: number[] }>
> {
  const rules = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  return rules
    .filter(
      (r) =>
        (r.id >= PATH_RULE_BASE && r.id < PATH_RULE_BASE + PATH_RULE_SPAN) ||
        (r.id >= TAB_RULE_BASE && r.id < TAB_RULE_BASE + TAB_RULE_SPAN),
    )
    .map((r) => ({
      id: r.id,
      kind: (r.id >= TAB_RULE_BASE ? 'tab' : 'path') as 'path' | 'tab',
      urlFilter: r.condition.urlFilter ?? '-',
      tabIds: r.condition.tabIds ?? [],
    }));
}
