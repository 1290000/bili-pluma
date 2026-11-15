/**
 * 跨环境消息协议。
 *
 * 用**判别联合**定义：成功与失败靠 `type` 的 `:ok` / `:err` 后缀区分。
 *
 * ⚠️ **漏处理一条消息，`tsc` 不会报错。** 分发处（`entrypoints/background.ts`）用的是
 * `if (type === '...')` 链而不是 `switch`，判别联合的穷举能力用不上。
 * 真正的防线是 `scripts/check-messages.mjs`（比对类型定义与路由分支），已在 `verify` 链里。
 * 下面这个 `assertNever` 目前**没有任何调用方**，留着是为了将来改写成 `switch` 时能直接用。
 *
 * 纪律：任何 `*:ok` 消息都**不得携带凭据**（见 AGENTS.md §5.2）。
 * `qr/poll:ok` 只回报"存了没"，不回传内容。
 */

import type { AccountSummary } from './account';
import type { ErrorCode } from './errors';
import type { QrLoginStatus } from './login';
import type { PageTracksView } from './playinfo';
import type { StatBucket } from './stats';
import type { UpdateCheckOutcome, UpdateStatusView } from './update';

/**
 * UI / content → background
 */
export type RequestMsg =
  /**
   * 账号摘要（不含凭据）。
   *
   * `recheck` 控制是否强制重新探测凭据：
   *   - `false` / 省略：惰性检查，健康记录新鲜就直接返回缓存
   *   - `true`：用户点了"重新检查"，或 popup 判断记录已过期
   *
   * 惰性检查的理由见 docs/04-project-structure.md §6「凭据健康检查：惰性，不用 alarms」。
   */
  | { type: 'account/summary'; recheck?: boolean }
  | { type: 'qr/generate' }
  | { type: 'qr/poll'; qrcodeKey: string }
  /** 请求打开登录窗口（走 InPrivate 分区，不污染主账号） */
  | { type: 'login/open' }
  /**
   * 退出播放账号：清凭据、关代理、清健康与统计。
   *
   * 三个一起清是有意的——留着"上次失效"的记录，下次打开会误导用户。
   */
  | { type: 'account/remove' }
  /** 查询总开关状态 */
  | { type: 'proxy/status' }
  /** 切换总开关。关闭 = 删掉所有规则，所有请求回退主账号身份 */
  | { type: 'proxy/set'; enabled: boolean }
  /**
   * 切换**取流身份**：扩展托管账号 ⇄ 浏览器当前登录态（2026-11-11，步骤 4）。
   *
   * ## 与 `proxy/set` 的区别，别混
   *
   * | | `proxy/set` | `streaming/set` |
   * | --- | --- | --- |
   * | 回答 | "这个功能要不要开" | "开了的话，用谁取流" |
   * | 关闭后 total 开关 | `false` | **保持 `true`** |
   * | 用户意图 | 停用 | 换个身份 |
   *
   * 所以 `page` 模式下 popup 显示的是「无需代理」而不是「已停用」——
   * 用户没有停用任何东西，他只是选了另一个合法身份。
   *
   * ## 为什么必须由 background 处理而不是直接写 storage
   *
   * 切身份 = **重建全部规则**（先清两类规则、再按新身份建），
   * 且要遵守"先 disable 再 enable"的顺序（见 `dnr.switchStreamingIdentity()`）。
   * 直接 `chrome.storage.local.set` 只会改状态位，规则不跟着变 ——
   * 那会造出"界面说用浏览器账号，实际还在换 Cookie"的不一致。
   */
  | { type: 'streaming/set'; identity: 'extension' | 'page' }
  /** 查询取流身份。与 `proxy/status` 分开：两者的失败模式不同 */
  | { type: 'streaming/status' }
  /**
   * 设置「首页推荐流使用取流账号」开关（2026-11-11）。
   *
   * ## 为什么要走消息，而不是面板直接写 `storage.local`
   *
   * 这个开关不只改一个布尔：**它决定 `feed/rcmd` 那条 DNR 规则装不装**
   * （`dnr.applyRulePlan()` 的 `feedAccount` 槽）。
   *
   * 面板直接写存储 → 规则不会重建 → **开关看着是开的、实际没生效**，
   * 正是本项目反复出现的「界面说在工作、实际没工作」。
   *
   * ## 它与 `streaming/set` **完全独立**
   *
   * | 消息 | 管什么 | 影响哪条规则 |
   * | --- | --- | --- |
   * | `streaming/set` | playurl 族用谁的凭据 | 10000 段路径规则 |
   * | **`feed-account/set`** | **首页推荐流**用谁的凭据 | **11000 段推荐流规则** |
   *
   * 用户原话：「首页推荐流的变化与取流身份是完全独立的两个功能」。
   */
  | { type: 'feed-account/set'; enabled: boolean }
  /**
   * 查"哪些已打开的视频页会因为总开关变化而失效"。
   *
   * 为什么需要它：playurl **只在页面加载和切 P 时调一次**（Q3 实测），
   * 已打开的视频页其画质早已锁定，改 DNR 规则对它无效——
   * 用户关了开关却没刷新，会以为开关坏了。UI 必须把这件事说出来。
   */
  | { type: 'proxy/affected-tabs' }
  /** 刷新这些标签页（用户点"全部刷新"时） */
  | { type: 'tabs/reload'; tabIds: number[] }
  /** 页面实际播放画质（诊断用）。height=0 表示只有 note 文本 */
  | { type: 'page/quality'; height: number; note?: string }
  /** content script 报到：这个标签页要代理 playurl */
  | {
      type: 'page/activate';
      /**
       * 页面类型。`pgc` = 番剧 / 国创 / 电影（ADR 0019）。
       *
       * 两类页面取流的接口不同（`/x/player/wbi/playurl` vs `/pgc/player/web/playurl`），
       * background 靠这个字段决定给标签页装哪条规则。
       */
      kind: 'video' | 'pgc';
      /** 视频页 = bvid；PGC 页 = `ep:3854821` / `ss:28747`。只用于日志与状态键 */
      pageKey: string;
      p: number;
      deviceCookies: Record<string, string>;
      /** 主账号 mid（从页面 cookie 读，普通分区）。null 表示未登录 */
      primaryMid: string | null;
    }
  /** 取最近 1 小时的取流成功率时序（popup「已降级」状态的条形图） */
  | { type: 'stats/recent' }
  /**
   * 诊断用的浏览器环境事实。由 **background** 代查 ——
   * 相关命名空间在 content script 里不存在（见 `diag/facts:ok` 的长注释）。
   */
  | { type: 'diag/facts' }
  // ── 自动更新（2026-11-16）──
  //
  // ⚠️ 这三个都必须有 `background.ts` 里的路由分支，否则 `check-messages` 会红：
  // 定义了类型不路由 = 静默返回 undefined。
  /** 读更新状态（面板「关于」tab 打开时） */
  | { type: 'update/status' }
  /**
   * 立刻检查一次。
   *
   * `manual: true` **无视间隔闸门**（用户点了按钮就是要现在查），但仍受 60s 冷却限制；
   * `manual: false` 走自动闸门（开关 + 间隔）。
   */
  | { type: 'update/check'; manual?: boolean }
  /** 切换「自动检查」开关。关掉只停自动发起，手动检查照常可用 */
  | { type: 'update/auto'; enabled: boolean }
  /**
   * 打开更新窗口（独立小窗，不是 popup）。
   *
   * 必须是 background 开：content script 里没有 `chrome.windows`，
   * 而且 `showDirectoryPicker` 只能在**扩展页面**里调（见方案 §1.3）。
   */
  | { type: 'update/open' };
/**
 * `page/activate:ok` 的 `reason` —— **唯一真相源**（2026-11-11 提取）。
 *
 * ## 为什么必须提取成一个具名类型
 *
 * 在它之前，这个联合被**手抄了 4 份**：`page.handler.ts`（已用派生）、
 * `page-snapshot.ts`、`playinfo.ts` 的 `proxyIdentity`、`page-state.ts` 的
 * `ProxyActivateReason`、以及 `content.ts` 的内联字面量断言。
 *
 * 2026-11-11 加 `'page-identity'` 时，就发生过**只改两处、漏三处**，
 * 而 `tsc` **全程没报错** —— 因为漏掉的那几处恰好没有生产调用方，
 * 或者说"两边一起错"互相抵消了。**类型断链被静默掩盖**，
 * 一接上就会把 `page-identity` 吞成「已接管」→ 谎报扩展在工作。
 *
 * 提取成具名类型后，消费方写 `import type { ProxyActivateReason }` 就没有抄写动机；
 * 但**这不等于不会再错**，见下面的已知缺口。
 *
 * ## ⚠️ 已知缺口：哪些位置**结构性无法**被 `tsc` 保护
 *
 * 加了新值之后，下面这些地方**不会**报错，必须靠 `check-messages.mjs`、
 * 单测或人工审查兜住：
 *
 * 1. **内联字面量断言**：`as { reason?: 'ok' | 'self' | ... }` —— 那是一个
 *    独立的结构类型，与 `ResponseMsg` 没有链接。改成派生即可修好单处，
 *    但**任何人下次再写一份内联断言，就又断一次**，`tsc` 抓不到。
 *    → **✅ 已由 `check-messages.mjs` 的内联联合扫描覆盖**（2026-11-11 加）。
 *    它扫 `src/` 与 `entrypoints/` 里所有"字段名 + 字面量联合"的写法并报红，
 *    含 Prettier 格式化后的多行形态与 `as {...}` 内联断言。
 *    该检查自身的形态穷举见 `tests/unit/scripts/check-messages-inline-union.test.ts`。
 * 2. **`as` 类型断言**：`x as ProxyActivateReason` 会绕过检查。
 * 3. **字符串模板拼接 / `String(reason)`**：转成 `string` 后信息就丢了。
 * 4. **JSON 反序列化**：`JSON.parse(...) as {...}` 完全绕过类型系统。
 * 5. **跨 world 的 `postMessage`**：主世界那份是裸 JS，`tsc` 根本不看。
 * 6. **`Record<string, ...>` 之类的宽类型容器**：键是任意字符串，
 *    新增值不会产生编译错误（`collect.ts` 的 `REASON_TEXT` 是
 *    `Record<ProxyActivateReason, string>`，那个**会**报错，因为它键类型是封闭的 ——
 *    但写成 `Record<string, string>` 就不会）。
 *
 * **能保证的**：凡是 `import` 了这个类型、且用 `switch` / 封闭联合比较的地方，
 * 新增值会让 `tsc` 报错。
 *
 * **不能保证的**：
 *
 * | 类别 | 有无机械兜底 |
 * | --- | --- |
 * | 第 1 类（内联字面量断言） | ✅ **有**（`check-messages` 内联联合扫描） |
 * | 第 2–6 类 | ❌ **无**，只能靠单测 / 人工审查 |
 *
 * **这不是改完就安全了。** 加新 reason 时，第 2–6 类的位置仍需人工逐个确认 ——
 * 尤其第 5 类（主世界裸 JS）连 `check-messages` 都扫不到。
 */
export type ProxyActivateReason =
  /** 正常：装上了规则 */
  | 'ok'
  /** 还没扫码 / 凭据读不出 */
  | 'not-configured'
  /** 事实：两个 mid 恰好相同 → 换 Cookie 是空操作，不装规则 */
  | 'self'
  /** 选择：用户把取流身份设成浏览器登录态 → 不装规则（与 `self` 的成因不同，界面话也不同） */
  | 'page-identity'
  /** 用户主动关了总开关 */
  | 'disabled'
  /** 内部异常 */
  | 'error';

/**
 * `login/open:ok` 的 `reason`（2026-11-15，task-46 起具名导出）。
 *
 * 提成具名类型是因为 `check-messages.mjs` 会抓「手抄封闭枚举的取值域」：
 * `entrypoints/background.ts` 的 `handleLoginOpen()` 曾把这个联合**抄了一遍**
 * 当返回类型，于是加新值时只改一边、`tsc` 不报错。现在两边都引用这里。
 */
export type LoginOpenReason =
  /** 用户要去勾选「在 InPrivate 中允许」，且说明页已弹 */
  | 'incognito-disabled'
  /** 窗口本来就在，已聚焦 */
  | 'already-open'
  /** `create()` 返回 `undefined`，**无法确认窗口是否真的开出来** */
  | 'assumed'
  /** `create()` 拿到了窗口对象 —— 唯一"确定开了"的成功态 */
  | 'opened'
  /** 其它异常，原因未知 */
  | 'unknown';

/** background → UI / content */
export type ResponseMsg =
  /**
   * 账号摘要。
   *
   * ## `configured` 与 `account` 是两个独立的事
   *
   * | configured | account | 含义 |
   * | --- | --- | --- |
   * | false | null | 从未配置过 → popup 显示「未配置」，引导扫码 |
   * | true | 有值 | 正常 → 显示昵称/会员/健康 |
   * | true | null | **已配置但探测不出资料**（首次探测就失败、缓存也没了） |
   *
   * 第三种如果只给 `account: null`，UI 会误判成「未配置」，
   * 于是引导用户去扫一个已经存在的账号——比不提示更糟。
   *
   * ⚠️ 不含任何凭据字段（`AccountSummary` 本身就排除了它们）。
   */
  | {
      type: 'account/summary:ok';
      configured: boolean;
      account: AccountSummary | null;
      needsRecheck: boolean;
    }
  | { type: 'account/summary:err'; code: ErrorCode; detail: string | null }
  /** 退出播放账号的结果 */
  | { type: 'account/remove:ok' }
  | { type: 'account/remove:err'; detail: string }
  | { type: 'qr/generate:ok'; qrContent: string; qrcodeKey: string }
  | { type: 'qr/generate:err'; detail: string }
  /** credentialSaved：凭据是否已读入并落库。**不回报凭据内容** */
  | { type: 'qr/poll:ok'; status: QrLoginStatus; credentialSaved: boolean }
  | { type: 'qr/poll:err'; detail: string }
  /** 页面代理是否已装规则。**不回报 Cookie** */
  | {
      type: 'page/activate:ok';
      activated: boolean;
      /**
       * `disabled` —— 总开关关着，**不装规则**（2026-10-27 新增）。
       *
       * 与 `not-configured` 不同：那时是还没配置账号；这里是用户主动关了开关。
       * 两者都不能算"取流失败"，`recordStat` 要区分对待，
       * 否则关掉开关会把统计打成一片红。
       *
       * ## `self` —— 取流账号与页面身份是同一个号（2026-11-11 新增）
       *
       * **这是「不需要代理」，不是「拒绝代理」。** 曾叫 `same-account`，那时
       * `page.handler.ts` 提前 `return`，三个后果全是坏的：
       *
       *   1. 已装的标签页规则无人清理（`removeTabRule` 没被调到）
       *   2. `reason` 在 UI 层**零消费方** → 开关开着、什么都没生效、**一个字都不说**
       *   3. `entrypoints/background.ts` 的统计排除列表漏了它 → 每次打开视频页
       *      记一次**假失败**，成功率条形图一路变红指向不存在的问题
       *
       * 改名成 `self` 是为了让语义对齐「一等状态」：它和 `ok` 一样走完整收尾路径
       * （删规则 → 上报 → UI 有话可说），只是不装规则。**不装规则 ≠ 出错了。**
       *
       * ⚠️ 它同样**不能算取流失败**，统计排除列表必须有它。
       *
       * ## `page-identity` —— 用户把取流身份设成了「浏览器当前登录态」（2026-11-11 新增）
       *
       * 与 `self` 的区别（**很容易混，必须分清**）：
       *
       * | | `self` | `page-identity` |
       * | --- | --- | --- |
       * | 谁决定的 | **事实**：两个 mid 恰好相同 | **选择**：用户在面板里选的 |
       * | 数据来源 | `primaryMid === dedeUserId` 比对 | `readStreamingIdentity()` |
       * | 语义 | 换 Cookie 是空操作，所以不装 | 用户要求不换身份，所以不装 |
       *
       * 两者在 DNR 层面都是"不装规则"，但在**界面上说的话不同**：
       * `self` 是"你这两个号居然一样"，`page-identity` 是"你选了让浏览器自己取流"。
       * 把后者说成前者，用户会以为扩展发现了一个他不知道的问题。
       *
       * ⚠️ 同样**不算取流失败**，统计排除列表必须有它。
       * 同样 `activated: false`（没装规则就是不装，不因为"这是好事"就报 true）。
       *
       * ## ⚠️ `activated` 在 `self` 下**恒为 `false`**，这是刻意的
       *
       * 判据只认 `reason === 'self'`，**不要看 `activated`**。
       *
       * 下一个人最容易在这里"顺手改对"：既然是"不需要代理"这种正常情况，
       * 那 `activated` 报 `true` 是不是更合理？**不。**
       *
       * `activated` 的语义是「**这个标签页装上了 DNR 规则**」，而 `self` 恰恰是
       * 「不装规则」。报 `true` 会让 `entrypoints/content.ts` 的
       * `badgeState.proxying = res.activated === true` 变成 true →
       * 角标画成「已接管」→ **界面谎报扩展在工作**，而实际一条规则都没装。
       * 那正是本字段改名要修的那类 bug 的镜像。
       *
       * 「不需要」和「已接管」是两件事：前者是这件事**不需要扩展参与**，
       * 后者是扩展**参与成功**。混成一个布尔就再也分不开了。
       */
      reason: ProxyActivateReason;
    }
  /**
   * 登录窗口是否打开成功。
   *
   * - `incognito-disabled` → 用户要去勾选「在 InPrivate 中允许」，且说明页已弹
   * - `already-open` → 窗口本来就在，已聚焦
   * - `assumed` → `create()` 返回 `undefined`，**无法确认窗口是否真的开出来**
   *   （split 模式下无痕窗口对本实例不可见）。⚠️ 2026-11-15（task-46）起
   *   这种情形 **`opened` 为 `false`、`confirmed` 为 `false`** —— 不许再冒充成功。
   *
   * `confirmed`（2026-11-15，task-46）区分「确定开了」与「猜它开了」：
   * - `true`：拿到了窗口对象（`opened: true`）或心跳证明窗口还活着（`already-open`）
   * - `false`：`assumed` —— 窗口可能开着，也可能没开，我们不知道
   * - `undefined`：老字段，调用方按 `opened` 判即可
   */
  | {
      type: 'login/open:ok';
      opened: boolean;
      confirmed?: boolean;
      reason?: LoginOpenReason;
    }
  /**
   * 总开关状态。**不回报 Cookie**。
   * `hasCredential` 与 `enabled` 分开：可能有凭据但用户关掉了开关。
   */
  | { type: 'proxy/status:ok'; enabled: boolean; hasCredential: boolean; ruleCount: number }
  | { type: 'proxy/set:ok'; enabled: boolean }
  | { type: 'proxy/set:err'; detail: string }
  /** 取流身份。`applied` = 切换后是否真的处于"换 Cookie"状态（凭据可能已失效） */
  | { type: 'streaming/status:ok'; identity: 'extension' | 'page' }
  | { type: 'streaming/set:ok'; identity: 'extension' | 'page'; activated: boolean }
  | { type: 'streaming/set:err'; detail: string }
  /**
   * 推荐流开关的应答。`applied` = **规则是否真的装上了**
   * （`hasCredential === false` 时会是 `false` —— 那时开关开着也不生效）。
   */
  | { type: 'feed-account/set:ok'; enabled: boolean; applied: boolean }
  | { type: 'feed-account/set:err'; detail: string }
  /**
   * 受影响的视频标签页数。
   *
   * `count === 0` 时 UI 什么都不说——没有已打开的页面就不用提醒用户。
   */
  | { type: 'proxy/affected-tabs:ok'; count: number; tabIds: number[] }
  | { type: 'tabs/reload:ok'; reloaded: number }
  /**
   * 取流成功率时序。`buckets` 恒为 12 个连续窗口（无数据的桶 ok=fail=0）。
   * `rate` 为 null 表示样本数为 0——UI 要画灰而不是画红。
   */
  | { type: 'stats/recent:ok'; buckets: StatBucket[]; rate: number | null }
  | { type: 'stats/recent:err'; detail: string }
  /**
   * 诊断用的浏览器环境事实（`diag/facts` 的应答）。
   *
   * ## 为什么需要这条消息（2026-11-09 真机验收）
   *
   * 面板跑在 **content script** 里，而下面这四个命名空间**在 content script 里
   * 整个是 `undefined`**（真机实测，不是权限不足）：
   *
   * ```
   * chrome.extension.isAllowedIncognitoAccess  is not a function
   * chrome.windows               undefined
   * chrome.cookies               undefined
   * chrome.declarativeNetRequest undefined
   * ```
   *
   * 而诊断浮层要显示它们 —— 所以改由 background 代查，再回传。
   *
   * ## 为什么是一条消息、不是四条
   *
   * `scripts/check-messages.mjs` 要求每个请求类型都有 handler 分支。
   * 四条 = 四处分支、四处漏改风险；而这四项只在"打开诊断浮层"这一个场景
   * **一起**用到，没有独立调用方。一次往返也省三次消息。
   *
   * ## ⚠️ 每个字段都可以是 `null`
   *
   * `null` = **这一项读失败**，不是"值是 0 / false / 空数组"。
   * 调用方（`collectFacts()`）必须据此产出一条 3 态行：
   * 读到了正常 / 读到了异常 / **读不到（未知）** —— 后两者绝不能混，见 `tipFor()`。
   *
   * ## ⚠️ DNR 只回 id，不回整条规则
   *
   * 整条规则里的 `action.requestHeaders` 是一条**完整 Cookie 头**。
   * 回它等于把播放账号凭据发给诊断页并随导出流传出去 ——
   * `tests/unit/platform/diagnostics-export.test.ts` 有源码级断言在防这个。
   */
  | {
      type: 'diag/facts:ok';
      facts: {
        /** `chrome.extension.isAllowedIncognitoAccess()`。null = 读失败 */
        incognitoAllowed: boolean | null;
        /** 窗口数。null = 读失败 */
        windows: { total: number; incognito: number } | null;
        /**
         * 可见 cookie 分区的 **id 数组**（如 `['0', '1']`）。
         * `chrome.cookies.CookieStore.id` 的官方类型就是 `string`。null = 读失败
         */
        cookieStores: string[] | null;
        /**
         * 我们自己的 DNR 规则 id。**只有 id**，见上方注释。
         * `path` = 全局路径规则（id 10000–10999），`tab` = 标签页规则（20000–29999）
         */
        dnrRuleIds: { path: number[]; tab: number[] } | null;
      };
      /**
       * **调试回显**：每一项的执行结果摘要，随应答一起回去。
       *
       * ## 为什么要有它（2026-11-10 第八轮，最后一次尝试）
       *
       * 前七轮里，所有"把调试信息写进 `storage.local` 再看"的通道都失败了：
       * `diag()` 的环形缓冲被高频日志挤掉、`trace()` 干脆写不进去
       * （smoke 实测：同一份导出里既有 background 写的 `page/quality` 26+ 条，
       * 又有 `diag/facts reply: undefined` —— 消息到了、`diag()` 正常、
       * **只有 `trace()` 写不进**）。
       *
       * 而**消息应答本身从没丢过**。所以把回显塞进应答是最可靠的通道：
       * 它不经过任何存储、不受任何环形缓冲影响。
       *
       * 格式见 `buildDiagEcho()`：`entered | incognito=ok:true windows=null ...`，
       * 每一项都能区分"成功拿到值" / "成功但返回 null" / "抛错" / "超时"。
       */
      echo?: string;
    }
  | { type: 'diag/facts:err'; detail: string; echo?: string }
  | { type: 'update/status:ok'; status: UpdateStatusView }
  /**
   * 一次检查的结果。
   *
   * `outcome` 必须原样透传：`unchanged`（304）与 `rate-limited` 对用户说的话完全不同，
   * 混成"失败"会让人不知道是该等还是该报 bug。`reason` 只在这两种情况下有值。
   */
  | {
      type: 'update/check:ok';
      status: UpdateStatusView;
      outcome: UpdateCheckOutcome;
      reason: string | null;
    }
  | { type: 'update/auto:ok'; status: UpdateStatusView }
  | { type: 'update/status:err'; detail: string | null }
  | { type: 'update/check:err'; detail: string | null }
  | { type: 'update/auto:err'; detail: string | null }
  | { type: 'update/open:ok'; opened: boolean }
  | { type: 'update/open:err'; detail: string | null };

export type Msg = RequestMsg | ResponseMsg;

// ── content ↔ 扩展页面（popup / 诊断页）的**直连**查询 ──
//
// 为什么不走 SW：这份数据只对"当前这个标签页"有意义，而 content 本来就在那个页面里。
// 绕一圈到 SW 再回来，除了多一份要维护的缓存（和缓存过期问题）没有任何收益。
// 用 `chrome.tabs.sendMessage(tabId, …)` 直连，拿到的一定是最新的。
//
// ⚠️ 目标标签页没有 content script（不是视频页 / 还没注入）时，
// `sendMessage` 会**抛异常**而不是返回 `none` —— 调用方必须自己 catch。

/** 扩展页面 → content：要当前页的取流数据 */
export type PageQueryMsg = { type: 'page/summary:get' };

export type PageQueryReply =
  | { type: 'page/summary:ok'; view: PageTracksView }
  /** content 在，但还没报到（脚本刚注入、页面还没解析出 bvid） */
  | { type: 'page/summary:none'; reason: 'not-ready' };

/**
 * 页面 → content：要一份 **popup 渲染结果的完整快照**（给自动化/bsk 用）。
 *
 * ## 为什么需要它（2026-10-29）
 *
 * `chrome-extension://` 页面被 bsk 的 Agent Window sandbox 拒绝 `evaluate`，
 * 于是 popup 到底渲染成什么样**只能靠用户手点截图**。UI bug 因此只能靠肉眼，
 * 每个都要用户配合一轮，极慢。
 *
 * 这条消息把"popup 会渲染成什么"变成一段可读 JSON。
 *
 * ## 为什么挂在 content 侧，而不是 background
 *
 * 快照要三样东西：`describePopup()`（`core`，纯函数）、账号摘要（`background`）、
 * 当前页数据（`content` 独有）。**只有 content 侧能一次凑齐** ——
 * 它在页面里，能顺手向 background 转发一次 `account/summary`。
 *
 * 反过来（放 background）则要 background 反查活动标签页的 content，
 * 多一次往返，且 background 拿不到 `pageState`。
 *
 * ## ⚠️ 只读，且**不带凭据**
 *
 * `AGENTS.md §5.2`：任何 `*:ok` 消息都不得携带凭据。
 * 这里的账号部分只用 `AccountSummary` 级字段（uname / mid / vipLabel / expireAt / healthy），
 * **绝不带 SESSDATA / bili_jct / 完整 Cookie**。
 *
 * ## ⚠️ 不在 popup 的渲染路径上
 *
 * popup 仍然自己发 `proxy/status` + `account/summary` + `stats/recent` + `page/summary:get`。
 * 这条消息只给自动化用 —— 让 popup 依赖它会多一层调试代码，
 * 而且快照与真实渲染之间的偏差会变成新的 bug 来源。
 */
export type PageSnapshotMsg = { type: 'page/snapshot:get' };

/** `page/snapshot:get` 的应答。字段与 popup 的渲染输入一一对应 */
export interface PopupSnapshotReply {
  /**
   * 胶囊状态（`describePopup()` 的产出）。
   *
   * `null` 表示拿不到 `proxy/status`（SW 未就绪 / 上下文失效）——
   * 与 popup 的 `load.kind === 'error'` 同义。
   */
  view: {
    state: string;
    pill: string;
    tone: string;
    line?: string;
    needsLogin: boolean;
  } | null;
  /** 主账号卡片（**不含** mid 以外的任何标识性凭据） */
  primary: {
    uname: string | null;
    level: number | null;
    loggedIn: 'yes' | 'no' | 'unknown';
    source: 'live' | 'cached' | 'none';
    /** 没有昵称时 popup 实际会显示的那句话 */
    placeholder: string;
  };
  /** 播放账号摘要。`null` = 未配置或读不出来 */
  playbackAccount: {
    uname: string;
    mid: number;
    vipLabel: 'none' | 'monthly' | 'annual';
    expireAt: number | null;
    healthy: boolean;
  } | null;
  /** §2.3 画质区。`null` = 不是播放页 / 还没数据 / **总开关关着** */
  unlock: {
    title: string;
    badges: string[];
    anchor: string;
    improved: boolean;
  } | null;
  /** 当前页 */
  page: { kind: 'play' | 'other'; pageKey: string | null; p: number | null };
  /** 总开关与规则数，方便直接判"现在生效了吗" */
  proxy: { enabled: boolean; hasCredential: boolean; ruleCount: number };
  /** popup 会用到的全部"原始字符串"，方便断言文案 */
  texts: {
    /** 主账号栏那一行（昵称或占位文案） */
    primaryLine: string;
    /** 画质卡标题 + 锚点拼起来（`null` 表示不渲染画质卡） */
    unlockLine: string | null;
  };
}

export type PageSnapshotReply = { type: 'page/snapshot:ok'; snapshot: PopupSnapshotReply };

/**
 * 穷举检查工具 —— ⚠️ **当前没有任何调用方**（分发处用 `if` 链，不是 `switch`）。
 *
 * 保留它是为了将来把 `entrypoints/background.ts` 改写成 `switch` 时能直接接上。
 * **不要以为它已经在起作用**——现在的穷举保障来自 `scripts/check-messages.mjs`。
 */
export function assertNever(value: never): never {
  throw new Error(`未处理的消息类型: ${JSON.stringify(value)}`);
}
