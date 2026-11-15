// @vitest-environment jsdom
/**
 * # task-44：`assumed` 文案不再教用户重复点击 + 面板侧短时记忆
 *
 * ## 立卡依据（真机，2026-11-15）
 *
 * Lead 授权用户在真实页面上点了两次「扫码登录取流账号」，diag 原文：
 * ```
 * 18:51:02.300  windows.create returned  id=undefined … windowsBefore=4 windowsAfter=4
 * 18:51:02.306  login/open  {"ok":true,"reason":"assumed"}
 * 18:53:12.x    probe/heartbeat  none（没有活着的扫码窗口心跳）
 * 18:53:12.x    windows.create returned  id=undefined … windowsAfter=6
 * 18:53:12.x    login/open  {"ok":true,"reason":"assumed"}
 * ```
 * `EnumWindows` 数到**两个** 420×600 `login-window.html - [InPrivate]` 窗口
 * （pos `(423,46)` / `(430,58)`），叠在一起。
 *
 * ⇒ 缺陷 1：`assumed` 文案同时说错了两件事（"可能被挡住"、"再点一次"）。
 * ⇒ 缺陷 2：`already-open` 从未命中（心跳恒 `none`），第二次点击必然再开一个窗。
 *
 * ## 本文件测什么
 *
 * - `assumed` 文案的**形状判据**（不含引导重复点击的词、含零副作用定位动作、长度上限）
 * - 运行期探针：**连续两次调用 `openLogin()`，`login/open` 只发一次**
 *
 * ## ⚠️ 为什么用运行期探针而不是源码字符串断言
 *
 * task-35 的教训（Lead 明确点出）：`expect(src).toContain('showOrphanHint(')`
 * 测的是"字符串在不在"，不是"会不会执行"。verifier 把
 * `if (isOrphanError(e))` 改成 `if (false && isOrphanError(e))` 后
 * 13 条字符串断言**全绿**，变异活了下来。
 *
 * 所以这里把 `openLogin` 的函数体切出来，用 `new Function` 重建，
 * **真的调用两次**，数 `sendMessage` 被调了几次。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALREADY_ASKED_TEXT,
  ASSUMED_TEXT,
  describeLoginOutcome,
  REPEAT_GUARD_MS,
} from '@/src/content/panel/login-outcome';

const SRC = readFileSync(resolve('entrypoints/content-panel.content.ts'), 'utf8');

/**
 * 状态机剥注释 —— **不许用正则**。
 *
 * 教训（反复踩过三次）：`/\/\*[\s\S]*?\*\//` 遇到字符串或模板里出现的
 * 「星号 斜杠」会跨块吞掉一大段代码，把真实代码也"删"了，于是剥离后的比对
 * 要么假红要么假绿。逐字符扫描是唯一可靠的做法。
 *
 * 反引号用 `String.fromCharCode(96)` 表示：直接写反引号会让本文件自己
 * 的模板字符串提前闭合（`Unterminated string literal`）。
 */
function stripComments(code: string): string {
  const BACKTICK = String.fromCharCode(96);
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'tpl';
  let mode: Mode = 'code';
  while (i < code.length) {
    const c = code[i] ?? '';
    const n = code[i + 1] ?? '';
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === BACKTICK) mode = 'tpl';
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // 字符串 / 模板：原样保留，处理转义
    if (c === '\\') {
      out += c + n;
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'tpl' && c === BACKTICK)
    ) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 从 `at` 处的 `{` 开始配平花括号，返回整段（含外层 `{}`）。
 *
 * 起点必须精确定位：`code.indexOf('{', code.indexOf('=>', at) + 2)`
 * —— `=>` 和 `{` 之间可能有空格（task-35 在这上面连错三次）。
 */
function braceBlock(code: string, at: number): string {
  const open = code.indexOf('{', code.indexOf('=>', at) + 2);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  throw new Error('花括号没有配平 —— 切源码的起点错了');
}

/**
 * 去掉 TS 类型标注，得到 `new Function` 能解析的 JS。
 *
 * ⚠️ **顺序有讲究**，错一步就漏一种写法（task-41 实测报
 * `SyntaxError: Unexpected token ':'`）：
 *
 * 1. 先 `as X`（否则 `as { a: string }` 的冒号会被当成变量标注）
 * 2. 再**变量**声明 `let/const x: T =` —— 漏这步就死在
 *    `let res: LoginOpenReply | null = null;` 上（task-41 新增的那行）
 * 3. 再箭头回调 `(e: unknown) =>`
 * 4. 最后普通函数参数 `(a: T)`（排除箭头，否则对象字面量被误伤）
 */
function toJs(body: string): string {
  return (
    body
      .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '')
      .replace(/\b(let|const|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, '$1 $2 =')
      /**
       * 空参数列表的**返回类型**标注：`(): boolean =>` → `() =>`
       *
       * 这一条是 task-44 新加的（前几次都没暴露）：`shouldSkipRepeatOpen`
       * 写成了 `(): boolean => 判据`，上面第 2–4 条都要求"参数名以字母开头"，
       * 空 `()` 一条都不匹配，于是 `: boolean` 原样留给 `new Function`
       * ⇒ `SyntaxError: Unexpected token ')'`。
       */
      .replace(/\(\s*\)\s*:\s*[A-Za-z_$][\w$<>[\]\s|&.]*?(?=\s*=>)/g, '()')
      .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)\s*=>/g, '($1) =>')
      .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)(?!\s*=>)/g, '($1)')
  );
}

/** 切出 `openLogin` 的箭头函数体（已剥注释、已去类型标注） */
function openLoginBody(): string {
  const code = stripComments(SRC);
  const at = code.indexOf('const openLogin = async');
  expect(at, '找不到 openLogin —— 源码结构变了，先更新本测试').toBeGreaterThan(-1);
  return toJs(braceBlock(code, at));
}

/**
 * 切出 `shouldSkipRepeatOpen` 的**整条定义**（含 `const ... = ...`）。
 *
 * ## 为什么必须连它一起重建，而不是在测试里复述判据
 *
 * 复述判据 = 测的是测试自己写的逻辑，不是产品代码 —— 这正是本项目反复
 * 抓到的假绿形态（"断言前置条件不成立"）。所以这里把它从源码里切出来，
 * 与 `openLogin` 一起注入，被测的永远是**同一份源码**。
 *
 * ⚠️ 它依赖的 `lastAssumedAt` 由外层 `let` 提供（见 `buildProbe` 的 scope）。
 */
function shouldSkipBody(): string {
  const code = stripComments(SRC);
  const at = code.indexOf('const shouldSkipRepeatOpen =');
  expect(at, '找不到 shouldSkipRepeatOpen —— 源码结构变了，先更新本测试').toBeGreaterThan(-1);
  /**
   * 这是一个**跨行**的箭头函数（判据被格式化成三行），
   * 所以不能只切到本行 `\n`，也不能找第一个 `;` —— 里面 `Date.now()` 没有分号，
   * 但参数列表里的 `)` 会被 `toJs` 的第 4 条规则误伤。
   * 正确做法：从 `const` 起，取到**配对**的表达式尾（下一个空行之后的第一行代码）。
   */
  const rest = code.slice(at);
  const end = rest.indexOf('\n\n');
  return toJs(rest.slice(0, end > 0 ? end : rest.length).trimEnd());
}

describe('★★★ 缺陷 1：`assumed` 文案不许教用户重复点击（task-44）', () => {
  const assumed = describeLoginOutcome({ type: 'login/open:ok', opened: true, reason: 'assumed' });

  /**
   * 这一组是承重的：`assumed` 是真机上的**常态**（4/4 = 100%），
   * 也就是说**几乎所有用户看到的就是这一句**。
   */
  it('★★★ 不含「再点一次」「重试」这类会促使用户重复点击的指令', () => {
    /**
     * 真机证据：用户照这两句点了第二次，`windowsAfter` 4 → 6，
     * 屏幕上真的多了一个 420×600 的二维码窗。
     * 这不是"措辞不友好"，是**我们让他做了有副作用的事**。
     *
     * 🔁 反向验证 RV1：把文案改回「…请再点一次扫码登录」→ 本条必红。
     */
    expect(assumed.text, '「再点一次」会让用户多开一个窗口（真机实测）').not.toContain('再点一次');
    expect(assumed.text, '「重试」同理：重试 = 再开一个窗口').not.toContain('重试');
  });

  it('★★★ 必须给出零副作用的定位动作（任务栏 / Alt+Tab）', () => {
    /**
     * 窗口**很可能真的开出来了**（EnumWindows 数到两个），只是我们拿不到句柄。
     * 所以正确的下一步是"去屏幕上找"，不是"再开一次"。
     *
     * 🔁 反向验证：删掉「任务栏」和「Alt+Tab」→ 本条必红。
     */
    const hasLocate = assumed.text.includes('任务栏') || assumed.text.includes('Alt+Tab');
    expect(hasLocate, '没有告诉用户去哪里找窗口，他就只能再点一次').toBe(true);
  });

  it('★★★ 断言「尝试过」而**不断言**「已打开」（task-24 的理由继续有效）', () => {
    /**
     * `create()` 返回 `undefined` ⇒ 我们**无法确认**窗口开没开。
     * 说「已打开」是在陈述一件我们不知道的事（task-24 的原始论据，未被推翻）。
     */
    expect(assumed.text).toContain('尝试');
    expect(assumed.text, '不许断言窗口已打开').not.toContain('已打开');
  });

  it('★★★ 长度 ≤ 60 个汉字（面板窄，折行到不可读）', () => {
    /** 只数汉字（标点、`Alt+Tab` 这类不计入） */
    const hanChars = assumed.text.match(/[\u4e00-\u9fa5]/g) ?? [];
    expect(
      hanChars.length,
      `文案太长（${hanChars.length} 汉字）：${assumed.text}`,
    ).toBeLessThanOrEqual(60);
  });

  it('★★★ 常量与分支必须同源（不许抄两份字符串）', () => {
    /**
     * 导出 `ASSUMED_TEXT` 的唯一目的就是让测试断言**真实文案**。
     * 如果 `describeSuccess` 里手写一份字面量而常量是另一份，两边会漂移。
     */
    expect(assumed.text).toBe(ASSUMED_TEXT);
  });

  it('★★ 「连续点击」的提示同样不许引导重复点击', () => {
    expect(ALREADY_ASKED_TEXT).not.toContain('再点一次');
    expect(ALREADY_ASKED_TEXT, '要明确阻止重复点击（否则会多开窗口）').toContain('别重复点');
    const han = ALREADY_ASKED_TEXT.match(/[\u4e00-\u9fa5]/g) ?? [];
    expect(han.length, `连续点击的提示太长（${han.length} 汉字）`).toBeLessThanOrEqual(60);
  });

  it('★★ 记忆有效期落在「比心跳 TTL 长一点、但不会永久拦住用户」的区间', () => {
    /**
     * 下界 30s：二维码要用户拿手机扫，太短会在用户正要点时放行。
     * 上界 5min：**宁可多开一次，也不要让用户被永久拦住** ——
     * 这条记忆没有手动清除入口，必须短到"等一会儿就恢复"。
     */
    expect(REPEAT_GUARD_MS).toBeGreaterThanOrEqual(30 * 1000);
    expect(REPEAT_GUARD_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

describe('★★★★ 缺陷 2：连续两次点击，`login/open` 只发一次（task-44）', () => {
  /**
   * ## 假绿构造条件（必须同时满足，否则测不到东西）
   *
   * - `controller` **不能**是 null：否则 `:322` 那条与 controller 无关的兜底
   *   `showOrphanHint()` 会替主逻辑挂提示，主逻辑改坏了也照样绿（task-41 踩过）；
   * - `isOrphanHintShown()` 恒 false：否则提示被跳过；
   * - `sendMessage` 必须真的返回 `assumed` 应答，否则 `lastAssumedAt` 不会被写。
   */
  type ProbeOpts = {
    /** 控制 `chrome.storage` 是否可用（本卡不涉及，留口子便于将来扩展） */
    assumed: boolean;
    controller: 'ready' | 'null';
  };

  function buildProbe(opts: ProbeOpts): {
    run: () => Promise<void>;
    sendCount: () => number;
    noticeTexts: () => string[];
  } {
    const body = openLoginBody();
    /**
     * ⚠️ `shouldSkipRepeatOpen` **也来自源码**，不在测试里复述判据 ——
     * 否则测的是测试自己（假绿）。外面那层 `let lastAssumedAt = null;`
     * 是它依赖的闭包变量；`openLogin` 体内的赋值改的就是这一个。
     */
    const skipFn = shouldSkipBody();
    let sends = 0;
    const notices: string[] = [];

    const scope = `
      let poller = null;
      let lastAssumedAt = null;
      ${skipFn}
      const __openLogin = async () => ${body};
      return { openLogin: __openLogin };
    `;

    const chromeStub = {
      runtime: {
        id: 'probe-extension-id',
        sendMessage: async (msg: { type?: string }) => {
          if (msg?.type !== 'login/open') return { type: 'account/summary:ok', account: null };
          sends += 1;
          if (!opts.assumed) return { type: 'login/open:ok', opened: false, reason: 'unknown' };
          return { type: 'login/open:ok', opened: true, reason: 'assumed' };
        },
      },
    };

    const controllerStub =
      opts.controller === 'ready'
        ? {
            clearNotice: () => undefined,
            showNotice: (text: string) => {
              notices.push(text);
            },
          }
        : null;

    const factory = new Function(
      'chrome',
      'controller',
      'readAccountMid',
      'startLoginPolling',
      'stopPolling',
      'describeLoginOutcome',
      'isOrphanHintShown',
      'showOrphanHint',
      'ALREADY_ASKED_TEXT',
      'REPEAT_GUARD_MS',
      scope,
    ) as (...args: unknown[]) => { openLogin: () => Promise<void> };

    const built = factory(
      chromeStub,
      controllerStub,
      async () => ({ mid: null }),
      () => ({ stop: () => undefined }),
      () => undefined,
      describeLoginOutcome,
      () => false,
      () => undefined,
      ALREADY_ASKED_TEXT,
      REPEAT_GUARD_MS,
    );

    return {
      run: () => built.openLogin(),
      sendCount: () => sends,
      noticeTexts: () => notices,
    };
  }

  it('★★★★ 连续两次 `assumed`：`sendMessage({type:"login/open"})` 只被调用 **1** 次', async () => {
    /**
     * 这是本卡缺陷 2 的核心判据。
     *
     * 🔁 反向验证 RV2：去掉面板侧记忆（`shouldSkipRepeatOpen()` 恒 false）→ 本条必红。
     */
    const probe = buildProbe({ assumed: true, controller: 'ready' });
    await probe.run();
    await probe.run();
    expect(
      probe.sendCount(),
      '第二次点击又发了一次 login/open ⇒ background 会再 create 一个窗口（真机上就是这么多开的）',
    ).toBe(1);
  });

  it('★★★★ 第二次点击画的是「刚已经开过」的提示，不是 `assumed` 的文案', async () => {
    const probe = buildProbe({ assumed: true, controller: 'ready' });
    await probe.run();
    await probe.run();
    const texts = probe.noticeTexts();
    expect(texts.length, '两次点击都该有提示').toBe(2);
    expect(texts[0]).toBe(ASSUMED_TEXT);
    expect(texts[1], '第二次应换成「别重复点」的提示').toBe(ALREADY_ASKED_TEXT);
  });

  it('★★★ 对照：只点一次 → 只发一次（记忆不许影响第一次）', async () => {
    const probe = buildProbe({ assumed: true, controller: 'ready' });
    await probe.run();
    expect(probe.sendCount()).toBe(1);
    expect(probe.noticeTexts()[0]).toBe(ASSUMED_TEXT);
  });

  it('★★★ 对照：失败应答（`unknown`）**不**开始计时 —— 用户修好之后必须能立刻再点', async () => {
    /**
     * 什么都没开出来时拦住用户是错的：他会以为"点了也不反应"。
     * 判据是 `r.ok && reason === 'assumed'`，失败不记。
     */
    const probe = buildProbe({ assumed: false, controller: 'ready' });
    await probe.run();
    await probe.run();
    expect(probe.sendCount(), '失败后不该被面板记忆拦住').toBe(2);
  });

  it('★★★ 源码级：记忆必须是**闭包内存变量**，不许写 storage（卡的硬约束）', () => {
    const code = stripComments(SRC);
    /**
     * 卡的原文：「这条记忆必须是**面板侧、内存级、按 tab** 的，不许写 storage
     * （不许引入新的持久化面）」。
     *
     * 断言方式：记忆变量的**声明**必须是 `let`，且整个文件里
     * 不许出现写 storage 的调用 —— 后者由 `openLogin` 函数体切片来查，
     * 避免把文件里其他正当的 storage 使用误伤。
     */
    expect(code, '记忆必须用 let 声明（要可写）').toMatch(
      /let\s+lastAssumedAt\s*:\s*number\s*\|\s*null/,
    );
    const body = openLoginBody();
    expect(body, 'openLogin 里不许写 storage').not.toMatch(/storage\.local\.set/);
  });
});
