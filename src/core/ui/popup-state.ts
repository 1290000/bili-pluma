/**
 * Popup 的状态判定 —— 纯函数，零 UI、零 chrome API。
 *
 * ## 为什么抽出来
 *
 * "该显示哪种状态"是本项目**最容易错**的一块 UI 逻辑：
 * 判错顺序会让 popup 骗人（比如开关坏着却显示"已接管"）。
 * 埋在 TSX 里就只能靠肉眼看，抽到 `core/` 才能用 Vitest 覆盖。
 *
 * 依赖方向：`entrypoints/popup` → `core/`，符合分层（见 AGENTS.md §5.1）。
 */

import type { StatBucket } from '@shared/types/stats';
import type { ProxyActivateReason } from '@shared/types/messages';
import type { StreamingIdentity } from '@shared/constants/streaming-identity';

/** 与 `messages.ts` 的 `account/summary:ok` 对齐的最小视图 */
export interface PopupAccount {
  uname: string;
  mid: number;
  vipLabel: 'none' | 'monthly' | 'annual';
  expireAt: number | null;
  healthy: boolean;
  checkedAt: number;
  reason: string | null;
}

/** popup 需要的全部输入 */
export interface PopupSnapshot {
  proxy: { enabled: boolean; hasCredential: boolean; ruleCount: number };
  configured: boolean;
  account: PopupAccount | null;
  /** 12 个时间窗的原始统计。用于算样本数与成功率 */
  buckets: StatBucket[];
  /**
   * 最近一次 `page/activate` 的 reason（**可选**）。
   *
   * ## 为什么需要它（2026-11-11）
   *
   * `'self'` 表示"取流账号与页面身份是同一个号" —— 那是**不需要代理**，
   * 不是故障。但它在快照里的表现与"配好了、正常代理"高度相似
   * （都有凭据、开关都开着），仅凭 `proxy.enabled` + `hasCredential`
   * 判不出来，界面就会说「已接管」——**而实际一条规则都没装**。
   *
   * 那正是本项目反复强调的最坏一类不一致：「界面说在工作，实际没工作」。
   * 所以让调用方把 background 的权威回答带进来，这里据此说实话。
   *
   * 缺省（`undefined`）= 调用方没有这次信息（旧快照 / 自动化），
   * 此时**保持既有判据不变**，不因缺参数就改口。
   * ## ⚠️ 取值域**派生自** `ProxyActivateReason`（2026-11-11 改）
   *
   * 这里曾经也手抄了一份。`check-messages.mjs` 新加的"内联字面量联合"检查
   * 把本行抓了出来 —— 也就是说，我在修完另外 4 处断链之后，**这里漏了第 5 处**，
   * 而这正是那条检查存在的理由：**手抄的联合，靠人逐个想起来是不可靠的**。
   */
  lastActivateReason?: ProxyActivateReason | null;
  /**
   * 用户选的取流身份（`readStreamingIdentity()` 的结果）。
   *
   * ## 为什么 popup 需要它（2026-11-11，步骤 6 段 1）
   *
   * `'page'` = 用户选了「用浏览器当前登录态取流」。这是一种**完整、可用**的配置，
   * 但它**不需要任何凭据** —— 于是 `hasCredential` 恒为 `false`。
   *
   * 旧逻辑拿 `hasCredential` 当"配好了没有"的判据，于是这种配置会被报成
   * 「未配置 / 还没配置取流账号」（`needsLogin: true`，引导用户去扫一个他不需要的号），
   * 或者落到「凭据失效 / 需要重新扫码」。**两条都是假话。**
   *
   * ## 它与 `lastActivateReason` 的关系
   *
   * 两者回答不同问题，且**都要有**：
   *
   * | 字段 | 来源 | 回答 |
   * | --- | --- | --- |
   * | `streamingIdentity` | `storage.local`（同步可读） | 用户**选**了谁 |
   * | `lastActivateReason` | `page/activate` 回包（异步、仅播放页） | 那一刻**实际发生了**什么 |
   *
   * 首页 / 非播放页拿不到 `lastActivateReason`，但**一定拿得到** `streamingIdentity`。
   * 只靠 `lastActivateReason` 的实现在非播放页会退化成"什么都不知道"。
   *
   * 缺省（`undefined` / `null`）= 调用方没给 → **保持既有判据不变**，
   * 不因缺参数就改口（与 `lastActivateReason` 同一纪律）。
   */
  streamingIdentity?: StreamingIdentity | null;
  /**
   * 当前标签页是不是**受支持的播放页**（普通视频 / 番剧 / 国创 / 电影）。
   *
   * popup 自己没有页面上下文，判断不了 —— 由 `entrypoints/popup/main.tsx`
   * 查活动标签页后填入。规范里的「状态 5：非播放页」就靠它。
   *
   * ⚠️ 值叫 `play` 而不是 `video`：判据是 `parsePlayPage()`（`shared/utils/video-page.ts`），
   * 它同时认 `/video/BV…` 与 `/bangumi/play/ep…`。曾经叫 `video` 且判据写死 `/video/`，
   * 结果**番剧页 popup 一律显示「未生效」**，而那时 PGC 代理正在正常工作
   * （2026-10-28 审查发现）。
   */
  page: { kind: 'play' } | { kind: 'other' };
}

export type PopupTone = 'neutral' | 'good' | 'warn' | 'bad';

export type PopupState =
  | 'not-configured'
  | 'credential-missing'
  | 'expired'
  | 'stopped'
  | 'not-video'
  | 'inconsistent'
  | 'degraded'
  | 'active';

export interface PopupView {
  state: PopupState;
  pill: string;
  tone: PopupTone;
  /**
   * 胶囊下方那句解释。
   *
   * ## 为什么改成可选（2026-10-29）
   *
   * 用户明确要求删掉三句：「取流已由播放账号接管」「当前使用主账号画质」
   * 「开关开着但规则没装上，请关闭再开启一次」。
   *
   * 删得掉的底气在于：**胶囊本身已经回答了"现在生效了吗"**（popup 的唯一职责，
   * 见 §0）。下面再补一句"取流已由播放账号接管"，是把胶囊的内容用长句说一遍。
   *
   * 但**不是所有状态都能省**：`凭据失效` / `已降级` / 未配置引导这几句带着
   * 归因和后果，删了用户就不知道该做什么。所以这里改成可选 ——
   * 能省的省，必须说的仍要说。
   */
  line?: string;
  /** 是否该把主按钮换成"扫码登录" */
  needsLogin: boolean;
}

/**
 * "已降级"的成功率阈值。
 *
 * 为什么是 0.6：playurl 一次失败通常就意味着这个页面的画质没提上去，
 * 用户体感上"一半以上失败"已经很明显。定太低会因网络抖动频繁误报；
 * 定太高（0.9）则几乎永远触发不了。
 */
export const DEGRADED_RATE = 0.6;

/**
 * 样本数下限。
 *
 * 2 个请求全成功不该说"100% 正常"，1 个失败也不该说"50% 崩了"。
 * 少于这个数时**不下降级结论**——宁可不说，也不能说错。
 */
export const MIN_SAMPLES = 3;

export function countSamples(buckets: readonly StatBucket[]): number {
  return buckets.reduce((n, b) => n + b.ok + b.fail, 0);
}

/**
 * 算成功率。样本不足或没有样本时返回 null。
 *
 * **null 与 0 是两个意思**：null = 不知道，0 = 全失败。
 * UI 必须区别对待，否则"刚装上还没用过"会被画成"全部失败"。
 */
export function sampleRate(buckets: readonly StatBucket[]): number | null {
  const total = countSamples(buckets);
  if (total < MIN_SAMPLES) return null;
  const ok = buckets.reduce((n, b) => n + b.ok, 0);
  return ok / total;
}

/**
 * 「代理状态未知」—— 收到一个**不认识的 reason** 时的 fail-closed 结论。
 *
 * ## 为什么必须有这一支（2026-11-11，🔴 修复）
 *
 * `describePopup()` 里有两处是"一串 `if (reason === 'X')` + 兜底 return"。
 * 兜底原本是「已接管」—— 于是**任何没匹配上的值都自动落进"扩展在工作"**，
 * 包括将来新增的 reason、拼错的值、空串。
 *
 * 实测（`popup-state-unknown-reason.test.ts` 用 `as never`）：3 条红。
 *
 * ## 判据
 *
 * > **"未知" ≠ "没问题"。** 界面说「已接管」是**断言**（我替你换了 Cookie），
 * > 而收到不认识的 reason 时，我们**根本不知道**有没有换。
 * >
 * > 把"不知道"说成"已经做了"，与把"没收到回包"说成"不是同一账号"是同一类错误
 * > —— 见 `page-state.ts` 里 `'unknown'` 被列为一等值的理由。
 *
 * ## 为什么是「未知」而不是"什么都不显示"
 *
 * 2026-11-11 在胶囊那条上已经确立过同一条纪律：
 * **控件消失不是安全默认值，而是隐形 bug**（用户看不见就以为功能没做）。
 * **不猜内容 ≠ 删掉入口。**
 *
 * 所以：渲染，但如实说"未知"，并给一句归因（`line`），让用户知道
 * 这不是"没问题"，而是"读不到"。
 *
 * ## 为什么不可点
 *
 * 它不是一个可操作的状态 —— 用户点它也不知道该做什么（不是重扫、不是开关）。
 * 可点的东西必须对应一个明确的动作，否则就是给用户一个假的出路。
 */
function unknownProxyState(): PopupView {
  return {
    state: 'active',
    pill: '未知',
    tone: 'neutral',
    line: '无法确认代理状态',
    needsLogin: false,
  };
}

/**
 * 「同一个号」状态 —— 取流账号就是页面自己那个号，**不需要代理**。
 *
 * ## 为什么必须有这一支（2026-11-11）
 *
 * 旧的 `same-account` 在 UI 层**零消费方**：用户开关开着、什么都没生效、
 * 也没有任何提示。那是比"说错话"更糟的一类问题 —— **它什么都不说**。
 *
 * ## 为什么复用 `active` 而非新增 state
 *
 * 新增 state 要同步 `PopupState` 联合、`docs/02-ui-spec.md` §3 的状态表、
 * 以及所有 `switch (state)` 的地方。而这里要表达的**不是一个新状态**，
 * 而是同一个"在用"状态下的**另一种成因** —— 用户看到的仍然是"提取流这一步没问题"，
 * 只是走的不是代理这条路。
 *
 * 所以：`state` 沿用 `active`（语义上确实"取流是好的"），
 * 但 **`pill` 换成「无需代理」**，绝不说「已接管」——
 * 「已接管」是"我替你换了 Cookie"的断言，而这里一条规则都没装。
 * 界面说在工作而实际没工作，正是本项目反复强调的最坏一类不一致。
 *
 * ## 文案为什么这么短
 *
 * 用户 2026-10-29 明确要求删掉"取流已由播放账号接管"这类把胶囊说一遍的长句。
 * 这里保留一句，是因为它讲的**不是同一件事**：它在归因（"为什么没有提升"），
 * 没有它用户会以为功能坏了。
 */
function selfIdentity(): PopupView {
  return {
    state: 'active',
    pill: '无需代理',
    tone: 'neutral',
    line: '取流账号与当前登录账号是同一个，不需要替换身份',
    // 不需要重扫 —— 号是好的，只是没有第二个号可用
    needsLogin: false,
  };
}

/**
 * 「你选择了用浏览器账号取流」—— 与 `selfIdentity()` **必须分开**（2026-11-11）。
 *
 * ## 为什么不能复用 `selfIdentity()`
 *
 * | | `self` | `page-identity` |
 * | --- | --- | --- |
 * | 谁决定的 | **事实**：两个 mid 恰好相同（扩展发现的） | **选择**：用户在面板里设的 |
 * | 说 `self` 那句话的后果 | 准确 | 用户会以为"扩展发现了我不知道的问题" |
 *
 * 同一句话套在两种成因上，用户读到的意思是错的 —— 这正是本项目反复强调的
 * "**界面陈述错误事实**"，比不提示更糟。
 *
 * 面板（`tabs.ts` 的二态胶囊）说「取流：浏览器账号」，这里说「当前用浏览器账号取流」，
 * **两个界面说同一件事**。哪天两者不一致，就说明有地方改漏了。
 */
function pageIdentity(): PopupView {
  return {
    state: 'active',
    pill: '无需代理',
    tone: 'neutral',
    line: '当前用浏览器账号取流，未使用取流账号',
    needsLogin: false,
  };
}

/**
 * 判定该显示哪种状态。
 *
 * ## 顺序不能调换
 *
 * 每一条都在挡掉后面那条的误判：
 *
 *   1. **未配置** —— 此时开关状态无关，没有凭据就没有规则
 *   2. **读取失败**（已配置但拿不到资料）—— 不能显示成"未配置"，
 *      否则会引导用户去扫一个已经存在的账号
 *   3. **凭据失效** —— 必须排在"已接管"前面，否则用户以为在生效
 *   4. **已停用** —— 用户主动关的，**不是故障**，不能报警
 *   5. **未生效**（当前页不是视频页）—— 能解释结果，但不如用户自己的操作直接
 *   6. **不一致** —— 开关开着但 0 条规则
 *   7. **已降级** —— 成功率低
 *   8. **已接管**
 *
 * 第 4 条排在降级前面很关键：用户自己关掉的，成功率低是预期结果，
 * 不该跳出来说"代理有问题"。
 */
export function describePopup(snap: PopupSnapshot): PopupView {
  const { proxy, configured, account, buckets, page } = snap;

  /**
   * ## 取流身份 = `'page'` 的**完整短路**（2026-11-11，步骤 6 段 1）
   *
   * 用户选了「用浏览器当前登录态取流」时，**`hasCredential` 与 `configured`
   * 都不再能回答任何问题** —— 这种配置本来就不需要凭据。旧逻辑会把它报成
   * 「未配置」或「凭据失效」，两条都是假话，并引导用户去扫一个不需要的号。
   *
   * 所以这里**整段短路**，不走下面的任何既有分支。
   *
   * ## 内部顺序（与主流程的判据一致）
   *
   * | 条件 | 结论 | 理由 |
   * | --- | --- | --- |
   * | 开关关着 | **「已停用」** | 用户主动关开关是最能解释当前结果的事实，**必须赢过**「无需代理」 |
   * | 不在播放页 | 「未生效」 | 非播放页没有取流这回事 |
   * | 其余 | 「无需代理」 | 配置完整且在工作，只是不需要扩展参与 |
   *
   * ⚠️ **`!proxy.enabled` 必须排在最前**。原来的实现（`self` / `page-identity`
   * 写在 `hasCredential` 分支内部）让「关开关」永远走不到「已停用」——
   * engineer-b 在交接时指出并核实过。这里短路一并修掉。
   *
   * ⚠️ **`undefined` / `null` 不走短路**：那是"还读不出用户选了谁"，
   * 与 `lastActivateReason` 缺省时的处理一致 —— **缺参数不改判据**。
   */
  if (snap.streamingIdentity === 'page') {
    if (!proxy.enabled) {
      return {
        state: 'stopped',
        pill: '已停用',
        tone: 'neutral',
        needsLogin: false,
      };
    }
    if (page.kind !== 'play') {
      return { state: 'not-video', pill: '未生效', tone: 'neutral', needsLogin: false };
    }
    return pageIdentity();
  }

  /**
   * 「未生效」：有取流账号、开关开着，但当前页不是视频页。
   *
   * 排序依据（02-ui-spec §3）：**能解释当前结果的状态优先**。
   *   - 用户自己关掉开关（已停用）> 当前页不对（未生效）
   *   - 凭据失效 > 未生效 ？反过来：用户在首页时，"凭据失效"要他去重扫，
   *     而他此刻并不在看视频，扫完也没得看。所以未生效排在凭据校验之前。
   *
   * ## 这一行也去掉了（2026-10-29 用户第二次要求）
   *
   * 先是从「当前页不是视频页，打开任意视频查看效果」缩成「当前页不是播放页」，
   * 用户仍要求删。**同意**：胶囊「未生效」+ 画面里没有画质卡，已经足够说明
   * "这个页面用不上"。再补一句"当前页不是播放页"是把用户已经看出来的事说一遍。
   *
   * 现在 `not-video` 是一个**完全没有解释文字**的状态 ——
   * popup 上只剩胶囊、两张账号卡、开关。
   */
  const notVideo = (): PopupView => ({
    state: 'not-video',
    pill: '未生效',
    tone: 'neutral',
    needsLogin: false,
  });

  /**
   * ## ⚠️ 「已停用」提到整条链的**第二位**（2026-11-11 重排）
   *
   * ### 为什么它不是"某个分支的位置问题"，而是全局顺序问题
   *
   * 顶层原则（`02-ui-spec` §3 的原话，以前只当局部理由用）：
   *
   * > **能解释当前结果的状态优先，且用户主动操作优先于默认/派生状态。**
   *
   * 按它推，整条链必须是：
   *
   * | 序 | 状态 | 依据 |
   * | --- | --- | --- |
   * | 1 | `page` 身份的短路（见上） | 配置完整，只是不需要代理 |
   * | 2 | **`!proxy.enabled` → 已停用** | **用户主动操作，压过一切派生状态** |
   * | 3 | `!configured` → 未配置 | 没配过，引导去配 |
   * | 4 | `not-video` | 页面不对，能解释结果 |
   * | 5 | `self` / `page-identity` → 无需代理 | 与号健康无关 |
   * | 6 | `!account.healthy` / 降级 / 已接管 | 后台校验，最后 |
   *
   * ### 修掉的具体 bug
   *
   * 原来「已停用」在 `:394`，排在 `!configured`（`:318`）与 `!account`（`:343`）**之后**。
   * 后果：**用户明明自己关掉了开关，却先被告知「未配置」或「凭据失效」** ——
   * 他会去扫码、去查凭据，而真相是他自己关的。
   *
   * 这正是"用户主动操作必须压过派生状态"那条原则被违反的样子。
   *
   * ### 为什么不影响 `!configured`
   *
   * `page` 身份已经在上面短路掉了。剩下的两种身份里：
   * - `extension` + 无密文 → `disabled` 说明的是**更具体**的事实（他关了开关），
   *   比"未配置"更能解释"为什么没 4K"
   * - `extension` + 有密文 → 本来就该优先说"你关了"
   *
   * ### ⚠️ 两条规则组合出来的行为（**单独看任何一条都推不出来**）
   *
   * 这里的顺序 + `!configured` 的判据（`isStreamingReady`）合起来，会产生一个
   * 只看代码看不出的组合行为：
   *
   * | 用户状态 | 开关默认开着 | 显示 |
   * | --- | --- | --- |
   * | **新用户，从没配过号** | 开（默认） | 走不到本分支 → 「未配置」✅ |
   * | **配过号、后来手动关了开关** | 关 | 本分支 → 「已停用」✅ |
   * | `page` 身份（不需要号）+ 开关关 | 关 | **上面短路里** → 「已停用」✅ |
   *
   * **所以「已停用」不会吞掉新用户的引导**：新用户开关是默认开着的，
   * 根本走不到这里。只有当用户**自己动手关过**开关，才会看到「已停用」——
   * 而那时他确实该先知道"是你自己关的"。
   *
   * ⚠️ **改这里的顺序或改 `!configured` 的判据，都要回到这张表重算一遍。**
   * 组合行为是下一个人最容易改坏的东西。
   */
  if (!proxy.enabled) {
    return {
      state: 'stopped',
      pill: '已停用',
      tone: 'neutral',
      // 用户自己关的开关，胶囊「已停用」已经说清，不需要再解释一遍
      needsLogin: false,
    };
  }

  if (!configured) {
    return {
      state: 'not-configured',
      pill: '未配置',
      tone: 'neutral',
      line: '还没配置取流账号',
      needsLogin: true,
    };
  }

  /**
   * ## `account === null` 不再直接判"凭据失效"
   *
   * 这是踩过的坑。`account` 为 null 的真实原因有两种：
   *
   *   1. 凭据真的坏了（读不出 / 已失效）
   *   2. **探活这条路走不通**，但凭据其实是好的
   *
   * 第二种很常见：探活要发 `nav` 请求，而请求可能因为分区不对、网络、
   * 风控而不确定。这时如果直接报"凭据失效"，用户会看到
   * **"画质明明是 4K，popup 却说凭据失效"** —— 比不提示更让人困惑。
   *
   * 判据改成看**规则有没有装上**：DNR 规则在 → 代理在正常工作 → 不该报警。
   * 规则不在 → 才是真的没起来，需要重新配置。
   */
  if (!account) {
    /**
     * ## 判断顺序：`hasCredential` 优先于 `ruleCount`
     *
     * 踩过的 bug：第一次点扩展图标总是提示"凭据失效，需要重新扫码"，
     * 再点一次就正常显示"已接管"。
     *
     * 原因是首次打开时 `account/summary` 还在探测中（`nav` 请求要往返），
     * 返回 `account: null`；而当时若用户不在视频页，`ruleCount` 也恰好是 0。
     * 旧逻辑只看 `ruleCount > 0`，于是走进"凭据失效"。
     *
     * 但 `proxy.hasCredential` 来自 `storage.local` 里**密文是否存在**，
     * 是同步可读、不依赖网络的**硬证据**。它说有，就一定有。
     *
     * 所以：**凭据在 → 不报警**。拿不到资料只是"暂时不知道是谁"，
     * 不是"需要重新扫码"。
     */
    if (proxy.hasCredential) {
      // 有凭据但不在播放页 → 说「未生效」比说「已接管」诚实
      if (page.kind !== 'play') return notVideo();
      // 取流账号就是这个号 → 不需要代理，**不许说「已接管」**（见 `selfIdentity()`）
      if (snap.lastActivateReason === 'self') return selfIdentity();
      // 用户选择了用浏览器账号取流 → 同一胶囊，但说的是另一件事（见 `pageIdentity()`）
      if (snap.lastActivateReason === 'page-identity') return pageIdentity();
      /**
       * ## ⚠️ **fail-closed**：只有 `'ok'` 才能说「已接管」（2026-11-11，🔴 修复）
       *
       * 这里原本是**直接** `return 已接管` —— 于是任何**没有匹配上面两个 `if`** 的
       * reason（包括将来新增的值、拼错的值、空串）都自动落进
       * 「已接管」= **谎报扩展在工作**。
       *
       * ### 为什么这是真缺陷，不是理论风险
       *
       * `tests/unit/core/ui/popup-state-unknown-reason.test.ts` 用 `as never` 构造
       * 不存在的 reason，实测**3 条红**：
       *
       * ```
       * × 未知 reason 不落进「已接管」→ expected '已接管' not to be '已接管'
       * ```
       *
       * 也就是说 `''` / `'OK'` / `'page_identity'`（下划线拼错）全都会被说成「已接管」。
       *
       * ### 判据（`methodology.md` 规则 8 的推广）
       *
       * > **决定"是否产生副作用"的布尔必须用正向白名单（fail-closed）。**
       * > 推广：**任何决定"界面该说什么"的枚举判断，也必须用正向白名单。**
       *
       * 写判据时问一句：**将来加一个我没见过的新值，默认落进哪一边？**
       * 默认落进"告诉用户没问题" → 必须改成白名单。
       *
       * 这与 `content.ts` 的 `extensionEngaged = res.reason === 'ok'` 是同一手法
       * （那里默认"不参与取流"，这里默认"不声称已接管"）。
       *
       * ### ⚠️ `undefined` / `null`（调用方没给）**不走这道门**
       *
       * 缺参数时保持既有判据不变 —— 与 `:549` 那处同一条纪律，也与本文件
       * `streamingIdentity` 缺省时不走短路一致。**缺参数 ≠ 收到未知值。**
       */
      const reasonGiven = snap.lastActivateReason !== undefined && snap.lastActivateReason !== null;
      if (reasonGiven && snap.lastActivateReason !== 'ok') return unknownProxyState();
      return {
        state: 'active',
        pill: '已接管',
        tone: 'good',
        // 已接管时不写解释（胶囊说了同一件事）；停用是个非常态，仍要说明
        ...(proxy.enabled ? {} : { line: '凭据已配置，但代理处于停用状态' }),
        needsLogin: false,
      };
    }
    return {
      state: 'credential-missing',
      pill: '凭据失效',
      tone: 'bad',
      line: '取流账号凭据读取失败，需要重新扫码',
      needsLogin: true,
    };
  }

  /**
   * ⚠️ 「已停用」必须排在**健康检查之前**。
   *
   * 用户自己把开关关掉时，那是当下最能解释"为什么没 4K"的事实。
   * 如果先报"凭据失效"，用户会去重扫一个本来好用的号，
   * 扫完发现还是没画质——因为开关压根没开。这是纯粹的误导。
   *
   * 顺序原则：**能解释当前结果的状态优先**，与用户操作相关的优先于与后台校验相关的。
   */
  /**
   * 顺序说明：**已停用 > 未生效 > 凭据校验**。
   *
   * ⚠️ 「已停用」已在**函数前段**（`!configured` 之前）判过了，
   * 这里不再重复 —— 见上面重排注释里的六条链。
   */
  if (page.kind !== 'play') return notVideo();

  /**
   * ## 取流账号就是这个号 → **不需要代理**（2026-11-11）
   *
   * 排在「已停用」之后、健康检查之前：
   *   - 用户关掉开关时，那句话仍然最能解释"为什么没 4K"，所以先让它说
   *   - 但比健康检查**早**：账号健康不健康都改变不了"不需要代理"这件事，
   *     先报"凭据失效"会让用户去重扫一个本来就没问题的号（扫完照旧）
   *
   * 判据放在这里而不是更早，是因为它**只有到了播放页才有意义**
   * —— 非播放页已被 `notVideo()` 接走。
   */
  if (snap.lastActivateReason === 'self') return selfIdentity();
  if (snap.lastActivateReason === 'page-identity') return pageIdentity();

  /**
   * ## ⚠️ **fail-closed**：只有 `'ok'` 才能说「已接管」（2026-11-11，🔴 修复）
   *
   * 与上面 `!account` 分支里那条是**同一个判据的第二处实现**（两处都有
   * "一串 `if` + 兜底 `return 已接管`"的结构）。**两处都必须 fail-closed** ——
   * 只改一处等于没改：另一处仍会把未知 reason 说成「已接管」。
   *
   * ### ⚠️ 两个条件缺一不可（第一版写错过）
   *
   * ```ts
   * if (snap.lastActivateReason !== 'ok') return unknownProxyState();   // ❌ 写漏了 null 检查
   * ```
   *
   * 那条**把 `undefined`（"调用方没给这个参数"）也当成了"未知 reason"**，
   * 于是 11 条既有测试全红 —— 它们构造 snapshot 时根本没传 `lastActivateReason`。
   *
   * 区别：
   *
   * | 值 | 含义 | 该怎么做 |
   * | --- | --- | --- |
   * | `undefined` / `null` | **调用方没给**（旧快照 / 自动化） | **保持既有判据不变**（缺参数不改口） |
   * | 其它任何非 `'ok'` 的值 | 收到了一个**不认识的 reason** | fail-closed → 「未知」 |
   *
   * 这条纪律在本文件里已经用过两次：`streamingIdentity` 缺省时
   * **不走短路**、`lastActivateReason` 缺省时**保持原判据**。
   *
   * ### 为什么门放在这里（`account.healthy` 检查之前）
   *
   * 下面三条分支（`!account.healthy` 的非失效路径、降级、正常）**都以
   * "代理在工作"为前提**才说得出「已接管」/「已降级」。而未知 reason 时，
   * **那个前提本身不成立**。
   *
   * 尤其 `!account.healthy` 的**非失效路径**（`:581`）写着
   * 「用户能播就说明代理在工作」—— 那句话在 `reason` 未知时是**没有依据**的。
   *
   * 实测依据：`tests/unit/core/ui/popup-state-unknown-reason.test.ts`
   * 用 `as never` 构造未知值，加这条门之前 **3 条红**。
   */
  const reasonKnown = snap.lastActivateReason !== undefined && snap.lastActivateReason !== null;
  if (reasonKnown && snap.lastActivateReason !== 'ok') return unknownProxyState();

  if (!account.healthy) {
    /**
     * `healthy: false` 有两种来源，必须区别对待：
     *
     *   1. **明确失效**（reason 含 `-101`）→ 凭据真的坏了，必须让用户重扫
     *   2. **探测不确定**（网络 / 分区不对 / 风控）→ 只是"确认不了"，
     *      不该让用户去重扫一个本来好用的账号
     *
     * 判据：`reason` 里出现 `-101` 才算第 1 种。
     * `core/auth/account-info.ts` 里 `judgeNav` 对 `-101` 生成的 reason
     * 固定是「账号未登录（-101）」，这里按这个特征匹配。
     *
     * 此外，只要 DNR 规则还在、开关还开着，实际取流就是正常的——
     * 那种情况下即使探测失败也不该报警（用户能播 4K 却被告知要重扫，最误导）。
     */
    const definitivelyExpired =
      typeof account.reason === 'string' && account.reason.includes('-101');
    const proxyWorking = proxy.enabled && proxy.ruleCount > 0;

    if (definitivelyExpired && !proxyWorking) {
      return {
        state: 'expired',
        pill: '凭据失效',
        tone: 'bad',
        line: account.reason ? `取流账号登录已过期（${account.reason}）` : '取流账号登录已过期',
        needsLogin: true,
      };
    }

    return {
      state: 'active',
      pill: '已接管',
      tone: 'good',
      // 用户能播就说明代理在工作；这条未通过校验是后台视角，不打扰他

      needsLogin: false,
    };
  }

  /**
   * ## `ruleCount === 0` **不再报「异常」（2026-10-29 用户否决）**
   *
   * 原来的逻辑：开关开着但 0 条规则 → 显示「开关开着但规则没装上，请关闭再开启一次」。
   *
   * 用户实测推翻了它：
   *
   * > 「番剧页从别的页面切回来 popup 里面就会显示开关开着但规则没装上，
   * > 请关闭再开启一次，可问题是播放已经成功的被接管了，不用再重新开关一次」
   *
   * 两种情况会让 `ruleCount` 读到 0，而代理其实好好的：
   *
   *   1. **切回标签页的瞬间**——标签页规则随 `page/activate` 异步重建，
   *      popup 恰好在这个窗口打开就读到 0
   *   2. `countPathRules()` 只数 `kind === 'path'` 的全局规则，
   *      而番剧页实际生效的是**标签页规则**（`tabIds`）—— 口径本来就对不上
   *
   * 而「取流成功了」这个事实比规则计数硬得多：规则没装上的话，
   * 播放账号的 4K 根本取不回来。用户能播 4K 却被告知"规则没装上"，
   * 是这条提示最糟糕的形态 —— 它让用户去修一个没坏的东西。
   *
   * 所以现在**不报警、不提示**，直接落到「已接管」。
   * `ruleCount` 仍然保留在 `PopupSnapshot` 里供诊断页使用 ——
   * 那里才是看"规则到底几条"的地方。
   */
  const rate = sampleRate(buckets);
  if (rate !== null && rate < DEGRADED_RATE) {
    return {
      state: 'degraded',
      pill: '已降级',
      tone: 'warn',
      line: `代理正常但取流常失败（成功率 ${String(Math.round(rate * 100))}%），视频仍可正常播放`,
      needsLogin: false,
    };
  }

  return {
    state: 'active',
    pill: '已接管',
    tone: 'good',
    needsLogin: false,
  };
}

/**
 * 会员到期日的相对描述。
 *
 * 用相对时间而不是绝对日期：用户看 popup 时想的是"要不要续费"，
 * 不是"2026-11-30 是周几"。
 *
 * ⚠️ 用 `floor` 不是 `ceil`。踩过：`ceil` 会把"还有 1 小时"算成
 * "1 天后到期"，把"还剩 1 天零 1 分钟"显示成"2 天后"——
 * 到期提醒宁可保守（显得更紧急），也不能往后拖。
 */
export function describeExpiry(expireAt: number | null, now: number): string {
  if (!expireAt) return '';
  const ms = expireAt - now;
  if (ms <= 0) return '已过期';

  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return '今天到期';
  if (days <= 30) return `${String(days)} 天后到期`;
  /**
   * 超过一年就用"年"。
   *
   * 不加这一档的话，一个 3 年期的会员会显示"36 个月后到期"；
   * 更糟的是**单位算错时**会显示"698197 个月后到期"——
   * 那种数字没人读得懂，也就没人发现它是 bug（2026-10-26 真实发生）。
   */
  if (days > 365) return `${String(Math.floor(days / 365))} 年后到期`;
  return `${String(Math.floor(days / 30))} 个月后到期`;
}

/**
 * 凭据健康状态 → 卡片第三行（2026-11-10）。
 *
 * ## 为什么要显示它
 *
 * `account/summary` 一直返回 `health: { healthy, checkedAt, reason }`，
 * 但面板从没渲染过（原 options 的账号页有，随它一起删了）。
 * 没有这一行，用户看不出凭据是否还有效 —— 只能等它失效、画质掉下来才发现。
 *
 * ## ⚠️ 只显示相对时间，**不加猜测性文案**
 *
 * `docs/02-ui-spec.md` §2.4 明确写过：
 * > 过期是内部卫生，不该变成 UI 上的疑虑
 *
 * 所以写「刚刚校验」/「5 分钟前校验」，**绝不写**「可能已过期了」「建议重新登录」。
 * 那些话术会把一个内部维护动作变成用户的日常焦虑。
 *
 * ## 唯一的例外：`healthy: false`
 *
 * 那种情况**必须**说「凭据异常：<原因>」—— 它直接影响可用性，
 * 用户有权知道。这与"不许猜测"不冲突：一个是事实，一个是猜。
 *
 * @returns 空串 = **整行不渲染**（`health` 为 null / `checkedAt` 为 0 时）
 */
export function describeHealth(
  account: Pick<PopupAccount, 'healthy' | 'checkedAt' | 'reason'> | null,
  now: number,
): string {
  if (!account) return '';

  /**
   * ## ⚠️ 必须是 `=== false`，不能写 `!account.healthy`（2026-11-10 真机假警报）
   *
   * `!value` 把 `undefined` / `null` / `0` / `''` **全当 false**。
   * 而本函数的入参是 `Pick<PopupAccount, ...>` —— 它的字段在类型上可缺省，
   * 所以**传错形状时 `healthy` 会是 `undefined`，编译期照样通过**。
   *
   * 真机事故：面板把 `AccountSummary`（健康状态嵌套在 `health` 对象里）
   * 直接当成 `PopupAccount`（扁平字段）传进来 →
   * `account.healthy === undefined` → `!undefined === true` → **显示「凭据异常」**。
   * 而底层数据是 `{"healthy":true,"ruleCount":3}`，代理完全正常。
   *
   * 那是一条**没有原因、没有动作的假警报** —— 比不显示更糟。
   *
   * 改成严格判据后：`undefined` 走"未知"分支 → **整行不渲染**。
   *
   * 同类教训在 `ui-prefs-store.ts` 文件头、`02-ui-spec.md` §7 都记过。
   */
  if (account.healthy === false) {
    return account.reason ? `凭据异常：${account.reason}` : '凭据异常';
  }

  /**
   * `healthy !== true` 且不是明确的 `false` → 形状不对 / 字段缺失 → **未知**。
   *
   * 这时**什么都不说**：写「未知」会让用户以为出了问题，
   * 而真相只是"这次没拿到这一项"。
   */
  if (account.healthy !== true) return '';

  // 从未校验过：如实说，但不渲染整行（没有信息量）
  if (!account.checkedAt) return '';

  const mins = Math.floor((now - account.checkedAt) / 60_000);
  if (mins < 1) return '刚刚校验';
  if (mins < 60) return `${String(mins)} 分钟前校验`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)} 小时前校验`;
  return `${String(Math.floor(hours / 24))} 天前校验`;
}

/** 会员类型 + 到期日，拼成账号卡片第二行 */
export function describeVip(
  account: Pick<PopupAccount, 'vipLabel' | 'expireAt'>,
  now: number,
): string {
  const base =
    account.vipLabel === 'annual'
      ? '年度大会员'
      : account.vipLabel === 'monthly'
        ? '大会员'
        : '非会员';
  const exp = describeExpiry(account.expireAt, now);
  return exp ? `${base} · ${exp}` : base;
}
