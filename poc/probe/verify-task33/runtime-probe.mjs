/**
 * task-34 判据 A/B 的**运行期**探针：不读源码文本，真的把 `openLogin` 的调用点跑起来。
 *
 * 做法：从 `entrypoints/content-panel.content.ts` 里按花括号配平切出 `openLogin`
 * 的函数体源码 → `new Function` 重新构造 → 注入 fake `chrome` / `controller` / 依赖。
 * 这样测到的是"源码实际执行时会不会调 showOrphanHint"，而不是"源码里有没有这句"。
 *
 * 为什么必须这么做：engineer 的 13 条守卫里大多只做 `toContain` / `toMatch` 源码形状
 * 断言，只有少数真的碰了 DOM —— 而用户的症状恰恰是"运行期静默"。形状对 ≠ 用户看得见。
 */
import { readFileSync } from 'node:fs';

const SRC = readFileSync('entrypoints/content-panel.content.ts', 'utf8');

function braceBlock(s, from) {
  const open = s.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(open + 1, i);
    }
  }
  return '';
}

function openLoginBody() {
  const at = SRC.indexOf('const openLogin = async');
  if (at < 0) throw new Error('找不到 openLogin');
  return braceBlock(SRC, SRC.indexOf('=>', at));
}

function makeEnv(opts) {
  const { throwOrphan = true, controller = null } = opts ?? {};
  const appended = [];
  const doc = {
    body: { appendChild: (n) => (appended.push(n), n) },
    documentElement: { appendChild: (n) => (appended.push(n), n) },
    getElementById: () => null,
    createElement: () => ({
      style: { cssText: '' },
      attachShadow: () => ({ appendChild: () => undefined }),
      appendChild: () => undefined,
      addEventListener: () => undefined,
    }),
    querySelector: () => null,
  };
  const chromeStub = {
    runtime: {
      sendMessage: async () => {
        if (throwOrphan) throw new Error('Extension context invalidated.');
        return { type: 'account/summary:ok', account: null };
      },
    },
  };
  const calls = [];
  const hooks = {
    showOrphanHint: () => calls.push('showOrphanHint'),
    isOrphanHintShown: () => false,
    isOrphanError: (e) =>
      /Extension context invalidated|Receiving end does not exist|message port closed/i.test(
        String((e && e.message) || e || ''),
      ),
    describeLoginOutcome: () => ({ ok: false, text: '登录窗口打不开，请重试', shouldPoll: false }),
    startLoginPolling: () => ({}),
  };
  return { appended, doc, chromeStub, calls, hooks, controller };
}

async function runOpenLogin(body, env) {
  let controller = env.controller;
  const fn = new Function(
    'chrome',
    'document',
    'getController',
    'showOrphanHint',
    'isOrphanHintShown',
    'isOrphanError',
    'describeLoginOutcome',
    'startLoginPolling',
    'readAccountMid',
    'stopPolling',
    `return (async () => { ${body} })();`,
  );
  const readAccountMid = async () => ({ mid: null });
  await fn(
    env.chromeStub,
    env.doc,
    () => controller,
    env.hooks.showOrphanHint,
    env.hooks.isOrphanHintShown,
    env.hooks.isOrphanError,
    env.hooks.describeLoginOutcome,
    env.hooks.startLoginPolling,
    readAccountMid,
    () => undefined,
  );
  return env.calls;
}

function rewriteController(body) {
  return body
    .replace(/(?<![\w.$])controller(?![\w$])/g, 'getController()')
    // TS 注解：`(e: unknown) =>` / `(x: T)` —— new Function 里只能是 JS
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$.<>[\]|\s]*\)\s*=>/g, '($1) =>')
    // TS `as` 断言：`… as LoginOpenReply | null` → 去掉（只处理行尾那一种）
    .replace(/\s+as\s+[A-Za-z_$][\w$.<>[\]|\s]*(?=\s*[;,)\n])/g, '');
}

const body = rewriteController(openLoginBody());
console.log('切片长度（重写 controller 后）', body.length);
console.log('切片里含 shouldPoll 早退：', body.includes('!r.shouldPoll'));

{
  const env = makeEnv({ throwOrphan: true, controller: null });
  const calls = await runOpenLogin(body, env);
  console.log('\n[判据B] controller===null + 抛孤儿态 → 调用记录：', JSON.stringify(calls));
  console.log('[判据B] 结论：', calls.includes('showOrphanHint') ? '有提示 ✅' : '静默 ❌');
}

{
  const env = makeEnv({ throwOrphan: true, controller: { clearNotice() {}, showNotice() {} } });
  const calls = await runOpenLogin(body, env);
  console.log('\n[判据A] controller 存在 + 抛孤儿态 → 调用记录：', JSON.stringify(calls));
  console.log('[判据A] 结论：', calls.includes('showOrphanHint') ? '有提示 ✅' : '静默 ❌');
}

{
  const env = makeEnv({ throwOrphan: false, controller: { clearNotice() {}, showNotice() {} } });
  const calls = await runOpenLogin(body, env);
  console.log('\n[判据D] 正常返回 → 调用记录：', JSON.stringify(calls));
  console.log('[判据D] 结论：', calls.includes('showOrphanHint') ? '误报 ❌' : '不误报 ✅');
}
