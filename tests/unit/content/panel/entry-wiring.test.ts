// @vitest-environment node

/**
 * 入口 `content-panel.content.ts` 的**接线断言**（2026-11-12，task-3）。
 *
 * ## 为什么只能这样测
 *
 * `content-panel.content.ts` 是 **WXT 入口**：`export default defineContentScript({...})`
 * 在 import 时**就有副作用**，且依赖 `chrome.*` / `document` / WXT 的注入环境。
 * 项目已有的两个同类入口测试都因此改用源码断言：
 *   - `tests/unit/content/content-entry.test.ts`（文件头写了完整理由）
 *   - `tests/unit/content/pgc-proxy-off.test.ts`（"没有任何单测能 import 它"）
 *
 * 所以这里只断言一件事：**那几行调用点还在**。
 * 行为层面的验证由 `panel/` 下的测试覆盖（它们驱动真实 `panel.ts`）。
 *
 * ## ⚠️ 这测不到什么（handoff §2.3 的纪律：写清"不覆盖什么"）
 *
 * - 测不到 `loadOnce()` 真的在失败时走了那条分支（需要真实 chrome 消息）
 * - 测不到文案在真机上是否被 `render()` 冲掉（那由 `account-logout-notice.test.ts`
 *   在真实 DOM 上验证）
 *
 * 它只防**整行被删掉**这种最常见的回退。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ENTRY = readFileSync(resolve(process.cwd(), 'entrypoints/content-panel.content.ts'), 'utf8');

/**
 * 取出 `loadOnce()` 的 `} catch { … }` 整块（到函数结束的 `};`）。
 *
 * ⚠️ 不能用固定长度切片：那段注释很长，切 900 字符会停在中途，
 * 断言就落在注释里而不是代码上（第一版踩过，报"没有 showNotice"）。
 */
function loadOnceCatchBlock(): string {
  const start = ENTRY.indexOf('const loadOnce = async');
  expect(start, '找不到 loadOnce').toBeGreaterThan(-1);

  const tail = ENTRY.slice(start);
  const catchIdx = tail.indexOf('} catch {');
  expect(catchIdx, '找不到 loadOnce 的 catch').toBeGreaterThan(-1);

  // 从 catch 开始，到 `    };`（函数结束）为止
  const rest = tail.slice(catchIdx);
  const endIdx = rest.indexOf('\n    };');
  expect(endIdx, '找不到 loadOnce 函数结束').toBeGreaterThan(-1);
  return rest.slice(0, endIdx);
}

describe('★★ 取数失败不静默（路径①）', () => {
  it('★★★ loadOnce 的 catch 里必须调 showNotice（不许裸 return null）', () => {
    /**
     * 旧实现：
     * ```
     * } catch {
     *   // 取不到就保持上一次的画面…
     *   return null;
     * }
     * ```
     * 反例：把 `catch` 里的 `showNotice` 删掉 → 本条必红。
     */
    const block = loadOnceCatchBlock();

    expect(block, 'loadOnce 的 catch 里没有 showNotice —— 取数失败又变回静默了').toContain(
      'showNotice',
    );
    expect(block, 'catch 里必须报 NOTICE_LOAD_FAILED 那句').toContain('NOTICE_LOAD_FAILED');
  });

  it('★★★ loadOnce 的**返回值形状**不变（不许改成 throw）', () => {
    /**
     * `open-cycler` 靠返回值判"普通失败、不排 `not-ready` 重试"：
     * `load: () => Promise<LoadResult | null>`，`null` = 这次失败。
     *
     * 反例：把 `return null` 改成 `throw` → 本条必红
     * （且 `open-cycler` 的节流/重试语义会被改变 —— 那是修一个 bug 引入另一个）。
     */
    const block = loadOnceCatchBlock();

    expect(block, 'catch 里不再返回 null —— 返回值形状变了').toContain('return null');

    /**
     * catch **块的代码部分**（去掉注释）里不许出现 `throw`。
     * 注释里为了解释"为什么不要 throw"会写到这个词，所以必须先剥掉注释。
     */
    const codeOnly = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(/throw\b/.test(codeOnly), 'catch 里抛了异常 —— 会改变 cycler 的重试语义').toBe(false);
  });
});

describe('★★ 退出成功但界面刷新失败要报（裁决 1 第 4 条）', () => {
  it('★★★ removeAccount 成功后必须 await loadOnce 的结局并报失败', () => {
    /**
     * 旧实现 `void loadOnce();` —— 完全不管结局。
     * 失败时面板停在旧模型，用户看到「已退出」配一张旧账号卡，自相矛盾。
     *
     * 反例：改回 `void loadOnce();` → 本条必红。
     */
    const start = ENTRY.indexOf('const removeAccount = async');
    expect(start, '找不到 removeAccount').toBeGreaterThan(-1);
    const block = ENTRY.slice(start, start + 2_400);

    expect(block, 'removeAccount 里没有 NOTICE_LOGOUT_REFRESH_FAILED').toContain(
      'NOTICE_LOGOUT_REFRESH_FAILED',
    );
    expect(block, 'removeAccount 没消费 loadOnce 的返回值').toMatch(/loadOnce\(\)\s*\.then/);
  });

  it('★★ 退出成功后仍然返回 ok（失败不冒充退出失败）', () => {
    /**
     * 取数失败不该让"退出成功"变成"退出失败"——那会让 `tabs.ts` 报
     * 「退出失败」，而账号其实已经退了。
     */
    const start = ENTRY.indexOf('const removeAccount = async');
    const block = ENTRY.slice(start, start + 2_400);
    expect(block).toContain('return { ok: true }');
  });
});

describe('★★★ 跳过轮询的判据是 shouldPoll，不是 ok（task-25）', () => {
  /**
   * ## 为什么这条必须存在
   *
   * task-25 的反向验证 RV2 暴露了一个**真空洞**：把
   * `if (!r.shouldPoll) return;` 改回 `if (!r.ok) return;` 之后，
   * 全量 **1831 条测试依然全绿** —— 这一行没有任何测试守住。
   *
   * 而它恰恰是"两个概念重新粘在一起"的唯一入口：
   * `already-open` 现在是 `ok: true`，若这里还判 `ok`，
   * 窗口已开着时会**再起一轮 3 分钟的登录轮询**，
   * 与窗口自己的轮询重复请求（服务端限流 / 状态互相覆盖）。
   *
   * 注释里会写到 `ok` 这个词（解释"为什么不是它"），所以断言必须先剥注释，
   * 否则删掉正确代码后注释仍能让它假绿。
   */
  function openLoginCodeOnly(): string {
    const start = ENTRY.indexOf('const openLogin = async');
    expect(start, '找不到 openLogin').toBeGreaterThan(-1);
    const body = ENTRY.slice(start, ENTRY.indexOf('\n    };', start));
    return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('★★★ openLogin 的早退必须判 `!r.shouldPoll`', () => {
    // 反例：改回 `if (!r.ok) return;` → 本条必红（RV2 实测过：改回去全绿 ⇒ 无守护）。
    const codeOnly = openLoginCodeOnly();
    expect(codeOnly, 'openLogin 不再按 shouldPoll 早退 —— 概念又被粘回去了').toMatch(
      /if\s*\(\s*!r\.shouldPoll\s*\)\s*return/,
    );
  });

  it('★★★ openLogin 的早退**不许**再判 `!r.ok`', () => {
    /**
     * 单独的"不许出现"断言，与上一条互补：
     * 上一条只保证 shouldPoll 在；若两行都在（`if (!r.ok) return;` 写前面），
     * `already-open`（ok:true）会先被 shouldPoll 放过去……但也可能被前面那行拦下 ——
     * 顺序无关，两种判据同时存在就是没解耦干净。
     */
    const codeOnly = openLoginCodeOnly();
    expect(codeOnly, 'openLogin 仍在用 ok 判是否轮询 —— 没解耦').not.toMatch(
      /if\s*\(\s*!r\.ok\s*\)\s*return/,
    );
  });
});

describe('★★ 点扫码登录前先清旧提示（裁决 3）', () => {
  it('★★★ openLogin 里必须先调 clearNotice', () => {
    /**
     * 反例：删掉 `controller?.clearNotice()` → 本条必红。
     */
    const start = ENTRY.indexOf('const openLogin = async');
    expect(start, '找不到 openLogin').toBeGreaterThan(-1);
    const block = ENTRY.slice(start, start + 1_200);

    expect(block, 'openLogin 没有 clearNotice —— 旧红字会与这次的失败混在一起').toContain(
      'clearNotice',
    );
  });

  it('★★ clearNotice 必须在第一个 `await` **之前**（用户点了就立刻消失）', () => {
    /**
     * 判据是**相对顺序**：`clearNotice` 早于任何 `await`。
     *
     * 为什么这条重要：清提示如果排在 `readAccountMid()` / `login/open` 之后，
     * 用户会先看到旧红字停留几百毫秒到几秒才消失 —— 那正是"点完还有红字"的观感。
     * 它排在 `stopPolling()` 之后**无所谓**：那是个同步调用，不让出主线程。
     *
     * ⚠️ 注释里也会出现 `await` 字样，所以不能直接用原始 indexOf 比大小 ——
     * 要先剥掉注释再比（第一版踩过：比的是注释里的词）。
     */
    const start = ENTRY.indexOf('const openLogin = async');
    expect(start, '找不到 openLogin').toBeGreaterThan(-1);
    const body = ENTRY.slice(start, ENTRY.indexOf('\n    };', start));
    const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const clearAt = codeOnly.indexOf('clearNotice');
    const firstAwaitAt = codeOnly.indexOf('await ');

    expect(clearAt, 'openLogin 里没有 clearNotice').toBeGreaterThan(-1);
    expect(firstAwaitAt, '找不到 await').toBeGreaterThan(-1);

    expect(clearAt, 'clearNotice 在 await 之后 —— 红字会残留几百毫秒').toBeLessThan(firstAwaitAt);
  });
});

describe('★★ refreshModel 的身份来源（B-1/B-2/B-3）', () => {
  it('★★★ 入口必须给 mountPanelBody 注入 currentStreamingIdentity', () => {
    /**
     * `refreshModel()` 不传身份 → `panel-data.ts` 缺省 `'extension'` →
     * `page` 身份被误判「未配置」、画质 Tab 说「已接管」。
     *
     * 反例：删掉这一行 → `refreshModel` 拿不到身份 → 本条必红
     * （`refresh-identity.test.ts` 的界面断言也会红）。
     */
    expect(ENTRY, '入口没把 currentStreamingIdentity 交给面板').toContain(
      'currentStreamingIdentity',
    );
  });

  it('★★ 身份来源必须是 `streamingIdentityCache`（唯一真相源），不许写死', () => {
    /**
     * 反例：改成 `currentStreamingIdentity: () => 'extension'` → 本条必红。
     */
    const idx = ENTRY.indexOf('currentStreamingIdentity');
    expect(idx).toBeGreaterThan(-1);
    const line = ENTRY.slice(idx, idx + 200);

    expect(line, '身份来源不是 streamingIdentityCache —— 写死了某个值').toContain(
      'streamingIdentityCache',
    );
    expect(
      /currentStreamingIdentity:\s*\(\)\s*=>\s*'/.test(line),
      'currentStreamingIdentity 里出现了硬编码身份字面量',
    ).toBe(false);
  });
});
