/**
 * 被注入探针环境里的 `isOrphanHintShown()` 用哪个值？
 *
 * 在 `runProbe` 里，`showOrphanHint` / `isOrphanHintShown` 是我自己造的替身，
 * 探针构造**注入什么**都会被覆盖（这正是它作为"运行期验证"的强项）。
 * 但"假绿构造检查"问的是**测试自己**有没有构造出「只有主守卫能救」的场景 ——
 * 那是通过 `new Function(...)(实参…)` 传进去的**实参**决定的。
 *
 * 这里只做客观提取：拿到该 `new Function(...)` 调用之后，函数被**调用**时
 * 每个形参位置传的实参源码，判断：
 *   - `controller` 位置：是不是 `null` / 字面 `null`
 *   - `isOrphanHintShown` 位置：是不是恒值（`() => true` / `() => false`）
 */
import { readFileSync } from 'node:fs';
import { findFunctionBody, } from './locate-function.mjs';
import { stripComments, matchPair } from './check-fake-green-construction.mjs';

/** 取 `new Function(...)` 的形参名列表（只认字符串字面量参数） */
export function paramNames(callSource) {
  const openParen = callSource.indexOf('(');
  const closeParen = matchPair(callSource, openParen, '(', ')');
  if (closeParen < 0) return null;
  const argsSrc = callSource.slice(openParen + 1, closeParen);
  const args = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < argsSrc.length; i++) {
    const c = argsSrc[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += argsSrc[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  const names = args
    .slice(0, -1)
    .map((a) => {
      const m = /^(['"`])([\s\S]*)\1$/.exec(a);
      return m ? m[2] : null;
    });
  // 只关心全文字面量的那一段（openLogin 探针都是这么写的）
  if (names.some((n) => n === null)) return null;
  return names;
}

/**
 * 找到 `new Function(...)` 之后**同一个函数里**的那次调用 `factory(...)`，
 * 返回每个位置传的实参源码。
 */
export function callArgs(code, fnName) {
  const loc = findFunctionBody(code, fnName);
  if (!loc) return null;
  const body = loc.body;
  const nf = body.indexOf('new Function(');
  if (nf < 0) return null;
  const nfOpen = body.indexOf('(', nf);
  const nfClose = matchPair(body, nfOpen, '(', ')');
  const names = paramNames(body.slice(nf, nfClose + 1));
  if (!names) return null;
  // `factory(` 之后的那次调用。⚠️ 必须跳过 `new Function(...) as (…) => …`
  // 这段 **TS 类型断言**里紧随其后的 `(`，否则会抽到形参**声明**
  // （`ctrl: unknown` / `iohs: () => boolean`）—— 那看起来"抽到了"，
  // 其实一个实参都不是。定位失败必须炸出来，不能静默。
  let afterIdx = nfClose + 1;
  const asMatch = /^\s*as\s*\(/.exec(body.slice(afterIdx));
  if (asMatch) {
    const asOpen = body.indexOf('(', afterIdx + asMatch[0].length - 1);
    const asClose = matchPair(body, asOpen, '(', ')');
    if (asClose < 0) return null;
    afterIdx = asClose + 1;
    // `) => () => Promise<void>;` 这段返回类型里还有括号，一路跳到 `;`
    const semi = body.indexOf(';', afterIdx);
    if (semi > 0) afterIdx = semi + 1;
  }
  const after = body.slice(afterIdx);
  const m = /\b([A-Za-z_$][\w$]*)\s*\(/.exec(after);
  if (!m) return null;
  const callOpen = afterIdx + m.index + m[0].length - 1;
  const callClose = matchPair(body, callOpen, '(', ')');
  if (callClose < 0) return null;
  const argsSrc = body.slice(callOpen + 1, callClose);
  const args = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < argsSrc.length; i++) {
    const c = argsSrc[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += argsSrc[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  const map = {};
  names.forEach((n, i) => {
    map[n] = args[i] ?? null;
  });
  return { names, args, map };
}

if (process.argv[1] && process.argv[1].endsWith('probe-shape.mjs')) {
  const src = readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8');
  const code = stripComments(src);
  for (const name of ['buildProbe', 'buildFallbackProbe']) {
    const r = callArgs(code, name);
    if (!r) {
      console.log(name, '→ 抽不出调用实参');
      continue;
    }
    console.log(`\n=== ${name} ===`);
    console.log('  controller 实参       :', r.map.controller);
    console.log('  isOrphanHintShown 实参:', r.map.isOrphanHintShown);
    const ctrlNull = /^\s*null\s*$/.test(r.map.controller ?? '');
    const iohsConst = /^\s*\(\s*\)\s*=>\s*(!?0|!?1|true|false|shown\.flag|\(\)\s*=>\s*true)\s*$/.test(
      r.map.isOrphanHintShown ?? '',
    );
    console.log('  → controller 是 null  :', ctrlNull);
    console.log('  → isOrphanHintShown 恒值:', iohsConst, iohsConst ? '' : '（可能读到真实 DOM 状态）');
  }
}
