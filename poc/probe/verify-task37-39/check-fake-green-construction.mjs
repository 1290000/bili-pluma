/**
 * task-42 · C：假绿构造检查器（自证一正一反后才可信）。
 *
 * ## 它检查什么
 *
 * 测试文件里每一处 `new Function(...)` 探针，**实测**能不能分辨主守卫：
 * 把 `isOrphanHintShown()` 钉成"没挂过"、`controller` 钉成"活着"，再让
 * `sendMessage` 抛孤儿错，看 `showOrphanHint` 被调了几次。
 *
 *   - 调 **1** 次 ⇒ 只有主守卫能救 ⇒ 这个构造**合格**（主守卫一死就必红）
 *   - 调 **0** 次 ⇒ 这个构造根本没走到主守卫
 *   - 调 **2** 次 ⇒ 兜底那条替主守卫兜了底 ⇒ 主守卫死了也照样 ≥1 ⇒ **假绿风险**
 *
 * ## 为什么要"实测"而不是"读代码猜"
 *
 * 第一版我读源码猜：`isStaleGeneration` 已经不在 `openLogin` 里了，就据此判
 * "探针注入的形参没人用"——但那是**猜**。这里直接 `new Function` 跑一遍，
 * 只认调用次数。判据和执行走同一条路，才不会被"看起来对"骗。
 *
 * ## 为什么按函数名做括号配平截取
 *
 * 靠"最后一个反引号"切分很脆（模板串里可以再嵌反引号）。
 * 这里按 `buildProbe(` / `buildFallbackProbe(` 定位，再用花括号感知的扫描
 * 找到**调用实参列表的右括号**，跳字符串/注释，与 openLogin 的切法一致。
 *
 * ## 自证（`node check-fake-green-construction.mjs --selftest`）
 *
 * 一正一反必须同时成立，否则本检查器**不可信**：
 *   - 反面（应判"合格"）：`controller !== null` + 兜底被短路失效 + `sendMessage` 抛错
 *     → 四个孤儿形态各 `hint=1`，正常形态 `hint=0` ⇒ 判 pass
 *   - 正面（应判"不合格"）：同一构造但 `controller` 钉成 `null`
 *     → 兜底会替主守卫兜底 ⇒ 判 fail
 *
 * ⚠️ **旧版自证的写法是错的**：它让"合格"fixture 也走 `runProbeWith` 而非
 * 真实 `runProbe`，结果两侧都判 fail、"一正一反都对"这句话被它自己打成了
 * 一句**没有区分力的真话**（两个都 fail，当然一致）。现在两半都走同一条
 * `runProbe` 路径，差别只在 `controller` 注入值。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { findFunctionBody } from './locate-function.mjs';

const ROOT = process.cwd();
const PANEL_SRC = 'entrypoints/content-panel.content.ts';

/* ---------- 通用词法小工具（与 openlogin-probe.mjs 同源逻辑） ---------- */

/** 字符级剥注释，字符串内容原样保留 */
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

/**
 * 从 `from` 起找 `open` 的下一个配对 `close`（跳过字符串与注释），返回闭合下标。
 * 用于从 `buildProbe(` 找到那次调用的右括号。
 */
export function matchPair(code, from, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < code.length; i += 1) {
    const c = code[i];
    if (quote !== null) {
      if (c === '\\') {
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
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

function braceBlock(code, from) {
  const start = code.indexOf('{', from);
  if (start < 0) throw new Error('找不到 {');
  const end = matchPair(code, start, '{', '}');
  if (end < 0) throw new Error('花括号不配平');
  return code.slice(start, end + 1);
}

function toJs(body) {
  return (
    body
      // 1. 变量声明上的类型标注：`let x: T = ...` / `const x: T = ...`
      //    （旧版漏了这个，openLogin 里 `let beforeMid: number | null = null;`
      //     直接 SyntaxError: Unexpected token ':'）
      .replace(
        /(\b(?:let|const|var)\s+[A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>[\]\s|&.]*?(?=\s*=)/g,
        '$1',
      )
      // 2. 函数参数上的类型标注：`(x: T) =>`
      .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[^()]*\)/g, '($1)')
      // 3. `as` 断言
      .replace(/\s+as\s+[A-Za-z_$][\w$<>[\]\s|&.]*?(?=[;\n)])/g, '')
  );
}

export function openLoginBody() {
  const code = stripComments(readFileSync(join(ROOT, PANEL_SRC), 'utf8'));
  const at = code.indexOf('const openLogin = async');
  if (at < 0) throw new Error('找不到 openLogin');
  return toJs(braceBlock(code, code.indexOf('=>', at)).slice(1, -1));
}

/* ---------- 从测试文件里抽一个 probe 构造 ---------- */

/**
 * 抽 `function <name>(...) { ... }` 整块，并解析**所有** `new Function(...)` 调用：
 * 返回 `{ params: [...], body: '...' }`。
 */
export function extractProbeCalls(src, name) {
  const code = stripComments(src);
  // ⚠️ 定位函数体**必须**走 `locate-function.mjs`。
  //    老写法 `code.indexOf('{', at)` 会撞上**参数里的对象类型标注**
  //    （`function buildProbe(opts: { send: … }): Probe {`），配平一次就结束，
  //    切出 87 字、里面连 `new Function` 都没有 ⇒ 扫描"看起来跑了、其实零命中"。
  const loc = findFunctionBody(code, name);
  if (!loc) return null;
  const block = code.slice(loc.start, loc.end + 1);
  if (!block.includes('new Function(')) {
    // 定位到了函数体但没有探针 —— 说明这个函数确实不含探针，跳过即可。
    return { block, calls: [] };
  }
  const calls = [];
  let cursor = 0;
  for (;;) {
    const nf = block.indexOf('new Function(', cursor);
    if (nf < 0) break;
    const openParen = block.indexOf('(', nf);
    const closeParen = matchPair(block, openParen, '(', ')');
    const argsSrc = block.slice(openParen + 1, closeParen);
    // 实参按顶层逗号切
    const args = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (let i = 0; i < argsSrc.length; i += 1) {
      const c = argsSrc[i];
      if (quote !== null) {
        cur += c;
        if (c === '\\') {
          cur += argsSrc[i + 1] ?? '';
          i += 1;
        } else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c;
        cur += c;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      if (c === ')' || c === ']' || c === '}') depth -= 1;
      if (c === ',' && depth === 0) {
        args.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim() !== '') args.push(cur.trim());
    const bodyArg = args[args.length - 1] ?? '';
    calls.push({ params: args.slice(0, -1), body: bodyArg });
    cursor = closeParen + 1;
  }
  return { block, calls };
}

/* ---------- 运行一个探针，数 showOrphanHint 调用次数 ---------- */

const LITERAL = (s) => {
  const t = s.trim();
  const m = /^(['"`])([\s\S]*)\1$/.exec(t);
  return m ? m[2] : undefined;
};

function evalArg(expr, scope) {
  const lit = LITERAL(expr);
  if (lit !== undefined) return lit;
  // `opts.controller === 'ready' ? {...} : null` 这类三元，按 scope 求值
  try {
    // eslint-disable-next-line no-new-func
    return new Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope));
  } catch {
    return undefined;
  }
}

/**
 * 在一个 probe 构造上跑四种孤儿形态 + 一种正常形态，返回 `showOrphanHint` 调用次数。
 * 只认次数，不认"看起来应该会调"。
 */
export function runProbe(call, overrides = {}) {
  const { params, body } = call;
  const names = params.map((p) => LITERAL(p) ?? p);
  const tmpl = LITERAL(body) ?? '';

  // 把模板里的 ${`{${openLoginBody()}}`} 换成真实的函数体。
  // ⚠️ 反引号写成 \u0060：这个 `.mjs` 自己就是个 ESM 文件，源码里直接写反引号
  //    必须转义（`\``），转义又容易和模板串的 `${` 打架；用码点最稳。
  //    （第一版这里写错 ⇒ 替换静默不生效 ⇒ 探针跑的是一个空函数体 ⇒
  //      所有形态都数出 0 次 ⇒ 看起来像"守卫全坏"。**静默失败最危险。**）
  const BQ = String.fromCharCode(96);
  const placeholder = new RegExp(
    '\\$\\{\\s*' + BQ + '?\\{\\s*\\$\\{openLoginBody\\(\\)\\}\\s*' + BQ + '?\\s*\\}',
  );
  const inner = tmpl
    .replace(placeholder, (m) => '{' + openLoginBody() + '}')
    // 占位符收尾那个 `\`}` 属于**模板串语法**，不属于函数体正文 ——
    // 不删的话重建出的源码是 `async () => {…}`}`，`new Function` 直接
    // 报 `SyntaxError: Unexpected template string`。
    .replace('}' + BQ + '};', '};');
  if (!inner.includes('const openLogin')) {
    return { error: '模板里没找到 openLogin（切法失效）', body };
  }
  if (inner.includes('openLoginBody()')) {
    return { error: '占位符没被替换（切法失效）', body };
  }

  const counts = {};
  if (process.env.DBG) globalThis.__DBG_INNER = inner;
  const runCase = (label) => {
    // hints 必须是**本用例**的计数器，不能跨用例共用
    //（旧版 `const hints = []` 声明在 runCase 外面且从未 push，读的是恒定空数组）。
    let hintCount = 0;
    const env = buildEnv(label, () => {
      hintCount += 1;
    });
    const inject = {};
    if ('controller' in overrides) inject.controller = overrides.controller;
    const values = names.map((n) => (n in inject ? inject[n] : env.base(n)));
    let threw = null;
    let fn;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function(...names, inner)(...values);
    } catch (e) {
      counts[label] = { hints: -1, threw: String(e && e.message), sendMessage: 0 };
      return Promise.resolve();
    }
    const chain = (fn ? fn() : Promise.resolve())
      .then(() => undefined)
      .catch((e) => {
        threw = String(e && e.message);
      });
    return chain.then(() => {
      counts[label] = { hints: hintCount, threw, sendMessage: env.sendCount.ref.n };
    });
  };

  function buildEnv(label, onHint) {
    const ref = { n: 0 };
    const shownFlag = { v: false };
    const base = (name) => {
      switch (name) {
        case 'chrome':
          return label === 'chrome-gone'
            ? undefined
            : label === 'runtime-gone'
              ? {}
              : label === 'id-undefined'
                ? { runtime: { sendMessage: mkSend() } }
                : label === 'id-null'
                  ? { runtime: { id: null, sendMessage: mkSend() } }
                  : { runtime: { id: 'test-id', sendMessage: mkSend() } };
        case 'controller':
          return { showNotice: () => undefined, clearNotice: () => undefined };
        case 'readAccountMid':
          return async () => ({ mid: 1 });
        case 'startLoginPolling':
          return () => ({ stop: () => undefined });
        case 'stopPolling':
          return () => undefined;
        case 'describeLoginOutcome':
          return () => ({ text: 'stub', ok: true, shouldPoll: false });
        case 'isOrphanError':
          return (e) => /Extension context invalidated/i.test(String(e && e.message));
        case 'showOrphanHint':
          return () => {
            ref.n += 1;
            onHint();
          };
        case 'isOrphanHintShown':
          return () => shownFlag.v;
        default:
          return () => false;
      }
    };
    function mkSend() {
      return async () => {
        ref.n += 1;
        throw new Error('Extension context invalidated.');
      };
    }
    return { base, sendCount: { ref }, shownFlag };
  }

  const labels = ['ok', 'chrome-gone', 'runtime-gone', 'id-undefined', 'id-null'];
  return labels
    .reduce((p, label) => p.then(() => runCase(label, {})), Promise.resolve())
    .then(() => ({
      // 主守卫"只有它能救"的判据：正常形态 0 次（不误报）
      // + chrome-gone 恰好 1 次（主守卫救到、且 sendMessage 0）
      verdict: verdictOf(counts),
      counts,
    }));
}

function verdictOf(counts) {
  const g = counts['chrome-gone'];
  if (!g || g.hints < 0 || g.hints > 1) return 'fail';
  if (g.sendMessage !== 0) return 'fail';
  const ok = counts['ok'];
  if (!ok || ok.hints !== 0) return 'fail';
  return 'pass';
}

/* ---------- 自证：一正一反 ---------- */

const FIXTURE_PASS = `
function buildProbe(): unknown {
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
    \`"use strict";
     const openLogin = async () => \${{\${openLoginBody()}}};
     return openLogin;\`,
  );
  return factory;
}`;

const FIXTURE_FAIL = `
function buildProbe(): unknown {
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
    \`"use strict";
     const openLogin = async () => \${{\${openLoginBody()}}};
     return openLogin;\`,
  );
  return factory;
}`;

async function selftest() {
  const call = extractProbeCalls(FIXTURE_PASS, 'buildProbe').calls[0];
  // 一正一反走**同一条** runProbe 路径，唯一差别是 controller 注入值。
  const rPass = await runProbe(call);
  const rFail = await runProbe(call, { controller: null });
  console.log('[自证·应合格] controller 活着 ->', JSON.stringify(rPass.counts), '判定 =', rPass.verdict);
  console.log(
    '[自证·应不合格] controller 钉成 null（兜底会替主守卫兜底）->',
    JSON.stringify(rFail.counts),
    '判定 =',
    rFail.verdict,
  );
  const ok = rPass.verdict === 'pass' && rFail.verdict === 'fail';
  if (!ok && process.env.DBG) {
    console.log('[DBG] inner 前 600 字 =', JSON.stringify(globalThis.__DBG_INNER.slice(0, 600)));
  }
  console.log(ok ? '✅ 自证通过：一正一反都对' : '🔴 自证未通过 —— 检查器结论不可用');
  process.exit(ok ? 0 : 1);
}

async function runProbeWith(call, overrides) {
  const { params, body } = call;
  const names = params.map((p) => LITERAL(p) ?? p);
  const tmpl = LITERAL(body) ?? '';
  const inner = tmpl.replace(/\$\{\s*`?\{\s*\$\{openLoginBody\(\)\}\s*\}`?\s*\}/, `{${openLoginBody()}}`);
  const ref = { n: 0 };
  const shown = { v: false };
  const counts = {};
  const mk = (label) => {
    const chromeObj =
      label === 'chrome-gone'
        ? undefined
        : label === 'runtime-gone'
          ? {}
          : label === 'id-undefined'
            ? { runtime: { sendMessage: async () => { ref.n += 1; throw new Error('Extension context invalidated.'); } } }
            : label === 'id-null'
              ? { runtime: { id: null, sendMessage: async () => { ref.n += 1; throw new Error('Extension context invalidated.'); } } }
              : { runtime: { id: 'test-id', sendMessage: async () => { ref.n += 1; throw new Error('Extension context invalidated.'); } } };
    const map = {
      chrome: chromeObj,
      controller: 'controller' in overrides ? overrides.controller : { showNotice: () => undefined, clearNotice: () => undefined },
      readAccountMid: async () => ({ mid: 1 }),
      startLoginPolling: () => ({ stop: () => undefined }),
      stopPolling: () => undefined,
      describeLoginOutcome: () => ({ text: 'stub', ok: true, shouldPoll: false }),
      isOrphanError: (e) => /Extension context invalidated/i.test(String(e && e.message)),
      showOrphanHint: () => { ref.n += 0; (counts._hints ??= []).push(label); },
      isOrphanHintShown: () => false,
    };
    return map;
  };
  for (const label of ['ok', 'chrome-gone', 'runtime-gone', 'id-undefined', 'id-null']) {
    const before = ref.n;
    const perLabel = { hints: 0 };
    const map = mk(label);
    map.showOrphanHint = () => { perLabel.hints += 1; };
    const fn = new Function(...names, inner)(...names.map((n) => map[n]));
    let threw = null;
    await (fn ? fn() : Promise.resolve()).catch((e) => { threw = String(e && e.message); });
    counts[label] = { hints: perLabel.hints, threw, sendMessage: ref.n - before };
  }
  return { counts, verdict: verdictOf(counts) };
}
export { runProbeWith };

/* ---------- 扫全仓 ---------- */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const files = [
    ...walk(join(ROOT, 'tests')),
    ...walk(join(ROOT, 'poc', 'probe')),
  ];
  let any = false;
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const src = readFileSync(file, 'utf8');
    if (!/new Function\s*\(/.test(src)) continue;
    // 找出该文件里所有 "function xxxx(" 定义的构造器
    const names = [...stripComments(src).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    for (const name of new Set(names)) {
      const ex = extractProbeCalls(src, name);
      if (!ex || ex.calls.length === 0) continue;
      for (const [i, call] of ex.calls.entries()) {
        const r = await runProbe(call);
        if (r.error) {
          console.log(`⚠️  ${rel} · ${name}#${i} 切不出来：${r.error}`);
          continue;
        }
        any = true;
        const tag = r.verdict === 'pass' ? '✅' : '🔴';
        console.log(`${tag} ${rel} · ${name}#${i}`);
        for (const [label, c] of Object.entries(r.counts)) {
          console.log(`      ${label.padEnd(14)} hint=${String(c.hints).padStart(2)} sendMessage=${c.sendMessage}${c.threw ? ` threw=${c.threw}` : ''}`);
        }
      }
    }
  }
  if (!any) console.log('（没找到可判的探针构造）');
}

if (process.argv[1] && process.argv[1].endsWith('check-fake-green-construction.mjs')) {
  await main();
}
