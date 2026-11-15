/**
 * task-42 · E / A：修 A / 修 C + 守卫四形态的运行期探针。
 *
 * ## 为什么要有它
 *
 * task-39 的守卫 `const orphan = typeof chrome === 'undefined' || chrome.runtime?.id == null;`
 * 是**同步**的、在 `openLogin` 第一行。任何"读源码看到 `typeof chrome` 字样"的断言
 * 都证明不了它在运行期真的不抛 —— 这也是 task-34 已经踩过一次的坑：
 * `if (false && isOrphanError(e))` 改完，源码级守卫**全绿**。
 *
 * 这里从 `entrypoints/content-panel.content.ts` 按花括号配平切出 `openLogin`
 * 真跑一遍，只数调用次数。
 *
 * ## 关键：TS 剥离必须跟着源码同步
 *
 * 源码里现在有 `let beforeMid: number | null = null;` —— **变量声明上的类型标注**。
 * 只处理 `(x: T)` 和 `as T` 的正则会在 `new Function` 里抛
 * `SyntaxError: Unexpected token ':'`。这类剥离失败**必须显式报出来**，
 * 不能静默当成"探针没跑成"（那和"守卫坏了"看起来完全一样）。
 *
 * 用法：
 *   node poc/probe/verify-task37-39/repair-and-guard-probe.mjs
 */
import { readFileSync } from 'node:fs';

const PANEL_SRC = 'entrypoints/content-panel.content.ts';

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

export function matchPair(code, from, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < code.length; i += 1) {
    const c = code[i];
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function toJs(body) {
  return body
    .replace(/(\b(?:let|const|var)\s+[A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>[\]\s|&.]*?(?=\s*=)/g, '$1')
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*\)/g, '($1)')
    .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '');
}

export function openLoginBody(src = readFileSync(PANEL_SRC, 'utf8')) {
  const code = stripComments(src);
  const at = code.indexOf('const openLogin = async');
  if (at < 0) throw new Error('找不到 openLogin');
  const start = code.indexOf('{', code.indexOf('=>', at));
  const end = matchPair(code, start, '{', '}');
  if (end < 0) throw new Error('openLogin 花括号不配平');
  return toJs(code.slice(start + 1, end));
}

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
];

/**
 * @param {object} o
 * @param {'ready'|'null'} o.controller
 * @param {'ok'|'chrome-gone'|'runtime-gone'|'id-undefined'|'id-null'} o.chromeShape
 * @param {'ok'|'async-throw'|'sync-throw'} o.send        login/open 应答形态
 * @param {'ok'|'sync-throw'|'async-throw'} o.readMid     readAccountMid 形态
 * @param {boolean} o.hintShown                            isOrphanHintShown() 恒值
 */
export function buildProbe(o = {}) {
  const { controller = 'ready', chromeShape = 'ok', send = 'ok', readMid = 'ok', hintShown = false } = o;
  const c = { hint: 0, notice: 0, clearNotice: 0, sendMessage: 0, readMid: 0, throwOut: null };

  const mkSend = () => {
    if (send === 'sync-throw') {
      return () => {
        c.sendMessage += 1;
        throw new Error('Extension context invalidated.');
      };
    }
    if (send === 'sync-garbage') {
      return () => {
        c.sendMessage += 1;
        throw new Error('boom');
      };
    }
    return async () => {
      c.sendMessage += 1;
      if (send === 'async-throw') throw new Error('Extension context invalidated.');
      if (send === 'async-garbage') throw new Error('boom');
      return { type: 'login/open:ok', opened: true };
    };
  };

  const chromeStub =
    chromeShape === 'chrome-gone'
      ? undefined
      : chromeShape === 'runtime-gone'
        ? { storage: {} }
        : chromeShape === 'id-undefined'
          ? { runtime: { sendMessage: mkSend() } }
          : chromeShape === 'id-null'
            ? { runtime: { id: null, sendMessage: mkSend() } }
            : { runtime: { id: 'live-ext-id', sendMessage: mkSend() } };

  const controllerStub =
    controller === 'null'
      ? null
      : {
          showNotice: () => {
            c.notice += 1;
          },
          clearNotice: () => {
            c.clearNotice += 1;
          },
        };

  const mkReadMid = () => {
    if (readMid === 'sync-throw') {
      return () => {
        c.readMid += 1;
        throw new Error('Extension context invalidated.');
      };
    }
    if (readMid === 'sync-garbage') {
      return () => {
        c.readMid += 1;
        throw new Error('boom');
      };
    }
    return async () => {
      c.readMid += 1;
      if (readMid === 'async-throw') throw new Error('Extension context invalidated.');
      return { mid: 1 };
    };
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
    mkReadMid(),
    () => ({ stop: () => {} }),
    () => undefined,
    () => ({ text: 'stub', ok: true, shouldPoll: false }),
    (e) => /Extension context invalidated|Receiving end does not exist|message port closed/i.test(String(e && e.message)),
    () => {
      c.hint += 1;
    },
    () => hintShown,
  );

  return {
    run: async () => {
      try {
        await fn();
      } catch (e) {
        c.throwOut = String(e && e.message);
      }
      await new Promise((r) => setTimeout(r, 0));
    },
    calls: () => ({ ...c }),
    opts: { controller, chromeShape, send, readMid, hintShown },
  };
}

const CASES = [
  // —— 四形态（+ 反面对照）：孤儿守卫
  ['A1 chrome 整体 undefined', { chromeShape: 'chrome-gone' }],
  ['A2 chrome.runtime 整体 undefined', { chromeShape: 'runtime-gone' }],
  ['A3 runtime 有、id 为 undefined', { chromeShape: 'id-undefined' }],
  ['A4 runtime 有、id 为 null', { chromeShape: 'id-null' }],
  ['A0 反面对照：一切正常', { chromeShape: 'ok', send: 'ok' }],
  // —— 修 A：readAccountMid 同步抛不许中断后续
  ['E-A readAccountMid 同步抛', { readMid: 'sync-throw', send: 'ok' }],
  // —— 修 C：sendMessage 同步抛 / 异步 reject 都要留痕
  ['E-C sendMessage 同步抛', { send: 'sync-throw' }],
  ['E-C sendMessage 异步 reject', { send: 'async-throw' }],
];

if (process.argv[1] && process.argv[1].endsWith('repair-and-guard-probe.mjs')) {
  let body;
  try {
    body = openLoginBody();
  } catch (e) {
    console.log('🔴 切不出 openLogin：', e.message);
    process.exit(2);
  }
  console.log(`openLogin 体长 ${body.length} 字（已剥注释 / 去类型标注）\n`);
  let bad = 0;
  for (const [label, opts] of CASES) {
    let p;
    try {
      p = buildProbe(opts);
    } catch (e) {
      console.log(`🔴 ${label} → 重建失败（TS 剥离不到位？）：${e.message}`);
      bad += 1;
      continue;
    }
    await p.run();
    const r = p.calls();
    console.log(`${label.padEnd(32)} hint=${r.hint} notice=${r.notice} clearNotice=${r.clearNotice} sendMessage=${r.sendMessage} readMid=${r.readMid}${r.throwOut ? ` 🔴throwOut=${r.throwOut}` : ''}`);
  }
  process.exit(bad === 0 ? 0 : 1);
}
