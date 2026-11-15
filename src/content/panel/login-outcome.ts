/**
 * 把 `login/open` 的应答翻译成**给用户看的提示**。
 *
 * ## 为什么单独一个文件（2026-11-10）
 *
 * 原来是内联在 `entrypoints/content-panel.content.ts` 的 `openLogin()` 里。
 * 那个文件顶层调用了 WXT 的全局 `defineContentScript()`，**在单测环境里不存在** ——
 * 于是这段逻辑根本没法测（`ReferenceError: defineContentScript is not defined`）。
 *
 * 而它恰恰是"失败要能说清原因"的落点：用户真机反馈「点了没反应」，
 * 根因就是所有消息 `.catch(() => null)`、失败完全静默。
 * **原因区分是这次修复的核心之一，必须有测试守住** —— 所以抽成纯函数。
 *
 * ## 为什么放在 `src/content/panel/` 而不是留在入口
 *
 * 分层方向是 `entrypoints/* → src/content`。这段是**纯字符串映射**，
 * 不碰 `chrome.*`、不碰 DOM，放哪都能测；放在面板目录下是因为
 * 它只服务面板这一个调用方。
 */

/**
 * `login/open` 应答的形状（只取面板用得到的字段）。
 *
 * ⚠️ `messages.ts` 里已有完整判别联合，这里**不重新定义消息类型**，
 * 只是给"在面板里读应答"一个局部形状，避免每处都写一遍内联类型。
 */
export interface LoginOpenReply {
  type?: string;
  opened?: boolean;
  reason?: string;
}

/**
 * ## 各分支的含义
 *
 * | 应答 | 含义 | 提示 | `ok` | `shouldPoll` |
 * | --- | --- | --- | --- | --- |
 * | 不是 `:ok` | 消息本身没成功（background 没处理/异常） | 笼统"打不开，请重试" | false | — |
 * | `opened: false` + `incognito-disabled` | 权限**当前是关着的** | 说清这个事实 + 去哪里开 | false | — |
 * | `opened: false` + 其他 | 窗口创建失败（被拦截等） | 笼统"打不开，请重试" | false | — |
 * | `opened: true` + `already-open` | 探测到扫码窗口**还活着**（心跳未过期） | 告诉他去那个窗口操作 | **true** | **false** |
 * | `opened: true` + `assumed` | 尝试了，**但无法确认窗口开没开** | 说尝试过 + 指引去任务栏找，**既不承诺也没让用户再点** | true | true |
 * | `opened: true` | 拿到了窗口对象，确定开了 | 告诉他去扫码 | true | true |
 *
 * ⚠️ `incognito-disabled` 那条**必须单独说**：
 * 它是用户能自己修的唯一一种失败，笼统说"失败"等于让他无从下手。
 *
 * ⚠️ **乐观默认为失败**：`opened !== true` 一律当失败。
 * 反过来（`opened !== false` 就当成功）会把"窗口没打开"报成
 * "已打开，请扫码" —— 用户扫半天没反应。
 *
 * ## ⚠️ `ok` 与 `shouldPoll` **必须分开**（2026-11-12，task-25）
 *
 * 旧版本只有一个 `ok`，`already-open` 为了不重启轮询取了 `ok: false` ——
 * 结果它同时**接管了显示语义**：`panel.ts` 里 `classList.toggle('danger', !ok)`
 * 让它走**危险色**，且只有 `ok === true` 才 setTimeout 清除 ⇒
 * **红色提示常驻不消失**。用户看到「窗口已经开着了」以为又出错了。
 *
 * 一个布尔量同时表达"这次成没成"和"要不要轮询"是**两件事被硬绑在一起**。
 * 现在拆开：
 * - `ok`：这条提示**是不是坏消息**（决定颜色 / 是否自动消失）
 * - `shouldPoll`：这次点击之后**要不要现在开始轮询**（决定 `openLogin()` 是否早退）
 *
 * 二者不再有推导关系。`already-open` 是 **好消息 + 不轮询**：
 * 窗口确实在（心跳未过期），所以不是坏消息；但它本来就在跑自己的轮询，
 * 这里再启一轮只会多一份重复请求。
 *
 * @param res `login/open` 的应答；`null` = 消息本身发送失败
 * @returns `ok` 决定提示条的颜色与是否自动消失；`shouldPoll` 决定是否启动轮询
 */
export function describeLoginOutcome(res: LoginOpenReply | null): {
  ok: boolean;
  text: string;
  shouldPoll: boolean;
} {
  if (res?.type !== 'login/open:ok') {
    return { ok: false, text: '登录窗口打不开，请重试', shouldPoll: false };
  }
  if (res.opened !== true) {
    return {
      ok: false,
      shouldPoll: false,
      text:
        res.reason === 'incognito-disabled'
          ? /**
             * ## 2026-11-12 task-37：这条提示**现在是主兜底**，必须自己说全
             *
             * investigator task-36 的硬证据（会话文件解码）：`need-incognito.html`
             * 有 **6 条**窗口记录、`login-window.html` **0 条**，其中 3 条
             * bounds = `(441,57 460x420)` —— 和 `windows.create({width:460,height:420})`
             * 的形状完全一致。
             *
             * ⇒ 用户在屏幕上看到的那个空白 / `ERR_BLOCKED_BY_CLIENT` 的 popup
             * **是我们弹的说明页**，不是扫码窗。说明页被浏览器拦掉之后，
             * 用户什么都没得到 —— 这就是「点了完全没反应」的全部。
             *
             * ⇒ 所以**不能指望用户去看那个 popup**（它可能压根没渲染出来）。
             * 这条提示必须自己写全：去哪开、开完做什么。它走 root 级
             * `showNotice`，跨 `replaceChildren` 存活，不随面板重绘消失。
             *
             * ## 关于「再点一次」：现在**要写**（理由变了，不是翻烧饼）
             *
             * task-22 时我删掉「再点一次」，理由是权限值会自己掉
             * （`14:41:46` 读到 true → `14:42:04` 已是 false，用户没动过开关），
             * 于是"点了就能好"是编造出来的承诺。
             *
             * task-37 这条理由**不成立了**：那个"权限自己掉"的观测，现在已知是
             * `isAllowedIncognitoAccess()` 本身读数抖动造成的，而权限判据已在
             * task-32 从**决策路径**里撤掉（改成"先试再判"，权限值只进 diag）。
             *
             * 用户需要的正是两个明确动作：**先打开开关，再点一次登录**。
             * 不写成含糊的「再点一次试试」—— 顺序和前提都要在句子里。
             */
            '需要先在扩展详情页打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」），' +
            '然后再点一次「扫码登录」'
          : '登录窗口打不开，请重试',
    };
  }
  if (res.reason === 'already-open') {
    /**
     * ## `already-open` 现在才是**真正会走到**的分支（2026-11-12，task-24）
     *
     * task-22 加这条分支时它其实是**死分支**：`openLoginWindow()` 判"已开着"
     * 只看 `currentWindowId`，而它在 split 模式下永远拿不到（`create()` 返回
     * `undefined`，走 `assumed`）。verifier（task-23）指出了这一点。
     *
     * task-24 加了心跳探测（`probeExistingLoginWindow()`）之后，这里才真的会命中。
     *
     * 提示必须**明确告诉他窗口在哪、要去那里操作**：
     * 「上面那个窗口」是用户唯一能定位它的方式（我们给不出坐标/标题）。
     *
     * ⚠️ 为什么**不是** `ok: false`（task-25 改）：它是**好消息**。
     *
     * 旧注释说「这次点击没有达成用户想要的结果 ⇒ 用 false」，理由是
     * `openLogin()` 里 `if (!r.ok) return;` 能跳过轮询。那个**目的**是对的，
     * 但手段错了：`ok` 同时管着颜色和"是否自动消失"，取 false 的代价是
     * **危险色 + 常驻不消失**（`panel.ts` 的 `classList.toggle('danger', !ok)`；
     * 只有 `ok === true` 才 setTimeout）。verifier 实测用户看到红色
     * 「窗口已经开着了」，以为又出错了 —— 而窗口确实在，这是好消息。
     *
     * 现在拆成两个字段：`ok: true`（好消息、5 秒后自动消失）+
     * `shouldPoll: false`（窗口本来就在跑轮询，别再启一轮）。
     */
    return {
      ok: true,
      shouldPoll: false,
      text: '扫码登录窗口已经开着了 —— 它就是上面那个窗口，请直接在那里操作',
    };
  }
  return { ok: true, shouldPoll: true, text: describeSuccess(res) };
}

/**
 * ## `assumed` 不许断言「窗口已打开」（2026-11-12，task-24）
 *
 * `openLoginWindow()` 在 split 模式下**永远拿不到 `create()` 的返回窗口对象**
 * （task-12 实测 4/4 次成功路径都是 `assumed`，`create()` 从未返回过 id），
 * 所以 `reason === 'assumed'` 意味着：**权限在、我们尝试了、但无法确认窗口真的开出来了。**
 *
 * 原文案对一切 `opened: true` 都说「扫码窗口已打开，请用手机扫码」——
 * 用户如果根本没看到窗口，这句话就是在**陈述一件我们不知道的事**，
 * 他会对着一个不存在的窗口扫码。
 *
 * ⚠️ **别把这条当边缘情况随手改回去**：`assumed` 不是罕见分支，它是**常态**
 * （4/4 = 100%）。也就是说——**大多数用户看到的就是这一句**。
 * 既然是常态文案，就更不能是"我们猜的结论"。
 *
 * ## 「再点一次」也被推翻了（2026-11-15，task-44）
 *
 * task-24 在这里写「如果没看到新窗口，可能是被浏览器挡住了，请再点一次扫码登录」。
 * 真机验证（Lead 授权用户在真实页面上点了两次）证明**两半都是错的**：
 *
 * 1. **「可能是被浏览器挡住了」——窗口其实开出来了。**
 *    `EnumWindows` 数到两个 420×600 的 `login-window.html - [InPrivate]` 窗口
 *    （pos `(423,46)` / `(430,58)`，叠在一起）。浏览器没有挡它。
 *    `windows.create returned id=undefined` 只表示**我们拿不到句柄**，
 *    不表示**没建出来** —— 这两件事被那句文案混为一谈了。
 * 2. **「请再点一次」——用户照做就是再开一个窗口。**
 *    18:51:02 与 18:53:12 两次点击，`windowsAfter` 从 4 变成 6，
 *    屏幕上真的多了第二个二维码窗。**是我们教会用户多开窗口的。**
 *
 * ⇒ 新文案的判据有三条：
 * - **不许**出现任何促使重复点击的指令（「再点一次」「重试」）—— 那有副作用；
 * - 给出**零副作用**的定位动作（看任务栏 / Alt+Tab）—— 窗口很可能真的在那儿；
 * - 不断言窗口已打开（task-24 的理由继续有效），只说我们**尝试过**。
 *
 * 长度上限 60 汉字：面板很窄，这行会折行到不可读。
 * 当前文案 `已尝试打开扫码登录窗口。没看到的话，去任务栏或 Alt+Tab 里找找那个新窗口`
 * = 37 个汉字 + `Alt+Tab`，留有余量。
 *
 * 🔁 反向验证：把文案改回「请再点一次扫码登录」→ `assumed 不许引导重复点击` 必红。
 */
function describeSuccess(res: LoginOpenReply): string {
  if (res.reason === 'assumed') {
    return ASSUMED_TEXT;
  }
  return '扫码窗口已打开，请用手机扫码。成功后这里会自动更新';
}

/**
 * `assumed` 的提示原文（导出是为了让测试能直接断言它，而不是复制一份字符串）。
 *
 * ⚠️ 这里是**唯一的文案来源**，`panel.ts` 的「连续点击」提示也引用它附近的逻辑，
 * 不要在别处再抄一份 —— 抄两份必然漂移。
 */
export const ASSUMED_TEXT =
  '已尝试打开扫码登录窗口。没看到的话，去任务栏或 Alt+Tab 里找找那个新窗口';

/**
 * ## 用户在本 tab 刚点过一次、短期内又点时给的提示（2026-11-15，task-44 缺陷 2）
 *
 * 语义不是「窗口一定还开着」（我们不知道），而是「**这个 tab 刚点过一次，
 * 再发一次 `login/open` 只会在屏幕上多开一个窗口**」。
 *
 * 所以措辞必须**同时**做到：
 * - 不承诺窗口一定在（我们依然无法确认）；
 * - 明确告诉用户**先去找**，而不是再点 —— 重复点击是本卡要消灭的那个副作用。
 */
export const ALREADY_ASKED_TEXT =
  '刚已经开过一次扫码窗 —— 先去任务栏或 Alt+Tab 里找找它，别重复点，否则会多开一个窗口';

/**
 * 面板侧「刚点过」记忆的有效期（毫秒）。
 *
 * ## 为什么是 2 分钟
 *
 * 三个约束夹出来的区间：
 * - **下界**：二维码要用户拿起手机扫，30 秒内不太可能完成「找窗口 + 扫码」，
 *   太短就会在用户正要点的时候放行第二次。
 * - **上界**：`src/background/login-window.ts` 的心跳 TTL 是 90 秒。
 *   我们这条记忆是**心跳失效时的替代品**，比心跳还长太多就变成
 *   「用户关掉窗口很久了还拦着他」—— 那是宁可少开也不让用户恢复，不能接受。
 * - 2 分钟 ≈ 90s TTL 的 1.3 倍：覆盖「心跳没过期但我们读不到」的那段，
 *   又不会比"窗口可能还在"的合理预期长出太多。
 *
 * ⚠️ **宁可多开一次，也不要让用户被永久拦住**：过期后自动放行，
 * 用户关掉窗口再点就能开新的。这条记忆**没有手动清除入口**，
 * 所以它必须短到"用户等一会儿就恢复"。
 */
export const REPEAT_GUARD_MS = 120 * 1000;
