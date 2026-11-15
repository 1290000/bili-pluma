/**
 * task-40 · B 部分：`chrome.runtime?.id == null` 同步守卫（task-39）的独立复核。
 *
 * 三个必须回答的问题：
 *  1. 真机上 "孤儿态" 是 `chrome.runtime` 变成 undefined，还是整个 `chrome` 没了？
 *     —— 只有知道这个，才谈得上"守卫守的是真机那条路"。
 *  2. 守卫放在入口时，`controller?.clearNotice()` 在它**前面**会不会先抛？
 *     —— 若会抛，用户看到的仍然是"点了没反应"。
 *  3. 守卫失效时，是否存在第二条路径把提示补上（从而让测试假绿）？
 *
 * 用法：node poc/probe/verify-task37-39/probe-orphan-shape.mjs
 */
import { readFileSync } from 'node:fs';

const SRC = readFileSync('entrypoints/content-panel.content.ts', 'utf8');

/** 从 `const openLogin = async` 处按花括号配平切出函数体（剥注释） */
function stripComments(s) {
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

function braceBlock(code, from) {
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

/** 去掉 TS 标注，得到 `new Function` 能解析的 JS */
function toJs(body) {
  return body
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*\)/g, '($1)')
    .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '');
}

function openLoginBody() {
  const code = stripComments(SRC);
  const at = code.indexOf('const openLogin = async');
  if (at < 0) throw new Error('找不到 openLogin —— 源码结构变了，探针需要同步');
  return toJs(braceBlock(code, code.indexOf('=>', at)).slice(1, -1));
}

const BODY = openLoginBody();
const FREE = ['chrome', 'controller', 'readAccountMid', 'startLoginPolling', 'stopPolling', 'describeLoginOutcome', 'isOrphanError', 'showOrphanHint', 'isOrphanHintShown'];

/**
 * 受控环境。`orphanShape` 决定真机的哪种形状：
 *  - 'runtime-gone'：`chrome` 还在，`chrome.runtime` 是 undefined（扩展上下文失效的常见形状）
 *  - 'chrome-gone'：`chrome` 本身 undefined
 *  - 'send-throws'：runtime 还在，`sendMessage` 抛孤儿错（task-33 修的那条）
 */
function run({ orphanShape, controller }) {
  const log = [];
  const chromeStub =
    orphanShape === 'chrome-gone'
      ? undefined
      : orphanShape === 'runtime-gone'
        ? {}
        : {
            runtime: {
              id: 'live-ext',
              sendMessage: async () => {
                throw new Error('Extension context invalidated.');
              },
            },
          };
  const ctrl =
    controller === 'null'
      ? null
      : {
          showNotice: (t, ok) => log.push(`showNotice(${ok})`),
          clearNotice: () => {
            log.push('clearNotice');
            throw new Error('Should not reach clearNotice in a live controller');
          },
        };
  // 真实 controller 的 clearNotice 不抛；这里用一个不抛的版本单独测"顺序"
  const safeCtrl =
    controller === 'null'
      ? null
      : {
          showNotice: (t, ok) => log.push(`showNotice(${ok})`),
          clearNotice: () => log.push('clearNotice'),
        };
  void ctrl;

  const factory = new Function(
    ...FREE,
    `"use strict";
     let poller = null;
     const openLogin = async () => {${BODY}};
     return openLogin;`,
  );
  const fn = factory(
    chromeStub,
    safeCtrl,
    async () => ({ mid: 1 }),
    () => ({ stop: () => log.push('stopPolling') }),
    () => log.push('stopPolling()'),
    () => ({ text: 'stub', ok: true, shouldPoll: false }),
    (e) => /Extension context invalidated/i.test(String(e && e.message)),
    () => log.push('showOrphanHint'),
    () => false,
  );
  let threw = null;
  try {
    // 直调：`poller` 在函数体里自带声明，这里同步部分即可暴露顺序问题
    const p = fn();
    if (p && typeof p.then === 'function') p.catch((e) => (threw = e));
  } catch (e) {
    threw = e;
  }
  return { log, threw };
}

for (const shape of ['runtime-gone', 'chrome-gone', 'send-throws']) {
  const r = run({ orphanShape: shape, controller: 'null' });
  console.log(`[${shape}] 同步调用记录 =`, JSON.stringify(r.log), '| 同步抛出 =', r.threw ? String(r.threw.message) : 'null');
}
const r2 = run({ orphanShape: 'send-throws', controller: 'ready' });
console.log('[send-throws + controller 可用] 记录 =', JSON.stringify(r2.log));
