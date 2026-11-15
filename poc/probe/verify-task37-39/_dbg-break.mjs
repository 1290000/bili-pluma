/** 逐行试编译，找出 toJs 输出里第一个让 `new Function` 挂掉的行 */
import { readFileSync } from 'node:fs';

const js = readFileSync('poc/probe/verify-task37-39/_tojs-out.txt', 'utf8');
const lines = js.split('\n');

// 用 "把每一行单独当语句编译" 太脆（跨行结构）。改用二分：取前 n 行做前缀编译不含意义。
// 真正有用的做法：V8 的 SyntaxError 不给行号（new Function 里 stack 只有 <anonymous>:N，
// 但这里 N 永远是 1）。所以自己逐字符累积，找到**最短的失败前缀**的起止。
let lo = 0;
let hi = js.length;
const compiles = (s) => {
  try {
    // 用一个不会执行的包裹，避免顶层 return 等语法错误
    new Function(s);
    return true;
  } catch {
    return false;
  }
};
// 粗略二分对语法错误无效（语法需要完整结构），所以直接报告已知触点附近 200 字
const i = js.indexOf('readAccountMid');
console.log('=== toJs 输出里 readAccountMid 第一次出现处（前后 240 字，空白可视化） ===');
console.log(JSON.stringify(js.slice(Math.max(0, i - 240), i + 120)).replace(/\\n/g, '\n'));
void lo;
void hi;
void compiles;

// 再打印原始源码同一位置的原文（未处理）
const raw = readFileSync('entrypoints/content-panel.content.ts', 'utf8');
const at = raw.indexOf('const openLogin = async');
const rawAt = raw.indexOf('readAccountMid', raw.indexOf('controller?.clearNotice()', at));
console.log('\n=== 源码对应位置（前后 400 字） ===');
console.log(raw.slice(rawAt - 400, rawAt + 120));
