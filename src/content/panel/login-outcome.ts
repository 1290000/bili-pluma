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
 * | 应答 | 含义 | 提示 |
 * | --- | --- | --- |
 * | 不是 `:ok` | 消息本身没成功（background 没处理/异常） | 笼统"打不开，请重试" |
 * | `opened: false` + `incognito-disabled` | **最常见**：没勾「在 InPrivate 中允许」 | 直接告诉他去哪里勾 |
 * | `opened: false` + 其他 | 窗口创建失败（被拦截等） | 笼统"打不开，请重试" |
 * | `opened: true` | 成功了 | 告诉他去扫码 |
 *
 * ⚠️ `incognito-disabled` 那条**必须单独说**：
 * 它是用户能自己修的唯一一种失败，笼统说"失败"等于让他无从下手。
 *
 * ⚠️ **乐观默认为失败**：`opened !== true` 一律当失败。
 * 反过来（`opened !== false` 就当成功）会把"窗口没打开"报成
 * "已打开，请扫码" —— 用户扫半天没反应。
 *
 * @param res `login/open` 的应答；`null` = 消息本身发送失败
 * @returns `ok` 决定提示条的颜色（`false` 用危险色）
 */
export function describeLoginOutcome(res: LoginOpenReply | null): { ok: boolean; text: string } {
  if (res?.type !== 'login/open:ok') {
    return { ok: false, text: '登录窗口打不开，请重试' };
  }
  if (res.opened !== true) {
    return {
      ok: false,
      text:
        res.reason === 'incognito-disabled'
          ? '需要先在扩展详情页打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」），再点一次'
          : '登录窗口打不开，请重试',
    };
  }
  return { ok: true, text: '扫码窗口已打开，请用手机扫码。成功后这里会自动更新' };
}
