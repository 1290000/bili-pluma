// @vitest-environment node

/**
 * 缺陷 1：`windows.create` 的返回值与异常**不许被吞掉**（2026-11-12，task-22）。
 *
 * ## 为什么这个测试是"读源码"而不是"跑函数"
 *
 * `handleLoginOpen()` 定义在 `entrypoints/background.ts` 里，**没有导出**，
 * 而且那个文件顶层调用了 WXT 的 `defineBackground()` —— 在单测环境里
 * 这个全局不存在（`ReferenceError: defineBackground is not defined`）。
 *
 * 这正是 `src/content/panel/login-outcome.ts` 当初被抽出来的原因
 * （见它的文件头注释）。同一个约束在这里再现。
 *
 * ## 为什么不把这段抽出来做成可测函数
 *
 * 任务卡明写：「**只改这三个点所需的最小代码，不许顺手重构**」。
 * 把一个入口函数里的分支抽成模块会牵动依赖注入、`diag` 的来源、
 * 以及 `chrome.windows` 的 mock 面 —— 那是重构，不是修缺陷。
 *
 * ⇒ 退一步：**对源码做机械断言**。它测的不是"运行行为"，而是
 * "这段代码里还有没有那个黑洞"。对**这个特定缺陷**来说，那恰好就是判据：
 *
 * > 缺陷的本质不是"算错了"，是"**什么都没记**"。
 * > 所以"有没有留下记录"本身就是行为，且能被静态文本唯一确定。
 *
 * ⚠️ 这不是万能手法。它只适用于"某段代码必须存在/必须不存在"这种结构性判据；
 * 任何涉及取值、分支、顺序的逻辑**都不许**用这种方式测。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RAW_SRC = readFileSync(
  fileURLToPath(new URL('../../../entrypoints/background.ts', import.meta.url)),
  'utf8',
);

/**
 * ## ⚠️ 必须先剥注释再断言（这条自己踩过）
 *
 * 第一版直接在内含注释的源码上匹配 `.catch(() => {})`，结果**假红** ——
 * 命中的是注释里那句「旧代码是 `.catch(() => {})`」，不是真实代码。
 *
 * 反过来更危险：若判据是"必须包含某段代码"，注释里写一遍就能**假绿**。
 *
 * ⇒ 一律用状态机剥掉注释再匹配。**不许用那种「斜杠星号 到 星号斜杠」的
 * 单条正则** —— 它遇到字符串里的闭合符会跨块吞（本项目在 task-12 实测踩过，
 * 见 `src/background/login-window.ts` 的注释）。
 */
function stripComments(s: string): string {
  const out: string[] = [];
  let i = 0;
  let inBlock = false;
  while (i < s.length) {
    if (!inBlock && s[i] === '/' && s[i + 1] === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (inBlock && s[i] === '*' && s[i + 1] === '/') {
      inBlock = false;
      i += 2;
      continue;
    }
    if (inBlock) {
      i++;
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    // `s[i]` 在 noUncheckedIndexedAccess 下是 `string | undefined`；
    // `i < s.length` 已经保证它存在，这里只是把这个保证写给类型系统。
    out.push(s[i] ?? '');
    i++;
  }
  return out.join('');
}

const SRC = stripComments(RAW_SRC);

/**
 * 取出 `incognito-disabled` 那个分支的源码。
 *
 * 判据：从 `if (result.reason === 'incognito-disabled')` 开始，
 * 到下一个 `return { type: 'login/open:ok', opened: false, reason:` 结束。
 */
function incognitoBranch(): string {
  const start = SRC.indexOf("if (result.reason === 'incognito-disabled')");
  expect(start, '找不到 incognito-disabled 分支 —— 代码结构变了，请更新本测试').toBeGreaterThan(-1);
  const end = SRC.indexOf("reason: 'unknown'", start);
  expect(end, '找不到分支结尾').toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('★★★ 弹说明页时，`create` 的结果必须进日志（task-22 缺陷 1）', () => {
  it('★★★ 该分支内**不许**再有 `.catch(() => {})` 这种空 catch', () => {
    /**
     * ## 为什么这条是硬指标
     *
     * 旧代码：
     * ```ts
     * await chrome.windows.create({...}).catch(() => {});
     * ```
     *
     * 返回值（窗口对象）和异常**全被丢掉**。而 `diag` 写在 `create` **之前**，
     * 于是日志里永远只有「权限未开启 → 弹说明页」——
     * 窗口到底建没建成、有没有被浏览器拒绝，**一个字都没有**。
     *
     * 这一行在整轮「点了没反应」的调查里反复误导判断：日志显示走到了弹说明页的
     * 分支，用户屏幕上却没有窗口，只能靠猜。
     *
     * 🔁 反向验证：把 `create` 改回 `.catch(() => {})` → 本条必红。
     */
    expect(incognitoBranch(), '空 catch 又回来了 —— 那是一个吞掉所有证据的黑洞').not.toMatch(
      /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
    );
  });

  it('★★★ `create` 之后必须有一条 diag，且带上窗口 id', () => {
    /**
     * `id` 能区分两种完全不同的现实：
     *   - 拿到 id → 窗口**真的建出来了**（用户没看到可能是坐标/被遮挡）
     *   - id 为 undefined → 浏览器**根本没给**窗口对象
     *
     * 这两者此前的日志长得一模一样。
     */
    const branch = incognitoBranch();
    const createAt = branch.indexOf('chrome.windows.create');
    const diagAfter = branch.indexOf('await diag(', createAt);

    expect(createAt, '分支里没有 windows.create').toBeGreaterThan(-1);
    expect(diagAfter, 'create 之后没有写 diag —— 建没建成又没人知道了').toBeGreaterThan(createAt);

    const diagCall = branch.slice(diagAfter, branch.indexOf(');', diagAfter) + 2);
    expect(diagCall, 'diag 里没带窗口 id').toContain('id=');
  });

  it('★★★ diag 里必须带建出来的 URL（确认建的是说明页，不是别的东西）', () => {
    const branch = incognitoBranch();
    const createAt = branch.indexOf('chrome.windows.create');
    const diagAfter = branch.indexOf('await diag(', createAt);
    const diagCall = branch.slice(diagAfter, branch.indexOf(');', diagAfter) + 2);

    expect(diagCall, 'diag 里没带 url').toContain('url=');
  });

  it('★★★ 被拒绝时，错误原文必须进日志（不是只记"失败了"）', () => {
    /**
     * `Invalid value` / 策略拦截 / 无痕不可用 —— 这些原始 message
     * 是唯一能区分"为什么开不出来"的信息。写成"创建失败"等于没记。
     */
    const branch = incognitoBranch();

    expect(branch, '没有捕获错误').toMatch(/catch\s*\(\s*e\s*\)/);
    expect(branch, '没有把错误原文写进日志').toMatch(/error=/);
  });
});
