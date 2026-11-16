/**
 * 源码"抹白"工具 —— 检查脚本与测试共用的**唯一实现**。
 *
 * ## 解决什么问题
 *
 * 两类判断都要求"只看**真的会被执行**的代码"：
 *
 * 1. `scripts/check-boundaries.ts` —— 找 `chrome` / `fetch(` 之类禁用符号。
 *    注释里写一句"core 不许出现 chrome."不该报错，字符串里的 URL 也不该。
 * 2. `tests/unit/content/panel/entry-panel-update-sync.test.ts` —— 断言入口里
 *    某几行接线还在。**把整块功能注释掉是最常见的回退形态**，纯文本匹配抓不到。
 *
 * ## 为什么是"抹成等长空白"而不是删掉
 *
 * 删掉会**改变列号**，报错位置就指错了。所以把 [from, to) 区间替换成空格，
 * 保留换行符（行号也才不漂）。
 *
 * ## 两种模式，别混
 *
 * | 函数 | 遮注释 | 遮字符串 | 用在哪 |
 * | --- | --- | --- | --- |
 * | `maskCommentsAndStrings()` | ✅ | ✅ | 禁用符号扫描（字符串里的 `chrome` 也不算） |
 * | `maskComments()` | ✅ | ❌ | 断言"某行代码还在"以及"某个字面量**没有**被硬编码" |
 *
 * ⚠️ 用错模式会**悄悄失效**：
 *
 * - 拿 `maskCommentsAndStrings()` 断言 `import … from '@platform/x'` —— 模块说明符
 *   是字符串、被抹白了，断言永远不成立（或永远成立，取决于断言方向）。
 * - 拿 `maskComments()` 断言"不许出现某个字面量" —— 注释里出现它也会误报。
 *
 * ## 已知简化
 *
 * 模板字符串里的 `${ … }` **不**按代码解析，整体当字符串处理。对上面两个用途足够：
 * 这里只关心"某段代码在不在"，不关心它嵌在哪一层表达式里。
 *
 * ## 与 `scripts/check-messages.mjs` 的关系
 *
 * 那边有一份**同语义的 `stripComments()`**（2026-11-11 加的，注释更早写过一轮坑）。
 * 没有合并不是遗漏，而是它要保持 `.mjs` 单文件可 `node` 直跑。
 * 若哪天要合并，正解是让那个脚本也 `tsx` 起来 import 本文件 ——
 * **不要**再抄第三份。
 */

/** 抹白策略 */
export interface MaskOptions {
  /**
   * `true` = 字符串 / 模板字符串也抹掉（只看代码形状时用）。
   * 缺省 `false` = 只遮注释，字符串原样保留（断言字面量时用）。
   */
  maskStrings?: boolean;
}

/**
 * 把注释（以及可选的字符串）替换成**等长空白**，保持行号与列号不变。
 *
 * @param src 源码原文
 * @param options 见 `MaskOptions`
 * @returns 与 `src` **等长**的字符串，被遮部分变成空格（换行保留）
 */
export function maskSource(src: string, options: MaskOptions = {}): string {
  const maskStrings = options.maskStrings === true;
  const out = src.split('');
  const n = src.length;
  let i = 0;

  /** 把 [from, to) 区间替换成空白（保留换行符，列号才不会漂） */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // 行注释：吃到行尾（不含换行）
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // 块注释：吃到 `*/` 之后；未闭合就吃到文件尾
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    /**
     * 字符串 / 模板字符串：**先整段跳过**，再决定抹不抹。
     *
     * 跳过的动作在两种模式下都必须做 —— 否则字符串里的 `//`
     * 会被当成注释开头，后面半行代码凭空消失，断言就成了瞎猜。
     */
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      // 越过收尾引号；未闭合时 j = n ⇒ stop = n + 1，`blank` 会夹到 n
      const stop = j + 1;
      if (maskStrings) blank(i, stop);
      i = stop;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/**
 * 只遮注释，字符串原样保留。
 *
 * 用于"某行代码还在吗"与"某个字面量有没有被硬编码"这两类断言。
 */
export function maskComments(src: string): string {
  return maskSource(src);
}

/**
 * 注释与字符串都遮掉。
 *
 * 用于禁用符号扫描（`check-boundaries`）：注释里的 `chrome` 与字符串里的 `chrome`
 * 都不该算违规。
 */
export function maskCommentsAndStrings(src: string): string {
  return maskSource(src, { maskStrings: true });
}
