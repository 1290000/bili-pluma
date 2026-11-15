// @vitest-environment jsdom
/**
 * ## task-37：权限没开时，面板里**必须**给一条能照着做的提示
 *
 * ### 这条测试要杀的 bug
 * investigator task-36 的硬证据（会话文件解码）：
 * - `need-incognito.html` 有 **6 条**窗口记录，`login-window.html` **0 条**
 * - 其中 3 条 bounds = `(441,57 460x420)`、窗口 id `1673240256/259/262`
 *   —— 和我们 `tabs.create({width:460,height:420})` 的形状完全一致
 *
 * ⇒ 用户截图里那个 `ERR_BLOCKED_BY_CLIENT` 的空白 popup，**是我们弹的说明页**，
 * 不是扫码窗。说明页被浏览器拦掉之后，用户在屏幕上什么都得不到 ——
 * 于是整条链路在他眼里就是「点了完全没反应」。
 *
 * ### 所以兜底不能只挂在那个 popup 上
 * `windows.create` 成功 ≠ 页面加载成功，而**页面加载失败我们是收不到信号的**。
 * 唯一能保证用户看到的东西，是**网页里那一条提示条**（root 级 `showNotice`，
 * 跨 `replaceChildren` 存活，不随面板重绘消失）。
 *
 * ### 本文件测什么
 * 用 task-35 那套运行期探针（切 `openLogin` 函数体 → `new Function` 重建），
 * 注入 `login/open:ok { opened: false, reason: 'incognito-disabled' }`，
 * 断言 `controller.showNotice` **真的被调用**，且文案含可执行动作。
 *
 * ⚠️ 只断言"字符串出现在源码里"是不够的 —— task-35 已经证明那种守卫
 * 对 `if (false && …)` 这类变异完全无效。这里断言的是**运行期调用次数**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALREADY_ASKED_TEXT, describeLoginOutcome } from '@/src/content/panel/login-outcome';

/**
 * 重建 `openLogin` 时注入的是**真实的** `describeLoginOutcome`，不是替身 ——
 * 文案对不对（含不含动作、是不是失败色）只有走真实模块才测得到。
 */
const describeOutcome = describeLoginOutcome as unknown as (res: unknown) => {
  text: string;
  ok: boolean;
  shouldPoll: boolean;
};

const SRC = readFileSync(resolve('entrypoints/content-panel.content.ts'), 'utf8');

/** 剥注释（状态机逐字符，避免正则跨块吞掉代码） */
function stripComments(s: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 从 `from` 处的 `{` 开始按花括号配平，返回整块（含两端大括号） */
function braceBlock(code: string, from: number): string {
  let depth = 0;
  let start = -1;
  for (let i = from; i < code.length; i += 1) {
    if (code[i] === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error('花括号不配平');
}

/** 去掉函数体里的 TS 标注，得到 `new Function` 能解析的 JS */
function toJs(body: string): string {
  return (
    body
      /**
       * ⚠️ 顺序：先 `as`（否则 `as { a: string }` 的冒号会被当成变量标注），
       * 再**变量**类型标注 `let res: X = …`，再箭头回调，最后普通函数参数。
       * 漏掉第 2 步会报 `SyntaxError: Unexpected token ':'`（task-41 实测）。
       */
      .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '')
      .replace(/\b(let|const|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, '$1 $2 =')
      /**
       * 空参数列表的**返回类型**标注：`(): boolean =>` → `() =>`
       *
       * task-44 新加。前面几条都要求"参数名以字母开头"，空 `()` 一条都不匹配，
       * 于是 `: boolean` 原样留给 `new Function` ⇒ `SyntaxError: Unexpected token ')'`。
       */
      .replace(/\(\s*\)\s*:\s*[A-Za-z_$][\w$<>[\]\s|&.]*?(?=\s*=>)/g, '()')
      .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)\s*=>/g, '($1) =>')
      .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*?\)(?!\s*=>)/g, '($1)')
  );
}

function openLoginBody(): string {
  const code = stripComments(SRC);
  const at = code.indexOf('const openLogin = async');
  expect(at, '找不到 openLogin').toBeGreaterThan(-1);
  const block = braceBlock(code, code.indexOf('=>', at));
  return toJs(block.slice(1, -1));
}

type Probe = {
  /** 仅当 `shouldPoll` 为假时才会 resolve（本用例都走早退分支） */
  run: () => Promise<void>;
  /** `controller.showNotice` 的调用记录 */
  notices: { text: string; ok: boolean }[];
};

/**
 * 造受控环境跑一次 `openLogin`。
 *
 * @param reply `login/open` 的应答（`null` = 消息发送失败）
 */
function buildProbe(reply: unknown): Probe {
  const notices: { text: string; ok: boolean }[] = [];
  const chromeStub = {
    runtime: {
      /**
       * task-39 的同步守卫判据 1 读的是 `chrome.runtime?.id`。
       * 这里给一个非空 id 表示"扩展活着"——本文件测的是**正常活着**的面板，
       * 孤儿态的三种形态在 `tests/unit/content/panel/orphan-guard.test.ts`。
       */
      id: 'test-extension-id',
      sendMessage: async (): Promise<unknown> => reply,
    },
  };
  /**
   * ⚠️ `controller` 必须是**可用**的：本用例要证明的正是
   * "面板活着的时候，这条提示会被画出来"。
   * 传 null 会走到 task-33 的 document 级兜底，那测的是另一条路。
   */
  const controller = {
    showNotice: (text: string, ok: boolean): void => {
      notices.push({ text, ok });
    },
    clearNotice: (): void => undefined,
    showTab: (): void => undefined,
    setModel: (): void => undefined,
    currentTab: (): string => 'account',
    depth: (): number => 0,
    root: null,
  };

  const factory = new Function(
    'chrome',
    'controller',
    'readAccountMid',
    'startLoginPolling',
    'stopPolling',
    'describeLoginOutcome',
    'isOrphanError',
    'showOrphanHint',
    'isOrphanHintShown',
    'loadOnce',
    /** task-44：`openLogin` 第一段就调它；本文件测的是提示那句，恒 false 放行。 */
    'shouldSkipRepeatOpen',
    /**
     * task-44：拦住重复点击时画的是这条文案（`openLogin` 体内直接引用）。
     * 注入**真实常量**而不是占位串 —— 本文件三条用例只关心 incognito 那句，
     * 但用真实值能保证"万一走到拦截分支"时提示不是假的。
     */
    'ALREADY_ASKED_TEXT',
    'ctx',
    /**
     * ⚠️ **不要**注入 `poller`：`openLogin` 的函数体里自己就有
     * `let poller` 的赋值（它是外层闭包变量但在体内被赋值），
     * 注入同名参数会直接 `SyntaxError: Identifier 'poller' has already been declared`。
     * 这里在重建的**外层**声明一个同名局部即可 ——
     * 副作用是"赋值泄漏出函数"在这条路径上无害（本用例只走早退分支）。
     */
    `
     let poller = null;
     const openLogin = async () => ${`{${openLoginBody()}}`};
     return openLogin;
    `,
  ) as (...args: unknown[]) => () => Promise<void>;

  return {
    run: factory(
      chromeStub,
      controller,
      async () => ({ mid: 1 }),
      () => ({ stop: () => undefined }),
      () => undefined,
      describeOutcome,
      () => false,
      () => undefined,
      () => false,
      () => undefined,
      /**
       * `isOrphanHintShown`（第 9 位）—— 只有一个判断，**只能占一位**。
       *
       * ⚠️ 这里原来连着写了**两个** `() => false`，于是从第 10 位起整体右移：
       * - `loadOnce` 拿到 `() => false`
       * - `shouldSkipRepeatOpen` 拿到 `async () => null` —— 函数对象恒为真
       *   ⇒ 每次点击都被判成「刚点过」，在发消息之前就早退到
       *   `showNotice(ALREADY_ASKED_TEXT, true)`
       * - `ALREADY_ASKED_TEXT` 拿到 `() => false` ⇒ 提示文字是 `undefined`
       *
       * 症状是 `[PROBE] showNotice undefined true` / `expected [] to include 'InPrivate'`
       * —— **看起来像产品坏了，实际是实参多写了一个**。
       */
      () => false,
      /** `loadOnce` —— 异步，返回 `null` 表示"取数失败但别抛" */
      async () => null,
      /** `shouldSkipRepeatOpen` —— 恒 false = 放行，本文件测的是 incognito 那句 */
      () => false,
      ALREADY_ASKED_TEXT,
      {},
    ),
    notices,
  };
}

describe('★★★ incognito-disabled：面板里必须出现可执行提示（task-37 主兜底）', () => {
  it('opened:false + incognito-disabled → controller.showNotice 必须被调用一次，且文案含动作', async () => {
    const p = buildProbe({
      type: 'login/open:ok',
      opened: false,
      reason: 'incognito-disabled',
    });
    await p.run();

    expect(p.notices.length, '权限没开却一条提示都没画 —— 用户看到的就是"点了没反应"').toBe(1);
    const { text } = p.notices[0] ?? { text: '' };
    /** 必须指出**去哪开** */
    expect(text).toContain('InPrivate');
    expect(text).toContain('扩展详情页');
    /** 必须给出**下一步动作** */
    expect(text).toMatch(/打开/);
  });

  it('这条提示是失败色（ok=false，常驻而不是 5 秒消失）', async () => {
    const p = buildProbe({
      type: 'login/open:ok',
      opened: false,
      reason: 'incognito-disabled',
    });
    await p.run();
    expect(p.notices[0]?.ok).toBe(false);
  });

  it('对照：正常打开（opened:true）不许弹这条提示', async () => {
    const p = buildProbe({ type: 'login/open:ok', opened: true, reason: 'assumed' });
    await p.run();
    expect(p.notices.some((n) => n.text.includes('InPrivate'))).toBe(false);
  });
});
