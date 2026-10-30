/**
 * 主世界脚本的「测试侧出口」工具（阶段 4 S4.1 · 2026-10-30）
 *
 * ## 为什么需要它
 *
 * `src/content/main-world.js` 是一个近 3800 行的 IIFE，**零 export**。
 * `applyProgressToJson` / `matchPath` / `pgcMaxQualityId` 这些纯函数
 * 只能通过 XHR hook 链间接驱动 —— 覆盖到的是"整条链路",
 * 而单个判断函数内部的边界（比如 `typeof !== 'number'`）很难单独构造。
 *
 * ## 为什么在**测试侧**拼接，而不是改 main-world.js
 *
 * 给 `main-world.js` 加 `window.__PLUMA_TEST__ = {...}` 也可以，但那要**改热文件**。
 * 方案已拍板「先补测试，再动任何重构」——测试还没建立就去改被测代码，顺序反了。
 *
 * 拼接方案改 **0 行被测代码**，全部风险留在 `tests/` 里。
 *
 * ## ⚠️ 这是本项目最隐蔽的假通过风险
 *
 * 拼接依赖源文件末尾的字面量 `})();`。如果 `main-world.js` 的末尾结构变了
 * （比如包了 try/catch、改成 async IIFE、多加一层），拼接会**静默失效**：
 * eval 之后 `__T__` 上什么都没有，断言拿到 `undefined` ——
 * 而很多人会把它写成"跳过"或"宽松断言"，于是测试全绿但什么都没测。
 *
 * **这比 CE5 更隐蔽**：CE5 是"没覆盖"，这是"覆盖了但测的是空气"。
 *
 * 所以这里强制自检：拼接后必须确认每个期望的函数 `typeof === 'function'`，
 * 否则**直接 throw**，让测试红掉而不是假绿。
 */

/** 默认暴露给测试的函数名（**只放纯函数**） */
export const TEST_EXPOSED_FNS = [
  'applyProgressToJson',
  'matchPath',
  'pgcMaxQualityId',
  'pgcPlayviewIsTruncated',
  'pgcVideoInfoTruncated',
] as const;

/** `main-world.js` IIFE 的收尾字面量 */
const IIFE_TAIL = '})();';

export class MainWorldSpliceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MainWorldSpliceError';
  }
}

/**
 * 把 IIFE 内的纯函数挂到一个测试可见的出口上，再返回可直接 `eval` 的源码。
 *
 * @param source  `src/content/main-world.js` 的原文
 * @param fns     要暴露的函数名。默认 `TEST_EXPOSED_FNS`
 * @returns 拼接后的源码（在 IIFE 收尾**之前**插入出口赋值）
 * @throws {MainWorldSpliceError} 找不到收尾字面量、或收尾字面量出现多次
 */
export function spliceTestExports(
  source: string,
  fns: readonly string[] = TEST_EXPOSED_FNS,
): string {
  const occurrences = source.split(IIFE_TAIL).length - 1;

  if (occurrences === 0) {
    throw new MainWorldSpliceError(
      `main-world.js 末尾找不到 IIFE 收尾字面量 ${IIFE_TAIL} —— 文件结构变了，拼接会失效`,
    );
  }
  if (occurrences > 1) {
    /**
     * 出现多次时必须停下来，不能"用最后一次"糊过去。
     * 上一次/下一次匹配分别对应哪些嵌套作用域是不确定的，
     * 拼错位置会让出口变量落在错误的闭包里（`typeof` 自检也救不了，
     * 因为它拿到的是一个同名但作用域不同的东西）。
     */
    throw new MainWorldSpliceError(
      `main-world.js 里 ${IIFE_TAIL} 出现了 ${occurrences} 次，无法确定该拼在哪一处`,
    );
  }

  const tailAt = source.lastIndexOf(IIFE_TAIL);
  const head = source.slice(0, tailAt);
  const tail = source.slice(tailAt);

  const exportStmt = `window.__PLUMA_TEST__ = { ${fns
    .map((f) => `${f}: typeof ${f} === 'function' ? ${f} : undefined`)
    .join(', ')} };\n`;

  return head + exportStmt + tail;
}

/**
 * 在 eval 之后确认出口真的挂上了、且每个函数都是 function。
 *
 * **这是防假通过的最后一道**：没这一句，上面拼接失效时测试会拿到 `undefined`
 * 然后"安静地"通过。
 *
 * @param page eval 用的页面对象（jsdom 的 window）
 * @param fns  期望暴露的函数名
 * @throws {MainWorldSpliceError} 出口缺失或某个函数不是 function
 */
export function assertTestExports(
  page: Record<string, unknown>,
  fns: readonly string[] = TEST_EXPOSED_FNS,
): void {
  const bag = page.__PLUMA_TEST__ as Record<string, unknown> | undefined;

  if (!bag) {
    throw new MainWorldSpliceError(
      '拼接后 window.__PLUMA_TEST__ 未挂上 —— main-world.js 结构可能已变，测试会假通过',
    );
  }

  const missing = fns.filter((f) => typeof bag[f] !== 'function');
  if (missing.length > 0) {
    throw new MainWorldSpliceError(
      `以下函数没能在 main-world.js 里找到（可能被改名/移出 IIFE）：${missing.join(', ')}`,
    );
  }
}
