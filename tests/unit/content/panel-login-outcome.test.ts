// @vitest-environment node

/**
 * 登录窗口打开的**失败原因区分**（2026-11-10）。
 *
 * ## 为什么需要这个
 *
 * 用户真机反馈「点了没反应」。根因是面板所有消息都 `.catch(() => null)` ——
 * **失败完全静默**，用户无法判断是网络问题、没开 InPrivate 权限、还是按钮坏了。
 *
 * `login/open` 有明确的 `reason`，必须转成人话。
 *
 * ## `incognito-disabled` 是唯一"用户能自己修"的失败
 *
 * 它是**最常见**的一种：用户没在扩展详情页勾「在 InPrivate 中允许」。
 * 笼统说"登录窗口打不开"等于让他无从下手 —— 必须直接告诉他去哪里勾。
 */

import { describe, expect, it } from 'vitest';

import { ASSUMED_TEXT, describeLoginOutcome } from '../../../src/content/panel/login-outcome';

describe('★★ login/open 应答 → 用户提示', () => {
  it('★★ opened:true → 成功提示，告诉用户去扫码', () => {
    const r = describeLoginOutcome({ type: 'login/open:ok', opened: true });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('扫码');
  });

  it('★★ opened:false + incognito-disabled → **必须**告诉他去扩展详情页开权限', () => {
    /**
     * 反例：把 `incognito-disabled` 分支删掉（退回笼统文案）→ 本条必红。
     *
     * 这是用户能自己修的唯一一种失败，提示里必须出现：
     *   - 「InPrivate」（勾选项的名字）
     *   - 「扩展详情页」（去哪里勾）
     */
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      reason: 'incognito-disabled',
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('InPrivate');
    expect(r.text).toContain('扩展详情页');
    // 不能只说"打不开"
    expect(r.text).not.toBe('登录窗口打不开，请重试');
  });

  it('★ opened:false + 其他 reason → 笼统失败（那种用户修不了）', () => {
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      reason: 'window-create-failed',
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('打不开');
    // 不该误导用户去动 InPrivate 权限
    expect(r.text).not.toContain('InPrivate');
  });

  it('★ 应答类型不对（background 异常）→ 失败提示', () => {
    const r = describeLoginOutcome({ type: 'login/open:err' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('打不开');
  });

  it('★ 应答是 null（消息发送失败）→ 失败提示，不抛', () => {
    const r = describeLoginOutcome(null);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('打不开');
  });

  it('★ 应答缺少 opened 字段 → 当作失败（不能乐观地报成功）', () => {
    /**
     * 乐观默认（`opened !== false` 就当成功）会让"窗口没打开"被报成
     * "已打开，请扫码" —— 用户扫半天没反应。
     */
    const r = describeLoginOutcome({ type: 'login/open:ok' });
    expect(r.ok).toBe(false);
  });
});

/**
 * ## 「点了完全没反应」的两个来源（2026-11-12，task-22）
 *
 * 用户报的现象是「点扫码登录取流账号完全没反应」。拆开是两个**不同**的原因：
 *
 * | 场景 | 旧行为 | 为什么等于没反应 |
 * | --- | --- | --- |
 * | 权限值读到 `false` | 提示「**再点一次**」 | 权限值会自己掉，点多少次都过不去 |
 * | 说明页已开着 | `already-open` → 落进「已打开，请扫码」 | 窗口只被聚焦，本来就在最前面 ⇒ 屏幕无变化 |
 */
describe('★★★ 权限 false：文案必须给出两个明确动作（task-22 → task-37 口径反转）', () => {
  /**
   * ## 🔄 口径反转（2026-11-12 task-37），请勿改回去
   *
   * > **task-22 加 `not.toContain('再点一次')` 的前提（权限自己会掉、所以让用户再点没用）
   * > 已被 task-32 + `poc/probe/incognito-api-probe/read-flips.cjs` 推翻：
   * > `isAllowedIncognitoAccess` 读数抖动 15 次，不是权限真的掉了。
   * > 所以"再点一次"重新成为正确指令。**
   *
   * 展开说：
   * 1. task-22 时我删掉「再点一次」，理由是权限值会自己掉
   *    （`14:41:46` 读到 true → `14:42:04` 已是 false，用户没动过开关）。
   *    那个观测现在已知是 `isAllowedIncognitoAccess()` **读数抖动**造成的，
   *    不是权限真的在掉（22 次去重读取 true 10 / false 12、时间序翻转 15 次，
   *    来自 21 个不同 SW 实例 —— 见 `poc/probe/incognito-api-probe/read-flips.cjs`）。
   * 2. 权限判据已经**从决策路径撤掉**（task-32 改成"先试再判"，权限值只进 diag），
   *    所以"点多少次都读到 false"这个因果链**不再存在**；
   * 3. investigator task-36 证明用户看到的空白 popup 是**说明页被浏览器拦掉**，
   *    他根本没机会从 popup 里读到任何指引 —— 面板这条提示必须自己写全动作。
   *
   * 裁决依据：任务卡 task-37 明写文案为
   * 「需要先在扩展详情页打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」），
   *  然后再点一次」。
   *
   * 🔁 反向验证：删掉「再点一次」这个动作 → 本条必红。
   */
  it('★★★ 必须包含"再点一次"这个后续动作', () => {
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      reason: 'incognito-disabled',
    });

    expect(r.text, '只让用户去开开关、没说开完要做什么，他回到页面仍然不知道下一步').toContain(
      '再点一次',
    );
  });

  it('★★★ 必须说清"在哪开"（扩展详情页 + InPrivate），只说"权限没开"用户找不到地方', () => {
    /**
     * 用户看的那个 popup 可能压根没渲染（被浏览器拦掉），
     * 所以路径必须写在这条提示里。
     *
     * 🔁 反向验证：删掉「扩展详情页」→ 本条必红。
     */
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      reason: 'incognito-disabled',
    });

    expect(r.text, '没有说去哪儿开').toContain('扩展详情页');
    expect(r.text, '没有点名那个开关').toContain('InPrivate');
  });

  it('★★★ 保留「去哪里开」的路径指引（用户仍然需要知道怎么修）', () => {
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      reason: 'incognito-disabled',
    });

    expect(r.text).toContain('InPrivate');
    expect(r.text).toContain('扩展详情页');
  });

  it('★★★ **不断言是谁关的**（我们不知道，写了就是编造）', () => {
    /**
     * 可能是用户自己关的、可能是浏览器策略、可能是扩展重载后重置。
     * 代码只知道"读到 false"，不知道"为什么变成 false"。
     *
     * 所以文案里不许出现任何归因，也不许让用户背锅。
     *
     * 🔁 反向验证：加一句「可能是你刚才关掉了」→ 本条必红。
     */
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      reason: 'incognito-disabled',
    });

    for (const blame of ['你关闭', '你关掉', '你手动', '被系统', '浏览器自动']) {
      expect(r.text, `断言了归因「${blame}」—— 代码并不知道`).not.toContain(blame);
    }
  });
});

describe('★★★ 说明页已开着：必须给出可见反馈（task-22 缺陷 2）', () => {
  it('★★★ `already-open` 必须产生一条**与成功不同**的提示', () => {
    /**
     * ## 为什么这条是缺陷
     *
     * `openLoginWindow()` 在窗口已存在时只做 `chrome.windows.update({focused:true})`。
     * 那个窗口**本来就在最前面** ⇒ 视觉上什么都没发生。
     *
     * 旧代码更糟：`describeLoginOutcome` 里 `already-open` 没有分支，
     * 直接落进最后的成功文案「扫码窗口已打开，请用手机扫码」——
     * **用户看到"已打开"，但屏幕上没有新窗口**，于是以为按钮坏了。
     *
     * 🔁 反向验证：删掉 `already-open` 分支（落回成功文案）→ 本条必红。
     */
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: true,
      reason: 'already-open',
    });

    expect(r.text).not.toBe(describeLoginOutcome({ type: 'login/open:ok', opened: true }).text);
  });

  it('★★★ 提示必须告诉用户「去那个窗口操作」，而不只是「已打开」', () => {
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: true,
      reason: 'already-open',
    });

    expect(r.text, '没告诉用户窗口在哪').toContain('已经开着');
    expect(r.text, '没告诉用户去那里操作').toContain('窗口');
  });

  it('★★★ `already-open` 是**好消息**（`ok:true`）—— 不许再让它走危险色（task-25）', () => {
    /**
     * ## 口径反转了，请勿改回去（2026-11-12，task-25）
     *
     * 旧断言是 `expect(r.ok).toBe(false)`，理由是"这次点击没打开新窗口"。
     * 但 `ok` 同时管着**颜色**和**是否自动消失**（`panel.ts`：
     * `classList.toggle('danger', !ok)`；只有 `ok === true` 才 setTimeout）——
     * 于是用户看到**红色**的「扫码登录窗口已经开着了」**常驻不消失**，
     * 以为又出错了。verifier 实测确认。
     *
     * 而窗口确实在，这是好消息。`ok` 现在只表达"这条提示是不是坏消息"。
     *
     * 🔁 反向验证：把 `already-open` 的 `ok` 改回 `false` → 本条必红。
     */
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: true,
      reason: 'already-open',
    });
    expect(r.ok).toBe(true);
  });

  it('★★★ `already-open` 仍然不启动轮询 —— 但判据是 `shouldPoll`，不是 `ok`（task-25）', () => {
    /**
     * ## 这条守住的是「两件事解耦」本身
     *
     * 旧版本靠 `ok:false` 顺带跳过轮询，于是"不轮询"和"红字"被绑死。
     * 现在 `shouldPoll` 独立表达它：窗口本来就在跑自己的轮询，
     * 这里再启一轮只是重复请求。
     *
     * 🔁 反向验证：把 `shouldPoll` 改成 `true`（或删掉这个字段让
     * `openLogin()` 回退判 `ok`）→ 本条必红。
     */
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: true,
      reason: 'already-open',
    });
    expect(r.shouldPoll).toBe(false);
  });

  it('★★★ `ok` 与 `shouldPoll` 正交：already-open 是「好消息 + 不轮询」这个组合', () => {
    // 单独断言，防止有人把两者重新推导成同一个值：
    // 只要出现"ok 由 shouldPoll 推出来"或反之，本组合就不可能同时成立。
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: true,
      reason: 'already-open',
    });
    expect(r.ok).toBe(true);
    expect(r.shouldPoll).toBe(false);
  });
});

describe('★★ 正常成功路径不受影响（回归保护）', () => {
  it('★★ 首次成功（无 reason）→ 成功色 + 扫码指引', () => {
    const r = describeLoginOutcome({ type: 'login/open:ok', opened: true });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('扫码');
  });

  it('★★ `assumed`（乐观成功）→ 仍是成功色，**不**被 already-open 分支误伤', () => {
    /**
     * `assumed` 是 `opened: true` + `reason:'assumed'`，必须走成功分支。
     * 若把 already-open 的判断写成「有 reason 就算 already-open」→ 本条必红。
     */
    const r = describeLoginOutcome({ type: 'login/open:ok', opened: true, reason: 'assumed' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('扫码');
  });
});

describe('★★★ `assumed` 不许断言「窗口已打开」（task-24）', () => {
  /**
   * ## 为什么这一组是承重的
   *
   * task-12 的实测统计：split 模式下 `create()` 返回 `id != null` 的次数是
   * **0/4**，成功路径 4/4 都是 `assumed`。也就是说 **`assumed` 是常态**，
   * 大多数用户看到的就是这一句。
   *
   * 原文案「扫码窗口已打开，请用手机扫码」在 `assumed` 下是在**陈述一件
   * 我们不知道的事** —— 用户若根本没看到窗口，会对着空气找二维码。
   */
  it('★★★ `assumed` 不得出现「已打开」这种确定断言', () => {
    const r = describeLoginOutcome({ type: 'login/open:ok', opened: true, reason: 'assumed' });
    expect(r.text).not.toContain('已打开');
    expect(r.text).not.toContain('窗口已');
  });

  it('★★★ `assumed` 必须给出「没看到窗口时怎么办」的下一步', () => {
    const r = describeLoginOutcome({ type: 'login/open:ok', opened: true, reason: 'assumed' });
    expect(r.text).toContain('没看到');

    /**
     * ## ✅ 终裁（2026-11-15，task-47 收尾）：`assumed` 文案**不许**含「再点一次」
     *
     * ### 这条断言被推翻过两次，完整历史如下（改动前必须读完）
     *
     * | 时间 | 这条断言 | 依据 |
     * | --- | --- | --- |
     * | task-24 | `toContain('再点一次')` | 以为窗口可能被浏览器挡住 |
     * | task-44 | `not.toContain('再点一次')` | 真机：用户照做 ⇒ `windowsAfter` 4→6，两个二维码叠在一起 |
     * | task-47 中途 | 短暂改回 `toContain` | **错的**：那条真机日志走的是 `already-open` 路径 |
     * | **task-47 终裁** | **`not.toContain`（本条）** | QA 探针实测：无心跳时两次**串行**点击 ⇒ `create` **2** 次 |
     *
     * ### 为什么中途那次反转是错的（QA 指出，Lead 采纳）
     *
     * `already-open` = "已证明有一个活页面刚应答过"。那个状态下重复点击本来
     * 就安全（探针：两次并发 ⇒ `create` **0** 次）—— 但那句话**根本不需要**
     * 在那里说，该说的是「它在，去任务栏找」（`ALREADY_OPEN_TEXT`）。
     *
     * 而 `assumed` = "`create()` 没抛错，但**一条证据都没有**"。
     * 在这个状态下重试就是多开窗口 ⇒ 那句话把用户引向副作用。
     *
     * 🔴 **两个状态不可外推**。谁再想把这句话加回来，必须先给出
     * 「`assumed` 状态下重试安全」的**实测**证据。
     *
     * 🔁 反向验证：把「再点一次」加回 `ASSUMED_TEXT` ⇒ 本条变红。
     */
    expect(r.text, '「再点一次」在 assumed 下会把用户引向多开窗口').not.toContain('再点一次');
    expect(r.text, '定位动作必须保留').toMatch(/任务栏|Alt\+Tab/);
  });

  it('★★ `assumed` 与「确定打开」（无 reason）必须是**不同**的文案', () => {
    const assumed = describeLoginOutcome({
      type: 'login/open:ok',
      opened: true,
      reason: 'assumed',
    });
    const sure = describeLoginOutcome({ type: 'login/open:ok', opened: true });
    expect(assumed.text).not.toBe(sure.text);
  });

  it('★★ 确定打开时仍说「已打开」（别为了修 assumed 把确定路径也改弱）', () => {
    const r = describeLoginOutcome({ type: 'login/open:ok', opened: true });
    expect(r.text).toContain('已打开');
  });
});

describe('★★★ `shouldPoll` 与 `ok` 解耦（task-25）', () => {
  /**
   * 这一组是 task-25 的核心判据：`ok`（这条提示是不是坏消息）
   * 与 `shouldPoll`（要不要现在轮询）**不许再相互推导**。
   *
   * verifier 实测的代价：`already-open` 为了不轮询取 `ok: false`，
   * 结果红色提示常驻不消失，用户以为出错了。
   */
  it('★★★ 失败分支一律 `shouldPoll: false`（打不开窗口，轮询没有意义）', () => {
    const cases = [
      null,
      { type: 'login/open:err' },
      { type: 'login/open:ok', opened: false },
      { type: 'login/open:ok', opened: false, reason: 'incognito-disabled' },
    ] as const;
    for (const res of cases) {
      const r = describeLoginOutcome(res as Parameters<typeof describeLoginOutcome>[0]);
      expect(r.ok, `失败分支不该是成功色：${JSON.stringify(res)}`).toBe(false);
      expect(r.shouldPoll, `失败分支不该轮询：${JSON.stringify(res)}`).toBe(false);
    }
  });

  it('★★★ 真的开了窗 → `ok: true` **且** `shouldPoll: true`', () => {
    // 反向锁：别为了「already-open 不轮询」把成功路径的 shouldPoll 也关掉。
    for (const res of [
      { type: 'login/open:ok', opened: true },
      { type: 'login/open:ok', opened: true, reason: 'assumed' },
    ] as const) {
      const r = describeLoginOutcome(res);
      expect(r.ok).toBe(true);
      expect(r.shouldPoll).toBe(true);
    }
  });

  it('★★★ 三种「窗口已开 / 已尝试 / 确定开」里，只有 already-open 不轮询', () => {
    const alreadyOpen = describeLoginOutcome({
      type: 'login/open:ok',
      opened: true,
      reason: 'already-open',
    });
    const assumed = describeLoginOutcome({
      type: 'login/open:ok',
      opened: true,
      reason: 'assumed',
    });
    const sure = describeLoginOutcome({ type: 'login/open:ok', opened: true });

    expect(alreadyOpen.shouldPoll).toBe(false);
    expect(assumed.shouldPoll).toBe(true);
    expect(sure.shouldPoll).toBe(true);
  });
});

/**
 * ## ★★★ `already-open` 的文案不许说谎（2026-11-15，task-47）
 *
 * ### 用户读到的假话
 *
 * 旧文案：「扫码登录窗口已经开着了 —— **它就是上面那个窗口**，请直接在那里操作」。
 *
 * 而当时那条分支的判据只是"`chrome.storage.local` 里有一条 90 秒内的心跳"。
 * 心跳的清理写在页面的 React cleanup 里，**关窗时文档被直接销毁、cleanup 不跑**
 * ⇒ 一条冻结的旧心跳把"没有窗口"说成"窗口已开着" ⇒ 用户读到"就是上面那个窗口"，
 * 屏幕上什么都没有 ⇒ 这就是他报的「点了没反应」。
 * 真机日志：同一实例连续 14 次 `already-open`，屏幕上 **0** 个扫码窗。
 *
 * ### 两件事一起改
 *
 * 1. **判据**：`probeExistingLoginWindow()` 现在要求页面**当场应答 ping**
 *    （`requestLoginWindowPong()`）—— 见 `login-heartbeat-probe.test.ts`。
 * 2. **文案**：即使证据是真的，也**不许**只断言"它就在上面" ——
 *    跨分区拿不到窗口 id，`windows.update()` 聚焦不了，它可能压在其他窗口后面、
 *    在别的虚拟桌面、或已最小化。用户需要的是"它在 + 去哪儿找"。
 */
describe('★★★ `already-open` 文案可操作、不断言看不见的东西（task-47）', () => {
  const text = describeLoginOutcome({
    type: 'login/open:ok',
    opened: true,
    reason: 'already-open',
  }).text;

  it('★★★ 必须给出**零副作用**的定位动作（任务栏 / Alt+Tab）', () => {
    /**
     * 🔁 反向验证：把文案改回「它就是上面那个窗口，请直接在那里操作」⇒ 本条变红。
     *
     * 为什么必须是"定位"动作而不是"再点一次"：重复点击会让 background 再
     * `create()` 一个窗口（task-44 真机实测：两个二维码叠在一起）。
     */
    expect(text, '没告诉用户去哪里找窗口').toMatch(/任务栏|Alt\+Tab/);
  });

  it('★★★ 不许再说「它就是上面那个窗口」（跨分区聚焦做不到，这句话是假的）', () => {
    /**
     * `chrome.windows.update()` 需要窗口 id，而 split 模式下普通实例
     * **永远拿不到**无痕窗口的 id（`create()` 返回 `undefined`）。
     * 所以"它就在上面"既不成立，也会让用户一直盯着上面等。
     */
    expect(text, '又断言了窗口的位置').not.toContain('就是上面');
    expect(text, '又断言了窗口的位置').not.toContain('直接在那里操作');
  });

  it('★★★ 不许引导重复点击（重复点击 = 多一个二维码窗口）', () => {
    expect(text).not.toContain('再点一次');
    expect(text).not.toContain('重试');
  });

  it('★★ 长度 ≤ 60 字（面板很窄，超了会折行到不可读）', () => {
    expect(text.length).toBeLessThanOrEqual(60);
  });

  it('★★ 与 `assumed` 的文案必须不同（一个是"它在"，一个是"我们不知道"）', () => {
    const assumed = describeLoginOutcome({
      type: 'login/open:ok',
      opened: true,
      reason: 'assumed',
    }).text;
    expect(text).not.toBe(assumed);
  });
});

/**
 * ## ★★★ `assumed` 的**生产形状**必须走自己的分支（2026-11-15，task-47 —— P0）
 *
 * ### 修的是什么
 *
 * task-46 把 `assumed` 的口径改成 `opened: false`（"没确认 ≠ 已打开"），
 * 但 `describeLoginOutcome()` 里 `res.opened !== true` 的通用失败分支排在前面 ⇒
 * `assumed` 直接落进『登录窗口打不开，请重试』：
 *
 * - `describeSuccess()` 的 `assumed` 分支、`ASSUMED_TEXT` 全部**不可达**；
 * - 而 split 模式下 `assumed` 是**每一次成功开窗**的形状（真机 4/4）⇒
 *   **每次开窗成功，面板都在报错** ⇒ 用户看到红色"打不开，请重试"，
 *   照做就多开一个窗口。
 *
 * ### 本组用**生产上真实出现的形状**（`opened:false` + `confirmed:false`）
 *
 * ⚠️ 上面那一组用的是 `opened:true`（task-46 之前的形状，生产上不再出现）。
 * 那组继续保留是为了守住"文案形状"；**判据正确性必须用这一组**，
 * 否则会造出"测的形状根本不存在"的假绿 —— 这次修的正是这种假绿背后的真 bug。
 *
 * 🔁 反向验证：把 `describeLoginOutcome()` 里新加的
 * `if (res.reason === 'assumed') { … }` 整段删掉 ⇒ 本组 4 条同时变红。
 */
describe('★★★ `assumed` 生产形状（opened:false）：不许再被通用失败分支吃掉', () => {
  const PRODUCTION_ASSUMED = {
    type: 'login/open:ok' as const,
    opened: false,
    confirmed: false,
    reason: 'assumed' as const,
  };

  it('★★★ 必须命中 `ASSUMED_TEXT`，而不是「登录窗口打不开，请重试」', () => {
    const r = describeLoginOutcome(PRODUCTION_ASSUMED);
    expect(r.text, 'assumed 又被通用失败文案吃掉了 —— 每次成功开窗都会报错').toBe(ASSUMED_TEXT);
    expect(r.text).not.toContain('打不开');
  });

  it('★★★ `ok` 必须是 `true`（正常路径不许染成常驻红色）', () => {
    /**
     * `ok` 只决定**颜色与是否自动消失**。`assumed` 是正常路径
     * （权限在、`create()` 没抛错、窗口很可能真开出来了）——
     * 报红等于假警报，和"点了没反应"是同一类伤害。
     */
    const r = describeLoginOutcome(PRODUCTION_ASSUMED);
    expect(r.ok, '把常态路径报成坏消息了').toBe(true);
  });

  it('★★★ `shouldPoll` 必须是 `true`（扫完码面板必须能更新）', () => {
    /**
     * 窗口很可能开着、用户很可能马上扫码。不轮询 = 扫完码面板一动不动
     * ⇒ 又是一次「点了没反应」。
     */
    const r = describeLoginOutcome(PRODUCTION_ASSUMED);
    expect(r.shouldPoll, '扫完码面板不会更新 —— 用户以为没生效').toBe(true);
  });

  it('★★★ 文案不得断言窗口已打开、也不得断言它的位置', () => {
    /**
     * `create()` 返回 `undefined` ⇒ 我们**无法确认**（task-24 的论据未被推翻）。
     * 说「已打开」= 陈述一件不知道的事；说「就是上面那个窗口」= 指一个可能不存在的位置。
     */
    const r = describeLoginOutcome(PRODUCTION_ASSUMED);
    for (const forbidden of ['已打开', '窗口已', '就是上面', '直接在那里操作']) {
      expect(r.text, `又断言了「${forbidden}」`).not.toContain(forbidden);
    }
  });

  it('★★★ 必须说清"为什么看不到"（无痕分区不可见，不是出错）', () => {
    /**
     * 不说清，用户只会以为按钮坏了 —— 而这正是他报「点了没反应」时的心理状态。
     */
    const r = describeLoginOutcome(PRODUCTION_ASSUMED);
    expect(r.text, '没有解释为什么看不到窗口').toContain('看不见');
  });
});

/**
 * ## ★ 回归：新分支不许波及已有的失败分支
 *
 * `assumed` 分支插在 `opened !== true` 之前，是最容易误伤别人的位置
 * （把判断写成"有 reason 就算 assumed"会让 `incognito-disabled` 也走好的分支）。
 */
describe('★ 回归：`assumed` 分支不许波及 `incognito-disabled` / `unknown`', () => {
  it('★ `incognito-disabled` 仍然是失败：ok:false / shouldPoll:false / 说清去哪开', () => {
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      confirmed: false,
      reason: 'incognito-disabled',
    });
    expect(r.ok).toBe(false);
    expect(r.shouldPoll).toBe(false);
    expect(r.text).toContain('InPrivate');
    expect(r.text).toContain('扩展详情页');
    expect(r.text, '被 assumed 的文案污染了').not.toBe(ASSUMED_TEXT);
  });

  it('★ `unknown` 仍然是失败：ok:false / shouldPoll:false / 笼统提示', () => {
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      confirmed: false,
      reason: 'unknown',
    });
    expect(r.ok).toBe(false);
    expect(r.shouldPoll).toBe(false);
    expect(r.text).toContain('打不开');
    expect(r.text, '被 assumed 的文案污染了').not.toBe(ASSUMED_TEXT);
  });
});
