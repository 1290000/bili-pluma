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
import {
  readStreamingIdentity,
  writeStreamingIdentity,
} from '@platform/storage/streaming-identity-store';
import { readFeedAccountEnabled } from '@platform/storage/ui-prefs-store';
import { BILI_API_HOSTS, ENABLED_ROUTE_PATHS, isProxyPath } from '@shared/constants/routes';
import {
  DEFAULT_STREAMING_IDENTITY,
  type StreamingIdentity,
} from '@shared/constants/streaming-identity';
import { serializeCookie } from '@shared/utils/cookie';

import { FEED_RCMD_PATH, buildRulePlan, planPaths } from './rule-plan';

/**
 * 规则 ID 分配。
 *
 * 按路径索引固定分配：同一路径永远用同一个 ID，不轮转、不复用。
 * 分四个区段避免与将来的其他规则集撞车：
 *   10000–10999  路径常驻规则（全局，整个浏览器范围）—— **不含首页推荐流**
 *   **11000–11999  首页推荐流规则**（2026-11-11 新增，见下）
 *   20000–29999  标签页限定规则（ADR 0010，页面代理用）
 */
const PATH_RULE_BASE = 10000;

/**
 * ## 首页推荐流为什么**单独一个 ID 段**（2026-11-11）
 *
 * 产品需求：「首页推荐流的变化与取流身份是完全独立的两个功能」。
 *
 * 所以推荐流**不能**用 `ruleIdForPath()` 的止式分配（`10000 + 白名单下标`）：
 *   - 那套 ID 依赖 `ENABLED_ROUTE_PATHS` 的**顺序**，增删路径会整体漂移
 *   - 而推荐流的启停是**独立开关**，与白名单顺序毫无关系
 *   - 两者混在一个段里 → `removeAllPathRules()` 会把推荐流规则一起删掉
 *
 * **独立段 = 独立生命周期**：清、装、诊断都能各自进行。
 */
const FEED_RULE_BASE = 11000;

/** 推荐流规则段大小 */
const FEED_RULE_SPAN = 1000;

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

  /**
   * ## ⚠️ "规则消失窗口"—— 本项目**第二次**遇到它（2026-11-11 补记）
   *
   * 这里是**第一次**：`removeAllPathRules()` 与 `updateSessionRules({addRules})`
   * 是两次独立调用，中间有一个 await 间隙。此间白名单**一条规则都没有**，
   * 那些毫秒内发出的 playurl 会退化成页面身份（**只掉画质，不串号** ——
   * 清了规则等于"不代理"，而不是"代理到错的人"）。
   *
   * **第二次**在 `removeStaleTabRules()`：一条规则覆盖多个标签页之后，
   * "摘掉一个死 tab"需要先删 ID 再加同 ID 的新规则。如果分成两次调用，
   * 中间态就是"这条规则不存在"→ 那些**活着的**标签页短暂失去取流身份。
   * 所以那里把 `removeRuleIds` 与 `addRules` **放进同一次
   * `updateSessionRules` 调用**里，让浏览器把它当一次原子变更。
   *
   * ## 两条写法的关系（别只修一处）
   *
   * | 位置 | 能不能改成一次调用 | 原因 |
   * | --- | --- | --- |
   * | 本函数（先清后加） | ❌ **不能** | `removeAllPathRules()` 要读 `getSessionRules()` 才知道 ID，无法与 add 合并成一次 |
   * | `removeStaleTabRules()` | ✅ **必须** | ID 已知（就在 `tabIds` 里迭代出来），没有理由分两次 |
   *
   * 更要紧的是**语义要求**：`switchStreamingIdentity()` 依赖"先清干净、再按新身份建"
   * 这个顺序（见该函数注释）。所以本函数的窗口期是**有意的**：
   * 窗口期内"不代理"是安全方向，而"一半旧账号一半新账号"不是。
   *
   * ⚠️ 必须先清整个路径规则段，不能只删"当前白名单算出的 ID"——见 installPathRules 的注释（O1）
   */
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

/**
 * **只清规则、不碰总开关值**（2026-11-12，task-10）。
 *
 * ## 为什么需要它 —— 与 `disableProxy()` 的区别只有一句
 *
 * | 函数 | 写 `ENABLED_KEY`？ | 用在什么场景 |
 * | --- | --- | --- |
 * | `disableProxy()` | ✅ 写 `false` | **用户操作**（手动拨总开关）、凭据失效兜底 |
 * | **`clearAllRules()`** | ❌ **不写** | **不是用户操作的规则失效**（退出取流账号） |
 *
 * 用户裁决（原话）：
 * > 「可以保留这个开关原本的状态，但是因为退出了扩展账号所以这个开关即便是
 * > 开着也是没有用了，所以整个开关应变为灰色不可点击」
 *
 * 即：**退出账号要清规则（安全），但不许改写用户设的开关状态**。
 * 这与 `switchStreamingIdentity` / `applyRulePlan` 的纪律一致 ——
 * 那两者的注释都明写「**总开关是用户的唯一控制点，任何非用户操作引起它的变化都是错的**」。
 *
 * ## ⚠️ 为什么**不**直接复用 `disableProxy()` 或 `applyRulePlan()`
 *
 * - `disableProxy()`：会连带把开关值改成 `false` —— 退出一次账号，用户的开关设置
 *   就被永久改掉了，下次用还得自己再打开一次。
 * - `applyRulePlan()`：它是"**按当前状态重建**"的语义。正常路径下无凭据时确实
 *   会清空，但将来若有人给"无凭据也装点什么"加分支，退出路径会跟着变 ——
 *   **而那个分支的作者根本不知道退出账号依赖它**。语义借用是隐蔽耦合。
 *
 * 所以这里写成"确定地清空"，意图明确、不依附任何别的逻辑。
 *
 * ## ⚠️ 必须清**三类**，少一类就是安全事故
 *
 * 退出账号后凭据已被删除，任何**残留的规则**都会带着**已失效的 Cookie**
 * 继续对 B站发请求 —— 那不只是"没生效"，是把死凭据拿去换流。
 *
 * | 段 | 内容 | 由谁清 |
 * | --- | --- | --- |
 * | 10000 | 全局路径规则（playurl 族） | `removeAllPathRules()` |
 * | **11000** | **首页推荐流规则** | **`removeFeedAccountRule()`** |
 * | 20000 | 标签页规则 | `removeAllTabRules()` |
 *
 * ⚠️ **11000 段不会被 `removeAllPathRules()` 清掉** —— 见 `dnr.ts` 里
 * 「两个 ID 段互不清除」那段注释：`removeAllPathRules()` 只删
 * `>= PATH_RULE_BASE && < PATH_RULE_BASE + PATH_RULE_SPAN`。
 * 漏了它，推荐流那条规则会在退出账号后**继续用已删除账号的 Cookie 发请求**。
 *
 * ## 调用时序（调用方负责）
 *
 * 必须在 `removeCredential()` **之前**调 —— 保持"先关代理、再删凭据"的顺序，
 * 这样任何时刻都不会出现"规则已删但凭据还在"的可用状态。
 *
 * ## ⚠️ 交付后合法但危险的组合态：`ENABLED_KEY === true` + **无凭据**
 *
 * 本函数**只清规则、不写开关值**（见上方表格），而退出取流账号又**不许**改写用户设的开关。
 * 于是"退出账号"之后必然留下这个组合态：
 *
 * | 开关值 | 凭据 | 规则 | 界面 |
 * | --- | --- | --- | --- |
 * | `true` | ❌ 无 | 0 条（本函数刚清） | 开关灰掉 + 文字说明原因（`tabs.ts`） |
 *
 * **这是设计要的状态，本轮无 bug**：`rebuildRulesIfEnabled()` 读不到凭据时**不会**装规则，
 * 所以此刻的 `true` 不会变成"带着死凭据发请求"。
 *
 * ### 但它是一个**装规则路径的陷阱**（2026-11-12，verifier 待修 #3）
 *
 * "开关是 `true`"**不等于**"该装规则"。谁若新增一条"开关开着那就装规则"的路径，
 * 只要漏了重新校验凭据，就会**带着已删除账号的 Cookie 装出规则** —— 那正是
 * 本函数上方「必须清三类」那段要防的事故，只是方向相反（这次是装回去）。
 *
 * **规定：任何装规则的路径都必须先校验凭据非空，不许只看 `ENABLED_KEY`。**
 * 已按此实现的参照：`rebuildRulesIfEnabled()` / `applyRulePlan()`（无凭据即不装）。
 */
export async function clearAllRules(): Promise<void> {
  await removeAllPathRules();
  await removeFeedAccountRule();
  await removeAllTabRules();
}

// ── 取流身份切换（2026-11-11） ──

/**
 * 切换取流身份：`extension`（扩展托管账号） ⇄ `page`（浏览器当前登录态）。
 *
 * ## 为什么必须"先关再开"（实测约束，不许优化掉）
 *
 * `installTabRule()` 有幂等比对（"完全一致就跳过重建"）。
 * 直接改 Cookie 值当然会触发重建，但**切到 `page` 时根本不装规则**，
 * 而切回 `extension` 时若规则表里还留着上一次的痕迹，就可能被判定成"没变"而跳过。
 *
 * 更关键的是**中间态**：先 `disableProxy()` 把两类规则都清空，再按新身份重建，
 * 任何时刻都不会出现"一半规则是旧账号、一半是新账号"的混合态。
 * 反过来（先加后删）会在中间态里同时存在两套 Cookie 的规则，
 * 那几毫秒内的请求用哪套取决于规则优先级——不可控。
 *
 * ## ⚠️ 本函数**永不写 `ENABLED_KEY`**（2026-11-11 修的真 bug）
 *
 * ### 修之前是什么样
 *
 * ```ts
 * await installPathRules(cookie);
 * await chrome.storage.local.set({ [ENABLED_KEY]: true });   // ← 无条件打开
 * ```
 *
 * 场景：用户**关掉总开关** → 切身份 `extension → page → extension`
 * → 回到 `extension` 分支时，`ENABLED_KEY` 被**重新置为 true**。
 *
 * **用户从没表示要重新开启代理，他只是切换了身份。** 那之后
 * popup 显示「已接管」而用户以为自己还关着——与
 * 「界面说停了、实际还在代理」（`disableProxy()` 注释里那个 bug）
 * 是**同一类不一致，方向相反**。
 *
 * ### 为什么"只在原本开着时才置 true"也不够
 *
 * 那样仍然会**写** `ENABLED_KEY`，值虽不变但写操作本身是噪音；
 * 而且判断条件将来一旦改错就又会出问题。**彻底解耦才是结构性修复**：
 *
 * | 概念 | 谁负责 | 什么时候变 |
 * | --- | --- | --- |
 * | **开关**（要不要让扩展介入） | `enableProxy` / `disableProxy` / `proxy/set` | **只在用户操作时** |
 * | **身份**（介入的话用谁） | 本函数 / `streaming/set` | 只在用户切换时 |
 *
 * 两者正交。总开关是用户对"是否让扩展介入"的**唯一控制点**，
 * **任何非用户操作引起它的变化都是错的。**
 *
 * ### 连带检查（2026-11-11 已做）
 *
 * 本函数只有一个调用方：`entrypoints/background.ts` 的 `streaming/set` 分支。
 * **没有任何流程依赖它"顺便打开开关"** —— 所以解耦不会破坏登录后自动启用之类的路径。
 * （登录成功后的启用走的是 `page/activate` → `installTabRule`，与开关无关。）
 */
/**
 * **按"完整状态"重建所有规则** —— 状态推导的落点（2026-11-11）。
 *
 * ## 为什么要有这个函数（结构性修复，不是补一句）
 *
 * 修之前，规则装载是**由动作驱动**的：
 * ```
 * enableProxy()            → 装全部白名单路径
 * switchStreamingIdentity() → 清空 → 按新身份重建（**不知道**推荐流开关的存在）
 * ```
 * 于是"推荐流开关开着 → 切取流身份"会把推荐流那条规则**悄悄清掉** ——
 * 开关看着是开的、实际没生效。
 *
 * **如果只是"在 switch 里补一句重建推荐流规则"，将来加第三个独立开关时又会漏一次。**
 *
 * 所以现在：**任何"状态变了"的入口都调本函数**，由它读完整状态、
 * 算完整计划、一次性重建。不再有"某处补一句"。
 *
 * ## 当前完整状态 = 三个输入
 *
 * | 输入 | 来源 | 影响 |
 * | --- | --- | --- |
 * | `streamingIdentity` | `storage.local` | 取流路径用谁的凭据 |
 * | `feedAccountEnabled` | `storage.local`（**独立开关**） | 推荐流用谁的凭据 |
 * | `hasCredential` | vault 里有没有密文 | 两者都要它才能装 |
 *
 * 推导逻辑在 `rule-plan.ts`（纯函数，有 10 条单测）。
 *
 * ## ⚠️ 不写 `ENABLED_KEY`
 *
 * 与 `switchStreamingIdentity` 同一条纪律：**本函数只负责"装哪些规则"，
 * 不决定"要不要用扩展"** —— 后者归总开关（`enableProxy` / `disableProxy` /
 * `proxy/set`）。
 *
 * @returns 实际装了哪些槽
 */
export async function applyRulePlan(): Promise<{
  feedStreaming: boolean;
  feedAccount: boolean;
}> {
  /**
   * ① 读完整状态。
   *
   * ⚠️ `feedAccountEnabled` 用 **`readFeedAccountEnabled()`**（默认 `false`）——
   * 与取流身份**完全独立**（用户原话：这是两个功能）。
   */
  const [identity, feedAccountEnabled, credential] = await Promise.all([
    readStreamingIdentity().catch(() => DEFAULT_STREAMING_IDENTITY),
    readFeedAccountEnabled().catch(() => false),
    readPersistedCredential().catch(() => null),
  ]);

  const plan = buildRulePlan({
    streamingIdentity: identity,
    feedAccountEnabled,
    hasCredential: credential !== null,
  });
  const paths = planPaths(plan, ENABLED_ROUTE_PATHS);

  /**
   * ② 先清空**两段**（路径规则 + 推荐流规则），再按计划重建。
   *
   * 顺序不能反：反了会在中间态出现"同一路径两条规则"。
   * 而且必须先清、后加 —— 与 `enableProxy` 的窗口期理由相同
   * （窗口期内"不代理"是安全方向，"一半旧一半新"不是）。
   *
   * ⚠️ **标签页规则也一起清**：它们同样带一份 Cookie，
   * 与取流身份强相关（`installTabRule` 用当前凭据）。
   * 清掉后由各页面 `page/activate` 自己重建（它们知道 `PageKind`）。
   */
  await removeAllPathRules();
  await removeFeedAccountRule();
  await removeAllTabRules();

  if (credential === null) {
    // 没有凭据 → 两个槽都装不了（`buildRulePlan` 已判成 false，这里只是提前返回）
    return { feedStreaming: false, feedAccount: false };
  }

  const cookie = serializeCookie({
    SESSDATA: credential.sessdata,
    bili_jct: credential.biliJct,
    DedeUserID: credential.dedeUserId,
  });

  // ③ 装取流路径（`planPaths` 已保证不含 `feed/rcmd`）
  if (paths.streamingPaths.length > 0) {
    const addRules = paths.streamingPaths
      .map((p) => buildPathRule(p, cookie))
      .filter((r): r is chrome.declarativeNetRequest.Rule => r !== null);
    if (addRules.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ addRules });
    }
  }

  // ④ 装推荐流（独立 ID 段）
  const feedApplied = await setFeedAccountRule(cookie, paths.feedAccount);

  return {
    feedStreaming: paths.streamingPaths.length > 0,
    feedAccount: feedApplied,
  };
}

/**
 * 切换取流身份：`extension`（扩展托管账号）⇄ `page`（浏览器当前登录态）。
 *
 * ## 2026-11-11 重构：从"清空重建"改成"改状态 + 走状态推导"
 *
 * 修之前本函数**自己**清空两类规则再按新身份重建 —— 它**不知道**推荐流开关的存在，
 * 所以"开关开着时切身份"会把推荐流规则清掉、且不重建。
 *
 * 现在改成：**只写状态，然后调 `applyRulePlan()`**。
 * 完整状态由那一个函数统一推导，将来加第三个独立开关不用改这里。
 *
 * ## 为什么仍然要"先关再开"（实测约束，不许优化掉）
 *
 * `installTabRule()` 有幂等比对（"完全一致就跳过重建"）。
 * 直接改 Cookie 值当然会触发重建，但**切到 `page` 时根本不装规则**，
 * 而切回 `extension` 时若规则表里还留着上一次的痕迹，就可能被判定成"没变"而跳过。
 *
 * 更关键的是**中间态**：`applyRulePlan()` 内部先清两段再重建，
 * 任何时刻都不会出现"一半规则是旧账号、一半是新账号"的混合态。
 *
 * ## ⚠️ 本函数**永不写 `ENABLED_KEY`**（2026-11-11 修的真 bug）
 *
 * 见下方原注释 —— 结论不变：开关归用户，身份归本函数，两者正交。
 */
export async function switchStreamingIdentity(next: StreamingIdentity): Promise<boolean> {
  await writeStreamingIdentity(next);

  const applied = await applyRulePlan();
  return applied.feedStreaming;
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
 *
 * @param explicitId **显式指定规则 ID**（2026-11-11 新增）。
 *   传了就跳过 `ruleIdForPath()` 的止式分配 —— 首页推荐流用它占
 *   `FEED_RULE_BASE`（11000 段），与白名单顺序解耦。
 */
function buildPathRule(
  path: string,
  cookie: string,
  explicitId?: number,
): chrome.declarativeNetRequest.Rule | null {
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
  const id = explicitId ?? ruleIdForPath(path);
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

// ── 首页推荐流规则（独立 ID 段，独立生命周期。2026-11-11） ──

/**
 * 装/删**首页推荐流**那一条规则。
 *
 * ## 它与路径规则的区别
 *
 * | | 路径规则（10000 段） | 推荐流规则（11000 段） |
 * | --- | --- | --- |
 * | 管什么 | playurl 族（取流） | `feed/rcmd`（首页推荐） |
 * | 由谁决定 | `streamingIdentity` | **独立的推荐流开关** |
 * | ID 分配 | 白名单下标止式 | **固定 `FEED_RULE_BASE`** |
 *
 * **两个 ID 段互不清除**：`removeAllPathRules()` 只删 10000 段，
 * 本函数只删 11000 段 —— 这才是"独立"的物理保证。
 *
 * @param cookie 扩展账号的 Cookie 头值
 * @param enabled `true` 装，`false` 删
 * @returns 实际是否安装了规则
 */
export async function setFeedAccountRule(cookie: string, enabled: boolean): Promise<boolean> {
  // 先删（幂等：没有就什么都不做）
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [FEED_RULE_BASE] })
    .catch(() => {});

  if (!enabled) return false;

  const rule = buildPathRule(FEED_RCMD_PATH, cookie, FEED_RULE_BASE);
  if (!rule) {
    /**
     * `feed/rcmd` 不在白名单里 → `buildPathRule` 返回 null。
     * **不静默**：这是配置错误，要说出来。
     */
    console.error(`[dnr] 无法为 ${FEED_RCMD_PATH} 建规则 —— 它不在代理白名单里`);
    return false;
  }

  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
  return true;
}

/** 当前是否装着推荐流规则（诊断用） */
export async function hasFeedAccountRule(): Promise<boolean> {
  const rules = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  return rules.some((r) => r.id >= FEED_RULE_BASE && r.id < FEED_RULE_BASE + FEED_RULE_SPAN);
}

/**
 * 只**删**推荐流规则（不装）。
 *
 * 抽成独立函数是为了让 `applyRulePlan()` 的"先清后加"读起来是
 * `removeFeedAccountRule()` 而不是 `setFeedAccountRule('', false)` ——
 * 后者要传一个空 cookie，看着像在装一条空规则。
 */
async function removeFeedAccountRule(): Promise<void> {
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [FEED_RULE_BASE] })
    .catch(() => {});
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
   * ⚠️ **不能用规则 ID 反推 tabId。**
   *
   * 旧实现规则 ID 是 `TAB_RULE_BASE + (tabId % TAB_RULE_SPAN)`，取模之后信息已丢：
   * tabId 10005 的规则 ID 是 20005，反推得 5，于是去问"标签页 5 还在吗"——
   * 不在就**删掉 tab 10005 那条有效规则**，该页画质静默回落，且没有任何报错。
   *
   * 2026-11-11 起 ID 改由 `kind` 决定（`tabRuleIdForKind`），
   * `tabIds` 里可以有多个值，"哪个 tab 没了"只能**读规则自己的 `tabIds`** 判断。
   *
   * ## 合并之后这里的行为变了
   *
   * 旧实现：一条规则挂一个 tab，全死才删。
   * 现在：一条规则挂多个 tab，所以必须**逐个 tab 摘掉**，而不是"任一存活就整条保留"——
   * 否则关掉一个视频页之后，它的 tabId 永远留在 `tabIds` 里，
   * 规则表持续持有指向已关闭标签页的 ID（不会误伤，但会累积到上限）。
   */
  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  /** 要整条删掉的规则 ID（`tabIds` 摘完为空） */
  const dropIds: number[] = [];
  /** 要改写（摘掉死 tab、保留活 tab）的规则 ID */
  const rewriteIds: number[] = [];

  for (const r of tabRules) {
    const ids = r.condition.tabIds ?? [];
    const alive = ids.filter((id) => liveTabs.has(id));
    if (alive.length === ids.length) continue; // 没有死 tab，不动

    if (alive.length === 0) {
      dropIds.push(r.id);
      continue;
    }

    const value = r.action?.requestHeaders?.[0]?.value ?? '';
    const filter = r.condition.urlFilter ?? '';
    rewriteIds.push(r.id);
    addRules.push(tabRuleSpec(r.id, filter, value, alive));
  }

  if (dropIds.length === 0 && rewriteIds.length === 0) return 0;

  /**
   * ## ⚠️ "规则消失窗口"—— 本项目**第二次**遇到它
   *
   * `removeRuleIds` 必须同时含**两种**：
   *   - `dropIds`：摘完为空，整条不要了
   *   - `rewriteIds`：要换成"只留活 tab"的版本 —— DNR 没有"改一条规则"的 API，
   *     **改写 = 先删 ID 再加同 ID 的新规则**
   *
   * **两者必须在同一次 `updateSessionRules` 里**。分两次的话，中间态是
   * "这条规则不存在"→ 那些**还活着的**标签页会短暂失去取流身份。
   *
   * 第一次遇到同一个形状是 `enableProxy()` 的"先清后加"
   * （见那里的完整对比表：那个窗口**不能**合并、且是安全方向；
   * 这里的窗口**可以且必须**合并，因为 ID 已知，没有理由分两次）。
   *
   * **判据**：凡是"ID 已知"的规则变更，都该合并成一次调用；
   * 只有"要先读规则表才知道 ID"的场景才允许分两次，且必须确认窗口期是安全方向。
   */
  await chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [...dropIds, ...rewriteIds],
      ...(addRules.length > 0 ? { addRules } : {}),
    })
    .catch(() => {});

  // 返回"处理过的规则条数"（不是 tab 数）：调用方只关心"这一轮有没有动规则表"
  return dropIds.length + rewriteIds.length;
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
 * 页面类型 → 标签页规则 ID（2026-11-11，`tabIds` 合并之后）。
 *
 * ## 为什么不再由 tabId 决定
 *
 * 旧实现：`TAB_RULE_BASE + (tabId % TAB_RULE_SPAN)` —— **一个标签页一条规则**。
 * 后果是规则数 `O(打开的标签页数)`，而 session 规则上限**实测只有 5000**
 * （`poc/probe/dnr-initiator/RESULT.md` Q3.1）。长期不重启的机器开满 5000 个
 * 视频页级标签页就会撞上限，表现是 `Session rule count exceeded`：
 * 新规则一条都加不进去，那个标签页的取流**静默回落到页面身份**，
 * 画质掉了而界面上没有任何报错。
 *
 * 现在按 `kind` 分配（`video` / `pgc` 各一个 ID），同类型的多个标签页
 * **共用同一条规则**，用 `condition.tabIds` 数组表达"这条规则管哪些页"。
 *
 * | | 旧 | 新 |
 * | --- | --- | --- |
 * | 规则数 | `O(标签页数)` | `O(页面类型数)` = 2 |
 * | ID 稳定性 | 随 tabId 变 | **恒定** |
 *
 * 按 `kind` 的**下标**止式分配（`Object.keys` 顺序由对象字面量决定，稳定），
 * 与 `ruleIdForPath()` 同一套理由：天然无碰撞，不依赖哈希。
 *
 * ⚠️ **`kind` 顺序即 ID 顺序**。`PLAYURL_PATH_BY_KIND` 里增删键会改 ID，
 * 已在装的规则要等下一次 `installTabRule` 才会换过来 —— 增删时**往后追加**。
 */
function tabRuleIdForKind(kind: PageKind): number {
  const index = (Object.keys(PLAYURL_PATH_BY_KIND) as PageKind[]).indexOf(kind);
  // 走不到：`kind` 的类型就是 `keyof PLAYURL_PATH_BY_KIND`
  if (index < 0) return TAB_RULE_BASE;
  return TAB_RULE_BASE + index;
}

/**
 * 构造一条标签页限定规则。`tabIds` 必须是**非空**数组。
 *
 * 抽出来是因为 `installTabRule` 与 `removeTabRule` 都要拼同一种规则
 * （后者在"还剩别的 tab"时改写），两处各写一份必然漂移 ——
 * 漂移的后果是 `removeTabRule` 拼出的规则漏掉某个 condition 字段，
 * 那条规则就变成"条件更宽"的版本，**可能命中它本不该命中的请求**。
 */
function tabRuleSpec(
  id: number,
  urlFilter: string,
  cookie: string,
  tabIds: number[],
): chrome.declarativeNetRequest.Rule {
  if (tabIds.length === 0) {
    /**
     * 空数组会被 DNR 当成「不限定标签页」= 全局规则，把取流身份套到所有页上。
     * 调用方必须在此之前决定"没有 tab 了就删规则"。这里显式抛错而不是静默降级。
     */
    throw new Error('[dnr] tabIds 不能为空 —— 空数组等于一条不限标签页的全局规则');
  }

  return {
    id,
    priority: 2, // 高于全局路径规则（priority 1）
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'set', value: cookie }],
    },
    condition: {
      urlFilter,
      requestDomains: [...BILI_API_HOSTS],
      resourceTypes: ['xmlhttprequest'],
      requestMethods: ['get'],
      tabIds: [...tabIds].sort((a, b) => a - b),
    },
  };
}

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
 *
 * ## ⚠️ `tabIds` 是数组：同一条规则覆盖多个标签页（2026-11-11）
 *
 * `condition.tabIds` 一直是**数组**，而旧实现（以及这里的旧签名）把它当单值用：
 * 每个标签页独占一个规则 ID。那是 `O(标签页数)` 条规则，而实际只需要
 * `O(页面类型数)` 条——同类型的多个标签页完全可以共用一条规则。
 *
 * 为什么必须合并（实测依据 `poc/probe/dnr-initiator/RESULT.md` Q3.1）：
 *   - session 规则上限**实测 5000**（不是常量里自相矛盾的 30000）
 *   - 「每标签页一条」会让规则数随打开的页数线性增长，长期不重启的机器会撞上限
 *   - 撞上限的表现是 `Session rule count exceeded` —— 一条都加不进去，
 *     取流静默回落到页面身份，**界面无任何报错**
 *
 * 合并后规则 ID **只由页面类型决定**（见 `tabRuleIdForKind`），不再由 tabId 决定。
 * 好处不止是省规则：ID 稳定意味着切页不需要换 ID，`removeTabRule` 也变成
 * "从数组里摘掉一个 tabId"而不是"删掉整条规则"。
 *
 * @param tabId 要挂到这个规则上的标签页
 * @param cookie 取流账号的完整 Cookie 头值
 * @param kind 页面类型（决定 urlFilter 与规则 ID）
 */
export async function installTabRule(
  tabId: number,
  cookie: string,
  kind: PageKind = 'video',
): Promise<void> {
  const id = tabRuleIdForKind(kind);
  const urlFilter = PLAYURL_PATH_BY_KIND[kind];

  const existing = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  const current = existing.find((r) => r.id === id);

  if (current) {
    const currentValue = current.action?.requestHeaders?.[0]?.value;
    const currentFilter = current.condition?.urlFilter;
    const currentTabs = current.condition?.tabIds ?? [];

    /**
     * 幂等判断必须**同时**看三件事：Cookie、urlFilter、这个 tab 在不在列表里。
     *
     * 旧实现只看前两个。合并之后如果仍只看前两个，就会漏掉一个真实场景：
     * 标签页 A 和 B 共用一条规则，A 先报了到，B 后报到 —— Cookie 和 urlFilter
     * 都没变，于是直接 return，**B 永远不会被加进 `tabIds`** → B 的取流不换身份，
     * 画质静默回落，而 popup 一切正常。
     */
    if (currentValue === cookie && currentFilter === urlFilter && currentTabs.includes(tabId)) {
      return;
    }

    /**
     * 合并：把本 tab 加进已有的 `tabIds`，**保留其它 tab**。
     *
     * ⚠️ 这里绝不能写成 `tabIds: [tabId]` —— 那会把同一类型的其它标签页
     * 从规则里挤掉，它们的取流会**在无提示的情况下**回到页面身份。
     */
    const merged = Array.from(new Set([...currentTabs, tabId])).sort((a, b) => a - b);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [tabRuleSpec(id, urlFilter, cookie, merged)],
    });
    return;
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [tabRuleSpec(id, urlFilter, cookie, [tabId])],
  });
}

/**
 * 删掉某个标签页的规则贡献。
 *
 * ## 合并之后语义变了（2026-11-11）
 *
 * 旧实现：一个 tab 一条规则，所以"删 tab 的规则"= 删整条。
 * 现在一条规则覆盖多个 tab，所以这里必须**只摘掉这一个 tabId**：
 *   - 还剩别的 tab → 改写规则，保留其余
 *   - 只剩它自己   → 删掉整条规则（`updateSessionRules` 不接受空 `tabIds`）
 *
 * ⚠️ 空数组不能用来表达"没有 tab"：DNR 会把 `tabIds: []` 当成"不限定标签页"，
 * 也就是**变成一条全局规则**——那会把取流身份强行套到所有标签页上，是最糟的误伤。
 */
export async function removeTabRule(tabId: number): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  const ours = existing.filter(
    (r) => r.id >= TAB_RULE_BASE && r.id < TAB_RULE_BASE + TAB_RULE_SPAN,
  );

  const hits = ours.filter((r) => (r.condition?.tabIds ?? []).includes(tabId));
  if (hits.length === 0) return; // 先查再删：不必触发一次规则表重算

  const removeRuleIds: number[] = [];
  const addRules: chrome.declarativeNetRequest.Rule[] = [];

  for (const r of hits) {
    const rest = (r.condition.tabIds ?? []).filter((t) => t !== tabId);
    if (rest.length === 0) {
      removeRuleIds.push(r.id);
      continue;
    }
    const value = r.action?.requestHeaders?.[0]?.value ?? '';
    const filter = r.condition.urlFilter ?? '';
    removeRuleIds.push(r.id);
    addRules.push(tabRuleSpec(r.id, filter, value, rest));
  }

  await chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds,
      ...(addRules.length > 0 ? { addRules } : {}),
    })
    .catch(() => {});
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
