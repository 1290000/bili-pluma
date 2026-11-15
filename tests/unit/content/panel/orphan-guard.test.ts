// @vitest-environment jsdom
/**
 * 孤儿守卫的**四形态**运行期验证（task-39 → task-41-B）。
 *
 * ## 为什么是运行期探针，不是源码形状断言
 *
 * 源码里出现 `chrome.runtime?.id` 这几个字**不等于**它会守住任何东西。
 * task-35 已经踩过一次：把条件改成 `if (false && isOrphanError(e))`，
 * 13 条形状断言全绿。所以这里把 `openLogin` 的函数体切出来，
 * 用 `new Function` 重建，把 `chrome` / `controller` 全换成受控替身，**真跑**。
 *
 * ## 四种形态（Lead 定死的覆盖）
 *
 * 1. `chrome` 整体 undefined        —— `?.` 管不到，会抛 `reading 'runtime'`
 * 2. `chrome.runtime` 整体 undefined
 * 3. `chrome.runtime` 是对象、`id` 为 undefined
 * 4. `chrome.runtime` 是对象、`id` 为 null
 *
 * 四者都要求：**不许抛**、`showOrphanHint()` 恰好 1 次、`sendMessage` **0 次**
 * （消息根本没该发出去）。
 *
 * ## 假绿构造条件（verifier 给的，缺一条就测不到主守卫）
 *
 * 测主守卫时必须**同时**满足：`sendMessage` 抛孤儿错 ∧ **`controller !== null`**
 * ∧ `isOrphanHintShown()` 恒 false。
 * 若 `controller === null`，`:322` 那条与孤儿无关的兜底会替它把提示挂出来，
 * 主守卫改成恒 false 也照样绿 —— 这正是 task-35 那个坑的翻版。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOrphanError } from '@/src/content/panel/orphan-hint';

const SRC = readFileSync(resolve('entrypoints/content-panel.content.ts'), 'utf8');

/** 状态机剥注释（正则版会被字符串里的「星号斜杠」跨块吞掉，task-22 踩过） */
function stripComments(code: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'str' = 'code';
  let quote = '';
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
      if (c === '"' || c === "'" || c === String.fromCharCode(96)) {
        mode = 'str';
        quote = c;
      }
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
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    // str
    if (c === '\\') {
      out += c + n;
      i += 2;
      continue;
    }
    if (c === quote) mode = 'code';
    out += c;
    i += 1;
  }
  return out;
}

/** 从 `from`（必须指向左花括号）起配平到对应的右花括号，返回含两端的内容 */
function braceBlock(code: string, from: number): string {
  expect(code[from], '配平起点必须是 {').toBe('{');
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const c = code[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(from, i + 1);
    }
  }
  throw new Error('花括号不配平');
}

/** 去掉 TS 类型标注，得到 `new Function` 能解析的 JS */
function toJs(body: string): string {
  return (
    body
      /**
       * ⚠️ 顺序很重要：
       * 1. 先去掉 `as X`（否则 `as { a: string }` 里的冒号会被后面当成"变量类型标注"）；
       * 2. 再去掉 `let/const x: T =`（**变量**声明，不是函数参数）；
       * 3. 再去掉箭头回调 `(e: unknown) =>`；
       * 4. 最后去掉普通函数参数 `(a: T)`（排除箭头，否则对象字面量会被误伤）。
       * 顺序错一步就会漏掉一种写法 —— 实测漏过 `let res: LoginOpenReply | null = null;`。
       */
      .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '')
      .replace(/\b(let|const|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, '$1 $2 =')
      /**
       * 3. 空参数列表的**返回类型**标注：`(): boolean =>` → `() =>`
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
  expect(at, '找不到 openLogin（改名了？本文件要跟着改）').toBeGreaterThan(-1);
  const block = braceBlock(code, code.indexOf('{', code.indexOf('=>', at) + 2));
  return toJs(block.slice(1, -1));
}

type Probe = {
  /** `showOrphanHint` 被调用几次 */
  hints: () => number;
  /** `controller.showNotice` 被调用几次 */
  notices: () => number;
  /** `chrome.runtime.sendMessage` 被调用几次 */
  sends: () => number;
  run: () => Promise<void>;
};

/** 四种形态 + 「正常活着」对照 */
type ChromeForm = 'no-chrome' | 'no-runtime' | 'no-id' | 'null-id' | 'alive';

function makeChrome(form: ChromeForm, spies: { sends: number; throwSync: boolean }): unknown {
  if (form === 'no-chrome') return undefined;
  const sendMessage = (): Promise<unknown> => {
    spies.sends += 1;
    if (spies.throwSync) throw new Error('Extension context invalidated.');
    return Promise.resolve({ type: 'login/open:ok', opened: true });
  };
  if (form === 'no-runtime') return {};
  if (form === 'no-id') return { runtime: { sendMessage } };
  if (form === 'null-id') return { runtime: { id: null, sendMessage } };
  return { runtime: { id: 'test-extension-id', sendMessage } };
}

/**
 * 跑一次 `openLogin`。
 *
 * @param opts.chrome 受控 `chrome`
 * @param opts.controller `'ready'` = 面板还活着（**测主守卫时必须是它**：见文件头假绿条件）
 */
function buildProbe(opts: { chrome: unknown; controller: 'ready' | 'null' }): Probe {
  let hints = 0;
  let notices = 0;
  const controllerStub =
    opts.controller === 'ready'
      ? {
          showNotice: (): void => {
            notices += 1;
          },
          clearNotice: (): void => undefined,
        }
      : null;

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
    'ctx',
    /**
     * task-44 新增：`openLogin` 现在第一段就调 `shouldSkipRepeatOpen()`（面板侧重复点击记忆）。
     * 不注入就是 `ReferenceError: shouldSkipRepeatOpen is not defined`（实测）。
     *
     * ⚠️ 这里注入**常量 false**，不是因为"图省事"：本文件测的是**孤儿守卫**，
     * 重复点击那条路与它正交。写 false 等于"这个 tab 上还没记住任何人"，
     * 正是孤儿守卫最该被考验的场景（用户第一次点就撞上孤儿态）。
     * 那条判据本身的真假由 `assumed-repeat-guard.test.ts` 用**源码切片**守（不复述判据）。
     */
    'shouldSkipRepeatOpen',
    // `poller` 只能在重建的外层声明：函数体里自己有 `poller =` 赋值，
    // 当参数注入会 `SyntaxError: Identifier 'poller' has already been declared`。
    `
     let poller = null;
     const openLogin = async () => ${`{${openLoginBody()}}`};
     return openLogin;
    `,
  ) as (...args: unknown[]) => () => Promise<void>;

  const run = factory(
    opts.chrome,
    controllerStub,
    async () => ({ mid: 1 }),
    () => ({ stop: () => undefined }),
    () => undefined,
    () => ({ text: 'stub', ok: true, shouldPoll: false }),
    isOrphanError,
    () => {
      hints += 1;
    },
    () => false,
    async () => null,
    {},
    () => false,
  );

  return {
    hints: () => hints,
    notices: () => notices,
    sends: () => 0,
    run,
  };
}

/**
 * 与 `buildProbe` 同构，但额外暴露 `sendMessage` 调用次数。
 *
 * 为什么要单独一个：`buildProbe` 已经重建了闭包，计数只能在外面数，
 * 所以这里把计数器注入 `chrome` 替身（见 `makeChrome` 的 `spies`）。
 */
function buildCountProbe(
  form: ChromeForm,
  opts: { throwSync?: boolean; controller?: 'ready' | 'null' } = {},
): Probe & { sent: () => number } {
  const spies = { sends: 0, throwSync: opts.throwSync === true };
  const p = buildProbe({ chrome: makeChrome(form, spies), controller: opts.controller ?? 'ready' });
  return { ...p, sent: () => spies.sends };
}

describe('★★★★ 孤儿守卫：四形态同步拦截（task-41-B）', () => {
  /**
   * 四形态逐个验。**`controller: 'ready'` 是刻意的** ——
   * 若用 `'null'`，:322 那条兜底会把提示挂出来，
   * 守卫改成恒 false 也照样绿（假绿）。这里是主守卫唯一能自证的地方。
   */
  const forms: { form: ChromeForm; label: string }[] = [
    { form: 'no-chrome', label: 'chrome 整体 undefined' },
    { form: 'no-runtime', label: 'chrome.runtime 整体 undefined' },
    { form: 'no-id', label: 'runtime 是对象但 id 为 undefined' },
    { form: 'null-id', label: 'runtime 是对象但 id 为 null' },
  ];

  for (const { form, label } of forms) {
    it(`★★★ ${label} → 不抛、提示恰好 1 次、消息一条都不许发`, async () => {
      const p = buildCountProbe(form);
      // 关键：不许抛。`chrome` 整体 undefined 时 `chrome.runtime?.id` 会同步抛
      // `TypeError: Cannot read properties of undefined (reading 'runtime')`，
      // 而那个异常本身就是用户看到的"点了完全没反应"。
      await expect(p.run(), `守卫在自己那行就抛了 —— 提示永远轮不到`).resolves.toBeUndefined();
      expect(p.hints(), '孤儿态必须挂出「请刷新」提示').toBe(1);
      expect(p.sent(), '上下文已失效，消息根本不该发出去').toBe(0);
      /** 孤儿提示已经挂了，不许再叠一条面板红字 */
      expect(p.notices()).toBe(0);
    });
  }

  it('★★ 对照：扩展活着（runtime.id 非空）→ 守卫不许误伤，消息照发、不挂孤儿提示', async () => {
    const p = buildCountProbe('alive');
    await p.run();
    expect(p.hints(), '正常态误报「请刷新」比漏报更糟').toBe(0);
    expect(p.sent()).toBe(1);
  });

  it('★★ runtime 在但 id 缺失 + controller 为 null → 仍然只提示一次（两条路径不许叠加）', async () => {
    const p = buildCountProbe('no-id', { controller: 'null' });
    await p.run();
    expect(p.hints()).toBe(1);
    expect(p.sent()).toBe(0);
  });
});

describe('★★★ 修 A / 修 C：同步抛也必须被兜住（task-41）', () => {
  /**
   * ## 修 A 已作废（task-41，investigator 拆产物确认）
   *
   * 原本要防"`readAccountMid()` 同步抛"。产物显示它**不可能抛**：
   * 内部自带 `.catch`、调用侧再挂一层 `.catch`，且整个表达式是**内联在
   * `let` 初始化式里**直接调用的 —— 没有"先拿到句柄再挂 catch"的窗口。
   * 所以这里不再为它写用例（写了也只会测到"不可能发生的事"）。
   *
   * **真正的洞在 `sendMessage` 那一句**，见下面那条。
   */
  /**
   * 修 C：`sendMessage` **同步抛** —— 旧写法 `.catch(() => null)` 一次都不会跑，
   * 于是 `describeLoginOutcome(null)` 都轮不到，点击彻底静默。
   * 构造：过了守卫（alive）但 sendMessage 同步抛孤儿错 ⇒ 必须挂孤儿提示。
   */
  it('★★ sendMessage 同步抛孤儿错 → 必须挂孤儿提示（.catch 接不住这一半）', async () => {
    const spies = { sends: 0, throwSync: true };
    const hints = { n: 0 };
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
      'ctx',
      'shouldSkipRepeatOpen',
      `
       let poller = null;
       const openLogin = async () => ${`{${openLoginBody()}}`};
       return openLogin;
      `,
    ) as (...args: unknown[]) => () => Promise<void>;
    const openLogin = factory(
      makeChrome('alive', spies),
      {
        showNotice: (): void => undefined,
        clearNotice: (): void => undefined,
      },
      async () => ({ mid: 1 }),
      () => ({ stop: () => undefined }),
      () => undefined,
      () => ({ text: 'stub', ok: true, shouldPoll: false }),
      isOrphanError,
      () => {
        hints.n += 1;
      },
      /** 恒 false：不许让 `:322` 的兜底替修 C 把提示挂出来 */
      () => false,
      async () => null,
      {},
      /** task-44：重复点击记忆**必须放行**，否则本用例测不到 sendMessage 那一层 */
      () => false,
    );

    await expect(openLogin(), '同步抛冲出了 openLogin').resolves.toBeUndefined();
    expect(hints.n, '同步抛 + controller 可用 ⇒ 只有 catch 能救，它没跑').toBeGreaterThanOrEqual(1);
  });
});
