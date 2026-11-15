/**
 * 定位器自检：证明 `findFunctionBody` **真的能定位**，而不是"输出 0 个所以看起来没问题"。
 *
 * 一正一反：
 *   - 反：`function buildProbe(opts: { a: 1 }): Probe {`（参数里带对象类型）
 *         → 必须定位到**含全部语句**的函数体，长度 > 200
 *   - 正：同样源码但改写成语义不同的短函数 → 长度必须不同（证明不是返回常量）
 *
 * 用法：node poc/probe/verify-task37-39/locate-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { findFunctionBody } from './locate-function.mjs';

const FIXTURE = `
function buildProbe(opts: { send: 'a' | 'b'; controller: 'x' | 'y' }): Probe {
  const hintSpy = { n: 0 };
  const chromeStub = { runtime: { id: 'test', sendMessage: async () => ({}) } };
  const factory = new Function('chrome', 'showOrphanHint', \`const o = async () => { showOrphanHint(); };\`);
  return factory(chromeStub, () => { hintSpy.n += 1; });
}
`;

const loc = findFunctionBody(FIXTURE, 'buildProbe');
const len = loc ? loc.body.length : -1;
const hasAll =
  loc !== null &&
  loc.body.includes('hintSpy') &&
  loc.body.includes('new Function') &&
  loc.body.includes('return factory');

console.log('定位到的函数体长度 =', len);
console.log('含全部语句（hintSpy / new Function / return factory）=', hasAll);

// 一正一反：换一个更短的函数，长度必须不同 ⇒ 证明返回的是真源码而不是常量
const SHORT = `
function buildProbe(): Probe {
  return null as never;
}
`;
const loc2 = findFunctionBody(SHORT, 'buildProbe');
const len2 = loc2 ? loc2.body.length : -1;
console.log('短函数体长度 =', len2, '（必须与上面不同，证明不是返回常量）');

const ok = hasAll && len > 200 && len2 !== len;
console.log(ok ? '✅ 定位器自检通过' : '🔴 定位器自检未通过 —— 它的结论不可用');
process.exit(ok ? 0 : 1);
