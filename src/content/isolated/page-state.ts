/**
 * 当前视频页的取流数据 —— content 侧的纯逻辑（零 DOM、零 chrome API，可单测）。
 *
 * ## 它解决什么问题
 *
 * popup §2.3 要显示"已解锁 [4K] ｜ 主账号最高 1080P"。两侧数据来源完全不同：
 *
 * | 侧 | 来源 | 拿到的是谁 |
 * | --- | --- | --- |
 * | 主账号 | `document_start` 那刻的 `window.__playinfo__` | 服务端用**主账号**生成 |
 * | 播放账号 | 页面自己发的 playurl 响应 | 已被 DNR 换成**播放账号** |
 *
 * ## 为什么"主账号基线"要这么小心
 *
 * `ADR 0010` 说 `__playinfo__` 是 SSR 的，`poc/verify/RESULT.md` §一.2 说是客户端写入的。
 * 如果是后者，那份数据来自**已被代理**的页面请求 —— 也就是播放账号自己的，
 * 拿它当基线会让对比永远显示"没有提升"（静默谎报，见 ADR 0014）。
 *
 * 所以这里的判据不是"有没有数据"，而是**"数据是在页面发 playurl 之前还是之后出现的"**：
 * 主世界会带上 `firstSeen` 与 `playurlBefore`，两者一起才能判定。
 */

import { parsePlayurl } from '@core/playinfo/parse';
import { capabilityOf, diffCapability } from '@core/playinfo/rank';
import type {
  Capability,
  PageTracksView,
  PrimaryBaselineReason,
  PrimaryUser,
} from '@shared/types/playinfo';

/**
 * `page/activate` 回包的 reason —— **派生自消息协议**（2026-11-11 改）。
 *
 * ## 为什么现在改成 import 而不是重新声明
 *
 * 原来这里是手抄的一份字面量联合，注释写着"故意重新声明，避免把类型层和
 * 应用层焊在一起"。**那个理由站不住**：
 *
 *   - 它 `import` 的只有**类型**（`import type`），编译后被完全擦除，
 *     **不会把运行时代码焊过来**，零成本
 *   - 而手抄的代价是真实的：2026-11-11 加 `'page-identity'` 时这里漏改，
 *     `tsc` **不报错**，断链被静默掩盖
 *
 * 判据：**"分层"约束的是运行时依赖方向，不约束类型别名**。
 * 同一个仓库里 `shared/types` 本身就是给所有层用的。
 */
export type ProxyActivateReason = import('@shared/types/messages').ProxyActivateReason;

/**
 * `setProxyIdentity()` 接受的**完整**输入域 = background 的六种回答 **+ "没有回答"**。
 *
 * ## 为什么必须把 `'unknown'` 写进类型，而不是让它停在 `null`
 *
 * `page/activate` **可能根本没有回包**：background 未就绪、`Extension context invalidated`、
 * 超时、`sendToBackground()` 返回 `null`、消息类型不匹配…（见 `content.ts` 的失败分支，
 * 那里明确区分了 `res === null` 与非 `page/activate:ok` 两种）。
 *
 * 这些情况下**两个号是什么关系是未知的**。若把"未知"混进"同一身份"，
 * 就会出现最坏的一类错：用户配了两个**不同**的号、background 却没应答 →
 * 面板说「取流身份与页面身份相同，无对比基线」→ 用户以为配置失效了。
 *
 * 所以 `'unknown'` 是一个**显式的一等值**，且它的判据行为是"什么都不改变"
 * （与 `disabled` / `error` / 原始 `null` 一致）。加进类型是为了让调用方
 * **必须**表态，而不是忘了调用就静默通过。
 */
export type ProxyIdentityInput = ProxyActivateReason | 'unknown';

/**
 * 哪些 `reason` 能**确证**"没有第二个身份参与取流对比"。
 *
 * ## ✅ 2026-11-11 清理完成：只剩 `'self'`
 *
 * 过渡期这里曾同时接住 `'self'` 与旧名 `'same-account'`（步骤 2 正在改名，
 * 两个任务在同一枚举上写字）。步骤 2 已落地、全量验证通过，
 * `'same-account'` 已从 `messages.ts` 的 `ProxyActivateReason` 中移除，
 * 所以这里的兼容分支也一并删掉。
 *
 * ⚠️ **不要把它加回来**。旧名留着不会报错（它只是个字符串），
 * 但会让下一个人以为 `'same-account'` 还活着，从而在两个名字之间犹豫。
 *
 * ## ⚠️ 2026-11-11 追加：`'page-identity'` **也在**这里
 *
 * 原注释写的是「只有 `'self'`」，理由是：
 *
 * > `page-identity` 是**用户的决定**，不是"两个号相同"这个事实
 *
 * **那个理由回答的是「成因」，而本数组表达的是「后果」** ——
 * 两者混淆才会得出"不该加"的结论：
 *
 * | | `self` | `page-identity` |
 * | --- | --- | --- |
 * | **成因**（谁决定） | 事实：两个 mid 恰好相同 | 选择：用户设了"用浏览器账号取流" |
 * | **后果**（有第二个身份可比吗） | **没有** | **没有** |
 *
 * 本数组的用途只有一个：**问"有没有第二个身份可以拿来对比"**。
 * 两种成因的答案都是"没有"，所以两个值都该在。
 *
 * 不加的后果（实测链条）：`page` 身份下 `primaryReason` 不会是 `same-identity`
 * → `diff` 不是 `null`（两侧同数据、增益全 0）→ 落到 `same === true` 分支
 * → 显示「无提升（**源限制**）」→ **假归因**：它暗示"这个视频本来就只有这画质"，
 * 而真相是"你只有一个号，没什么可比的"。
 *
 * ⚠️ 仍然**不在**这里的：`disabled` / `error` / `not-configured` / `unknown`
 * —— 它们是"没成功代理"或"不知道"，拿未知冒充结论比不判更糟。
 *
 * ## ⚠️ 本数组与 `content.ts` 的"清 PGC 缓存"判据**不是同一个问题**
 *
 * `entrypoints/content.ts` 里也列了 `self` 与 `page-identity`，但**答案相反**。
 * 下一个人看到两处都出现这两个值，会以为可以随便合并。**不能。**
 *
 * | | 本数组（有没有第二个身份可比） | `content.ts`（旧缓存该不该失效） |
 * | --- | --- | --- |
 * | **问的问题** | 有没有第二个身份**可对比**？ | 这份缓存**该不该清**？ |
 * | `self` | ✅ **在**（答案是"没有第二个"） | ❌ 不清（同一身份，缓存仍有效） |
 * | `page-identity` | ✅ **在**（答案是"本来就没有两个身份"） | ✅ **清**（缓存来自**另一个**账号，越权） |
 *
 * **为什么"在不在本数组"和"清不清缓存"会相反**：
 * 本数组只关心"**有没有第二个身份**"，两种成因的答案都是"没有"，所以两个值都在；
 * 而清缓存判断的是"**这份缓存来自谁**" —— `self` 时缓存来自同一个号（有效），
 * `page-identity` 时缓存来自**扩展托管的另一个号**（越权，必须清）。
 *
 * 详见 `entrypoints/content.ts` 里 `res.reason === 'disabled' || res.reason === 'page-identity'`
 * 那一段的注释。
 */
const SAME_IDENTITY_REASONS: readonly ProxyIdentityInput[] = ['self', 'page-identity'] as const;

/** 这条 reason 是否确证"没有第二个身份" */
function confirmsSameIdentity(reason: ProxyIdentityInput): boolean {
  return SAME_IDENTITY_REASONS.includes(reason);
}

/** 主世界 `ssr-playinfo` 消息的载荷 */
export interface SsrPayload {
  /** 第一次看到 `__playinfo__` 的时机 */
  firstSeen: 'initial' | 'set' | 'none';
  /** 那次赋值之前，页面是否已经发出过 playurl 请求 */
  playurlBefore: boolean;
  /** 冻结的第一份 `__playinfo__`（可能是 null） */
  data: unknown;
  /** 主账号显示信息，可能为 null（`__INITIAL_STATE__` 还没就绪） */
  user: PrimaryUser | null;
}

export class PageState {
  /**
   * 当前页的键：普通视频是 bvid，PGC（番剧/国创/电影）是 `ep:{epId}` / `ss:{seasonId}`。
   *
   * ## 为什么不再是 `bvid`（2026-10-29 修）
   *
   * 原来是 `private bvid`，只有 `/video/BV…` 会调 `setPage()`，PGC 页从未登记。
   * 而 `view()` 第一行就是 `if (!this.bvid) return null` —— 于是**番剧页上
   * `view()` 恒为 `null`**，连带三件事一起失效：
   *   - popup 的 §2.3 永远显示「正在读取本页取流数据…」
   *   - §2.4 的 A 卡片拿不到 `primary.user`，只能写「打开视频页后可见」
   *   - options 账号页的主账号卡片同样拿不到昵称
   *
   * 当时的理由是「PGC 的 SSR 基线会被主世界改写成播放账号的流，不可信」。
   * 但那个理由只对**能力基线**成立，对主账号的**显示信息**（uname / level /
   * loggedIn）根本不成立 —— 那些字段与取流身份无关。用一个「基线不可信」
   * 去否决整份数据，是把两件事捆在一起了。
   */
  private pageKey = '';
  private p = 0;

  private primaryCap: Capability | null = null;
  private primaryReason: PrimaryBaselineReason = 'absent';
  private user: PrimaryUser | null = null;

  private playbackCap: Capability | null = null;
  /** 是否收到过播放账号侧的响应（区分"还没来"和"来了但解析不出"） */
  private sawPlayback = false;

  /**
   * 主账号 mid（来自 `document.cookie` 的 `DedeUserID`）。
   *
   * ⚠️ `null` 有两种含义，靠 `midSettled` 区分：
   *   - `midSettled === false`：还没到能读的时候（`document_start` 时 cookie 常为空）
   *   - `midSettled === true` 且 `mid === null`：确实没登录
   */
  private primaryMid: string | null = null;
  private midSettled = false;

  /**
   * `page/activate` 回包的结果。初值 `'unknown'` = **还没收到回包**。
   *
   * ## 为什么必须存这一项（本类的输入域缺口）
   *
   * `applySsr` / `setPrimaryMid` / `applyPlayback` 三个入口**都无法回答**
   * "取流身份是不是和页面身份同一个号"：
   *
   *   - `applySsr` 只知道 `__playinfo__` 出现的**时机**，不知道用了谁的凭据
   *   - `setPrimaryMid` 只知道页面是谁
   *   - `applyPlayback` 只知道页面发出了 playurl，不知道它被代理了没有
   *
   * 唯一能回答的是 `page/activate` 的 `reason`（background 在那里比对两个 mid）。
   * 不加这一项，`'same-identity'` 就是一个**真机上永远算不出来的 reason** ——
   * 类型能编译、单测能过，但那条分支是死代码。
   *
   * ## 完整输入域：五种回答 + "没有回答"（"看输入域，不看它写得多完整"）
   *
   * | 输入 | 含义 | 是否同一身份 | 为什么 |
   * | --- | --- | --- | --- |
   * | `'self'` | 两个 mid 相同 → 无需代理 | ✅ **是（唯一确证）** | background 直接比对了两个 mid |
   * | `'page-identity'` | 用户选了浏览器登录态 → 无需代理 | ❌ **否** | 是**用户的决定**，不是"两个号相同"这个事实。混成 `self` 会给出错误的界面归因 |
   * | `'ok'` | 规则已装，取流用**另一个**身份 | ❌ 否（但也不改判） | 有两个身份，基线有效，保持原判 |
   * | `'disabled'` | 用户关了总开关，**没代理** | ❌ **否（最易判错）** | 没代理 ≠ 同一身份。用户可能配的是另一个号只是关了开关 |
   * | `'not-configured'` | 还没扫码 | ❌ 否 | 没有取流账号，`playback` 恒 null → 自然落到「等待取流…」 |
   * | `'error'` | 装规则时抛异常 | ❌ **否（第二易判错）** | 失败 ≠ 关系已知。可能在 credential/os 之后任何阶段炸的 |
   * | **`'unknown'`** | **回包没来**（SW 休眠 / context invalidated / 超时 / `res === null`） | ❌ **否（最危险）** | 没收到 ≠ 不是同一账号。当成"是"会让配了两个号却说"同一身份" |
   *
   * ⚠️ `disabled` / `error` / `unknown` 判错的后果一样：把"不知道"伪装成"确证是同一身份"，
   * 于是面板说「当前只有一个身份，无对比基线」—— 而真相是用户自己关了开关、
   * 或者 background 根本没应答。这正是 `collect.ts` 三态设计要防的"把未知当结论"。
   *
   * ## 时序：回包可能晚于 `applySsr`，也可能早于
   *
   *   - 晚到（实测 `page/activate` 回包 ~400ms，`patchedAt: 358ms`）：
   *     `applySsr` 已经写了 `'ssr'`，此时必须**覆盖**它。
   *     ⚠️ 不能沿用 `applySsr` 里"好消息不许被坏消息覆盖"的规则 ——
   *     `same-identity` 下从来就没有过"好消息"，那个 `'ssr'` 是错的。
   *   - 早到：`applySsr` 自己的分支必须先看 `proxyIdentity`，否则又会写回 `'ssr'`。
   *
   * 两条都处理了，所以无论先后结论一致。
   */
  private proxyIdentity: ProxyIdentityInput = 'unknown';

  private updatedAt = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * 报到时设定当前页。
   *
   * @param key 普通视频传 bvid（`BV1xx411c7mD`）；PGC 传 `ep:{epId}` / `ss:{seasonId}`
   * @param p   第几个分 P。PGC 页没有分 P，传 1
   *
   * ⚠️ **pageKey 或分 P 变了就清空两侧数据。** 不清的话，切 P / 切集之后
   * 上一集的能力会被当成本集的能力 —— 两个视频码率不同时结论直接错。
   */
  setPageKey(key: string, p: number): void {
    if (key === this.pageKey && p === this.p) return;
    this.pageKey = key;
    this.p = p;
    this.primaryCap = null;
    this.primaryReason = 'absent';
    this.user = null;
    this.playbackCap = null;
    this.sawPlayback = false;
    this.primaryMid = null;
    this.midSettled = false;
    /**
     * 换页 → "这次的回包还没来"，所以复位成 `'unknown'`，**不是 `null`**。
     *
     * 语义上也对：`'unknown'` 的含义就是"未表态"，与"新页面还没发 page/activate"
     * 完全一致。用 `null` 会让类型多一个与 `'unknown'` 行为相同的分支 ——
     * 两个值表达同一件事，是下一个人误读的来源。
     *
     * ⚠️ 这里必须清：不清的话用户切到新视频，新页面明明可以被代理，
     * 界面却沿用上一页的"同一身份"结论（`SINGLE.md` §2.2 入口 B 记过
     * `client-written` 粘住到下次刷新的错，新状态不能重犯）。
     */
    this.proxyIdentity = 'unknown';
    this.touch();
  }

  /**
   * 记录 `page/activate` 的回包结果 —— **`'same-identity'` 的唯一数据来源**。
   *
   * @param reason background 对"这个标签页要不要代理"的回答
   *
   * ## 为什么要"追认"已经判定过的基线
   *
   * `page/activate` 的回包（实测 ~400ms）常常**晚于** `applySsr` 的判定
   * （`main-world.js` 在 `document_start` 后不久就报了 `ssr-playinfo`）。
   * 那时 `applySsr` 已经写了 `'ssr'`，而那个 `'ssr'` 在 `'self'`（原 `same-account`）下是错的：
   * 它描述的是一份"基线"，可那份数据和取流数据来自**同一个号**。
   *
   * 所以这里必须**覆盖** `primaryReason`，并清空 `primaryCap` ——
   * 清空是为了让 `usable` 同时变 `false`，否则会出现
   * "reason 说同一身份，usable 却是 true"的自相矛盾。
   *
   * ⚠️ 只在 `'self'` 时覆盖。其余 reason **什么都不改**：
   * `ok` 时基线是好的（不动）；`disabled` / `not-configured` / `error` 时
   * 我们**不知道**两个号是什么关系（不知道 ≠ 同一身份），保持原判。
   * `page-identity` 同理不改判 —— 用户选了用浏览器账号，但那不等于"两个号相同"，
   * 而且那种模式下本来就没有可比的两个身份。
   * 把"不知道"写成"同一身份"与把"未知"写成"失败"是同一类错误。
   */
  setProxyIdentity(reason: ProxyIdentityInput): void {
    this.proxyIdentity = reason;
    if (confirmsSameIdentity(reason)) {
      this.primaryReason = 'same-identity';
      this.primaryCap = null;
    }
    this.touch();
  }

  /**
   * 记录主账号是否登录。
   *
   * @param mid 从 `DedeUserID` 读到的 mid，读不到就是 `null`
   * @param settled 这次读取是否发生在**能读到 cookie 的时机**（DOM 就绪后）。
   *   `document_start` 那次要传 `false` —— 那时 cookie 常为空，读不到不代表游客。
   *
   * 判定规则：**读到过真实 mid 就永久算已登录**（账号不会在同一页面里变成游客）；
   * 只有在"该读到的时机"仍读不到，才判为未登录。
   */
  setPrimaryMid(mid: string | null, settled: boolean): void {
    if (mid !== null) {
      this.primaryMid = mid;
      this.midSettled = true;
    } else if (settled) {
      this.midSettled = true;
    }
    this.touch();
  }

  /**
   * 应用主世界报来的 SSR 快照。可能被调用多次（hello / ready / 延迟补报）。
   *
   * 合并规则：
   *   - `user` 后到的覆盖先到的（`__INITIAL_STATE__` 往往晚于 `__playinfo__` 就绪）
   *   - 能力**只接受可用基线**；已经拿到可用基线后，后来的坏消息不许把它抹掉
   */
  applySsr(payload: SsrPayload): void {
    if (payload.user) this.user = payload.user;

    /**
     * `page/activate` 已经先说"两个号是同一个" → 基线**永远**不可比。
     *
     * 这是时序的另一半（回包**早于**这条消息）：若不在这里拦住，
     * 下面会把它判成 `'ssr'`，把"同一份数据"包装成一条可用基线。
     *
     * 反过来（回包晚到）由 `setProxyIdentity()` 覆盖处理。两条路都覆盖，
     * 所以无论 network 快慢结论一致 —— 这是本判据能成立的前提。
     */
    if (confirmsSameIdentity(this.proxyIdentity)) {
      this.primaryReason = 'same-identity';
      this.primaryCap = null;
      this.touch();
      return;
    }

    const usable = payload.firstSeen !== 'none' && !payload.playurlBefore;

    if (!usable) {
      // 好消息不许被后到的坏消息覆盖
      if (this.primaryReason !== 'ssr') {
        this.primaryReason = payload.firstSeen === 'none' ? 'absent' : 'client-written';
      }
      this.touch();
      return;
    }

    const cap = capabilityOf(parsePlayurl(payload.data));
    if (cap) {
      this.primaryCap = cap;
      this.primaryReason = 'ssr';
    } else if (this.primaryReason !== 'ssr') {
      this.primaryReason = 'unparsable';
    }
    this.touch();
  }

  /** 应用页面自己的 playurl 响应（播放账号身份） */
  applyPlayback(raw: unknown): void {
    this.sawPlayback = true;
    const cap = capabilityOf(parsePlayurl(raw));
    // 解析不出时**不清空**已有能力：多 P / 重复请求里偶发一次坏响应，
    // 不代表之前拿到的轨道不存在
    if (cap) this.playbackCap = cap;
    this.touch();
  }

  /**
   * 给 UI 的快照。
   *
   * @returns `null` 表示"当前不是视频页 / 还没报到" —— UI 该说"打开任意视频页查看效果"
   */
  view(): PageTracksView | null {
    if (!this.pageKey) return null;

    return {
      pageKey: this.pageKey,
      p: this.p,
      updatedAt: this.updatedAt,
      primary: {
        /**
         * ⚠️ `same-identity` 下 `usable` **必然是 `false`**（且 `capability` 也被清空），
         * 因为那时没有任何"基线"可言。
         *
         * 但 `false` 在这里**不表示"出错"** —— 意思是"不需要关注"。
         * 诊断台据此**不设 `ok` 字段**（三态的中性态），而不是设成 `ok: false`
         * （那会让 `tipFor()` 报「主账号基线不可用」并遮蔽所有其他诊断）。
         * 见 `collect.ts` 的 `pageTracksRowsFrom()`。
         */
        usable: this.primaryReason === 'ssr' && this.primaryCap !== null,
        reason: this.primaryReason,
        capability: this.primaryCap,
        user: this.user,
        mid: this.primaryMid,
        loggedIn: this.midSettled ? (this.primaryMid === null ? 'no' : 'yes') : 'unknown',
      },
      playback: this.sawPlayback ? { capability: this.playbackCap } : null,
      diff: diffCapability(this.primaryCap, this.playbackCap),
      /**
       * 最近一次 `page/activate` 的结果 —— **给 popup 用**。
       *
       * ## 为什么要从 `view()` 出来，而不是加一个 `getProxyIdentity()`
       *
       * `view()` 是本类**唯一的出口**。绕过它直接读内部状态会让"什么时候读到的"
       * 变得不可控 —— 而这一步最大的坑恰恰是**时序**（`SINGLE.md:129`：
       * 回包 ~400ms vs `applySsr` 在 `document_start` 后不久）。
       *
       * 调用方（`content.ts`）本来就在调 `view()`，顺路拿这一个字段，
       * 不额外增加读点、不引入新的竞态窗口。
       *
       * ⚠️ 也**不要**把 `proxyIdentity` 改成 `public` 字段：那等于开了第二个出口。
       */
      proxyIdentity: this.proxyIdentity,
    };
  }

  private touch(): void {
    this.updatedAt = this.now();
  }
}
