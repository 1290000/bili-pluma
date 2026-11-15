/**
 * task-40 · B 部分：`openLogin` 运行期探针（可复用）。
 *
 * 为什么要它（而不是断言源码里有某个字符串）：
 * task-34 实测 —— 把 `if (isOrphanError(e))` 改成 `if (false && isOrphanError(e))`
 * （`showOrphanHint()` 字样原封不动保留，运行期彻底静默），源码级守卫**全绿**。
 * ⇒ 只有"真的跑一遍、数调用次数"才能杀这类变异。
 *
 * 用法（被 vitest 或别的脚本 import，或直接 node 跑自检）：
 *   import { buildOpenLoginProbe } from './openlogin-probe.mjs';
 *   const p = buildOpenLoginProbe({ controller: 'ready', isOrphanHintShown: false,
 *                                   send: 'throw-orphan', chromeShape: 'ok' });
 *   await p.run();
 *   p.calls();  // => { hint: 0, notice: 1, sendMessage: 0, clearNotice: 1, ... }
 *
 * ## 假绿陷阱（task-35 踩过，本探针专门解决）
 * `openLogin` 里调 `showOrphanHint()` 的有两处：
 *   - catch 分支 `if (isOrphanError(e)) showOrphanHint();`
 *   - 兜底      `if (!isOrphanHintShown() && controller === null) showOrphanHint();`
 * 要构造「**只有主守卫能救**」的场景，必须同时：
 *   - `controller !== null`（否则兜底那行的 `controller === null` 为真，它会替主守卫兜底）
 *   - `isOrphanHintShown()` 恒 `false`（否则 catch 分支也会被跳过 —— 那是另一个方向）
 *   - `sendMessage` **抛孤儿错**（否则根本进不了 catch）
 * 本探针把这三点做成了**默认参数**，并暴露 `onlyGuardCanSave` 让你一眼确认组合对不对。
 */
import { readFileSync } from 'node:fs';

const PANEL_SRC = 'entrypoints/content-panel.content.ts';

/** 字符级剥注释（单条懒匹配正则会被字符串里的 `*／` 提前闭合） */
export function stripComments(s) {
  let out = '';
  let i = 0;
  let quote = null;
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

/** 从 `from` 处的第一个 `{` 起按花括号配平，返回整块（含两端大括号） */
export function braceBlock(code, from) {
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
  throw new Error('花括号不配平 —— 源码结构变了');
}

/** 去掉 TS 标注，得到 `new Function` 能解析的 JS */
export function toJs(body) {
  return body
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*\)/g, '($1)')
    .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '');
}

export function openLoginBody(src = readFileSync(PANEL_SRC, 'utf8')) {
  const code = stripComments(src);
  const at = code.indexOf('const openLogin = async');
  if (at < 0) throw new Error('找不到 openLogin —— 源码结构变了，探针需要同步');
  return toJs(braceBlock(code, code.indexOf('=>', at)).slice(1, -1));
}

/** `openLogin` 体内引用到的自由变量（新增自由变量会让重建抛 ReferenceError —— 那是故意的失败信号） */
const FREE = [
  'chrome',
  'controller',
  'readAccountMid',
  'startLoginPolling',
  'stopPolling',
  'describeLoginOutcome',
  'isOrphanError',
  'showOrphanHint',
  'isOrphanHintShown',
  'isStaleGeneration',
];

/**
 * @param {'ready'|'null'} controller      面板是否活着
 * @param {boolean} isOrphanHintShown      `isOrphanHintShown()` 的返回值（恒定）
 * @param {'throw-orphan'|'throw-garbage'|'ok'} send  sendMessage 行为
 * @param {'ok'|'runtime-gone'|'chrome-gone'} chromeShape  孤儿态的形状（判据 1）
 * @param {boolean|null} staleGen           `isStaleGeneration()` 的返回值（判据 2：true=旧代 / false=当前代 / null=读不出）
 */
export function buildOpenLoginProbe(opts = {}) {
  const {
    controller = 'ready',
    isOrphanHintShown = false,
    send = 'throw-orphan',
    chromeShape = 'ok',
    staleGen = false,
  } = opts;

  const calls = {
    hint: 0,
    notice: 0,
    clearNotice: 0,
    sendMessage: 0,
    stopPolling: 0,
    readAccountMid: 0,
  };
  const asyncErrors = [];

  const sendMessage = async () => {
    calls.sendMessage += 1;
    if (send === 'throw-orphan') throw new Error('Extension context invalidated.');
    if (send === 'throw-garbage') throw new Error('Cannot read properties of undefined (reading \'sendMessage\')');
    return { type: 'login/open:ok', opened: true };
  };

  const chromeStub =
    chromeShape === 'chrome-gone'
      ? undefined
      : chromeShape === 'runtime-gone'
        ? { storage: { local: { get: async () => ({}) } } }
        : { runtime: { id: 'live-ext-id', sendMessage } };

  const controllerStub =
    controller === 'null'
      ? null
      : {
          showNotice: () => {
            calls.notice += 1;
          },
          clearNotice: () => {
            calls.clearNotice += 1;
          },
        };

  const factory = new Function(
    ...FREE,
    `"use strict";
     let poller = null;
     const openLogin = async () => {${openLoginBody()}};
     return openLogin;`,
  );

  const fn = factory(
    chromeStub,
    controllerStub,
    async () => {
      calls.readAccountMid += 1;
      return { mid: 1 };
    },
    () => ({ stop: () => {} }),
    () => {
      calls.stopPolling += 1;
    },
    () => ({ text: 'stub', ok: true, shouldPoll: false }),
    (e) => /Extension context invalidated|Receiving end does not exist|message port closed/i.test(String(e && e.message)),
    () => {
      calls.hint += 1;
    },
    () => isOrphanHintShown,
    () => staleGen,
  );
  void asyncErrors;

  return {
    /** 跑一次 `openLogin`（异步部分等一拍） */
    run: async () => {
      await fn();
      await new Promise((r) => setTimeout(r, 0));
    },
    calls: () => ({ ...calls }),
    /** 三条件是否同时成立 ⇒ 此时 `showOrphanHint` 的调用只可能来自主守卫 */
    onlyGuardCanSave:
      controller !== 'null' &&
      isOrphanHintShown === false &&
      send === 'throw-orphan' &&
      chromeShape === 'ok' &&
      staleGen === false,
    opts,
  };
}

// 直接 `node openlogin-probe.mjs` 时做一次自检：确认探针本身能用
if (process.argv[1] && process.argv[1].endsWith('openlogin-probe.mjs')) {
  const a = buildOpenLoginProbe();
  await a.run();
  console.log('[controller=ready, 恒 false, throw-orphan]', a.calls(), 'onlyGuardCanSave =', a.onlyGuardCanSave);
  const b = buildOpenLoginProbe({ controller: 'null' });
  await b.run();
  console.log('[controller=null, 恒 false, throw-orphan]   ', b.calls(), 'onlyGuardCanSave =', b.onlyGuardCanSave);
  const c = buildOpenLoginProbe({ controller: 'null', send: 'ok' });
  await c.run();
  console.log('[controller=null, send ok]                  ', c.calls(), 'onlyGuardCanSave =', c.onlyGuardCanSave);
  const d = buildOpenLoginProbe({ chromeShape: 'runtime-gone' });
  await d.run();
  console.log('[chrome.runtime 不存在]                     ', d.calls(), 'onlyGuardCanSave =', d.onlyGuardCanSave);
  const e = buildOpenLoginProbe({ chromeShape: 'chrome-gone' });
  await e.run();
  console.log('[chrome 整体不存在]                         ', e.calls(), 'onlyGuardCanSave =', e.onlyGuardCanSave);
  const f = buildOpenLoginProbe({ staleGen: true });
  await f.run();
  console.log('[判据2 gen 不匹配]                          ', f.calls(), 'onlyGuardCanSave =', f.onlyGuardCanSave);
  const g = buildOpenLoginProbe({ staleGen: null });
  await g.run();
  console.log('[判据2 读不出(null) → 按非孤儿]             ', g.calls(), 'onlyGuardCanSave =', g.onlyGuardCanSave);
}
