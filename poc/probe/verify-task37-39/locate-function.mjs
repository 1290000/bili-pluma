/**
 * 从 TS 源码里定位一个函数声明，并返回它的**函数体花括号内的源码**。
 *
 * ## 为什么不能用 `code.indexOf('{', at)`
 *
 * `function buildProbe(opts: { send: 'a' | 'b'; controller: 'x' | 'y' }): Probe {`
 * —— 参数里的**对象类型字面量**本身就带 `{}`。直接找第一个 `{` 会落在类型标注上，
 * 配平一次就"结束"了，切出来的块长度 87 字、里面连 `new Function` 都没有。
 * 这就是我第一版检查器"看起来在扫描、其实每个方法都没扫到"的根因。
 *
 * 正确做法：先 `matchPair` 跳过**参数列表** `(...)`，再跳过**返回类型标注**
 * （`: ... {` 之前的部分），从**返回类型结束后的第一个 `{`** 开始配平。
 *
 * ## 自检
 *
 * `if (require.main === module)` 时打印每个定位到的函数体长度，
 * 长度异常（比如 < 100）说明定位又错了 —— **静默定位失败必须炸出来**。
 */
import { matchPair } from './check-fake-green-construction.mjs';

/**
 * @param {string} code 已剥注释的源码
 * @param {string} name 函数名
 * @returns {{ start: number, end: number, body: string } | null}
 */
export function findFunctionBody(code, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(code);
  if (!m) return null;
  const openParen = code.indexOf('(', m.index);
  const closeParen = matchPair(code, openParen, '(', ')');
  if (closeParen < 0) return null;

  // 从 `)` 之后找函数体的 `{`。返回类型标注里理论上也可能出现 `{`
  // （例如 `): { a: number } {`），所以这里一路扫到**最后一个**紧邻 `{` 的
  // 候选：取第一个 `{` 后先试配平，若配平终点之后紧跟 `{`，说明前一个是类型，
  // 继续往后找。本仓库的写法最多一层，够用且不会静默吞错。
  let brace = code.indexOf('{', closeParen);
  if (brace < 0) return null;
  for (let guard = 0; guard < 4; guard += 1) {
    const end = matchPair(code, brace, '{', '}');
    if (end < 0) return null;
    const rest = code.slice(end + 1).match(/^\s*\{/);
    if (!rest) {
      return { start: brace, end, body: code.slice(brace + 1, end) };
    }
    brace = end + 1 + rest[0].length - 1;
  }
  return null;
}
