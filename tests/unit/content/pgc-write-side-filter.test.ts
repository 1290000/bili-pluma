/**
 * 写侧候选过滤的接线（2026-11-22）—— `prepareFullStream` 必须在**写缓存之前**过滤。
 *
 * ## 为什么单独一个文件
 *
 * `pcdn-filter-wiring.test.ts` 守的是**主世界**那四处（`playurl` / PGC 注入 /
 * `playview` / 回调接管）与 `core/cdn/filter.ts` 的等价性。本文件守的是**第五个生效点**：
 * ISOLATED 侧 `entrypoints/content.ts` 的 `prepareFullStream()`。
 *
 * 两者失效方式完全不同：
 *
 * | 位置 | 失效表现 |
 * | --- | --- |
 * | 主世界四处 | 响应体/注入数据没被改写（判据或规则没到） |
 * | **写侧（本文件）** | **缓存里存的就是未过滤的原始候选**，主世界怎么判都没用 |
 *
 * ## 为什么用源码结构的断言，而不是跑 `prepareFullStream`
 *
 * `entrypoints/content.ts` 是 WXT 入口（`export default defineContentScript({...})`
 * 在 import 时就有副作用），**没有任何单测能 import 它**。而 `prepareFullStream`
 * 依赖 20+ 个模块级函数（取流、storage、guard、刷新）——
 * 用 `new Function` + stubs 跑整段代价极高（`pgc-takeover-wiring.test.ts` 的
 * `loadOrchestrate` 只跑 `orchestratePgc` 就已经要 40 行 stubs）。
 *
 * 所以这里**退一步只钉顺序**：断言 `rewriteDashOf(` 在源码里的下标
 * **小于** `writePgcCache(` / `writePgcSessionCache(` 的下标 —— 说明意图即可。
 * 行为正确性由 `core/cdn/filter.test.ts`（判据表）与
 * `pcdn-filter-wiring.test.ts`（等价性）覆盖，加上开关清缓存的独立单测。
 *
 * ⚠️ 这不是"覆盖了但测的是空气"：下标断言**能真的变红** ——
 * 把过滤挪到写缓存之后、或删掉它，本条立刻失败。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONTENT = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

/**
 * 取出 `prepareFullStream` 的**函数体区间**（`[start, end)`）。
 *
 * 定位尾部用下一个顶层函数（`report()`）的文档注释起点 ——
 * 与 `pgc-takeover-wiring.test.ts` 的 `loadOrchestrate` 用同一个手法
 * （那个拿 `guardActionForOutcome` 的文档注释当结束标记）。
 *
 * @returns 函数体的起始下标与结束下标
 * @throws 找不到边界时抛错（让测试红，而不是静默滑过去拿到 -1）
 */
function prepareFullStreamRange(): { start: number; end: number; body: string } {
  const start = CONTENT.indexOf('async function prepareFullStream(');
  expect(start, '源码里找不到 prepareFullStream').toBeGreaterThan(-1);

  // 尾部：下一个顶层 `function report()`（它自己的文档注释就在前面）
  const end = CONTENT.indexOf('function report(): void {', start);
  expect(end, '找不到 prepareFullStream 的结束边界').toBeGreaterThan(start);

  return { start, end, body: CONTENT.slice(start, end) };
}

/** 某个 token 在**函数体**里的下标（找不到就是 -1，由断言去报） */
function indexIn(fnBody: string, token: string): number {
  return fnBody.indexOf(token);
}

/**
 * 取真实的**调用表达式**下标，而不是裸函数名。
 *
 * ⚠️ 为什么不能搜裸名字：`prepareFullStream` 里那段解释性注释的表格
 * （「位置约束」那两行）自己就写着 `writePgcCache()` / `writePgcSessionCache()`，
 * 裸 `indexOf` 会命中**注释里的第一次**，于是断言测的变成"注释里的顺序" ——
 * 那正是本项目反复踩的"覆盖了但测的是空气"。带实参的调用串没有歧义：
 *
 * | 函数 | 真实调用形态 |
 * | --- | --- |
 * | 写缓存 | `await writePgcCache(cid, merged)` |
 * | 写同步缓存 | `writePgcSessionCache(cid, merged,` |
 * | 过滤 | `rewriteDashOf(merged,` |
 */
const CALL = {
  filter: 'rewriteDashOf(merged,',
  asyncCache: 'await writePgcCache(cid, merged)',
  syncCache: 'writePgcSessionCache(cid, merged,',
  applyPlayback: 'pageState.applyPlayback({',
} as const;

describe('★ 写侧过滤：prepareFullStream 必须在写缓存之前改写候选', () => {
  it('★ `rewriteDashOf(` 出现在 `writePgcCache(` **之前**', () => {
    /**
     * 反例（人工验证过）：把这段挪到 `await writePgcCache(...)` 之后 → 本条红。
     * 后果就是本次要修的 bug 本身 —— 缓存里存的是未过滤的原始候选，
     * 主世界怎么判都没用（它读的就是这份缓存）。
     */
    const { body } = prepareFullStreamRange();
    const filterAt = indexIn(body, CALL.filter);
    const localAt = indexIn(body, CALL.asyncCache);

    expect(filterAt, 'prepareFullStream 里没有调 rewriteDashOf()').toBeGreaterThan(-1);
    expect(localAt, 'prepareFullStream 里没有调 writePgcCache()').toBeGreaterThan(-1);
    expect(filterAt).toBeLessThan(localAt);
  });

  it('★ `rewriteDashOf(` 出现在 `writePgcSessionCache(` **之前**', () => {
    /**
     * `sessionStorage` 那一份才是**注入的唯一同步来源**（真机：主世界在 setter 里
     * 直接 `getItem()`）。只过滤 `storage.local` 那一份 = 关键路径仍然脏。
     */
    const { body } = prepareFullStreamRange();
    const filterAt = indexIn(body, CALL.filter);
    const syncAt = indexIn(body, CALL.syncCache);

    expect(filterAt).toBeGreaterThan(-1);
    expect(syncAt, 'prepareFullStream 里没有调 writePgcSessionCache()').toBeGreaterThan(-1);
    expect(filterAt).toBeLessThan(syncAt);
  });

  it('★ `rewriteDashOf(` 出现在 `pageState.applyPlayback(` **之后**', () => {
    /**
     * 面板要的是**播放账号拿到的原文**，与 S4 的 `pgc-takeover-ok` 快照口径一致
     * （那里明确写着"面板要的是改写前的原文"）。
     *
     * 过滤要是跑到 `applyPlayback()` 之前，面板显示的就是"已经换过 authority"的数据 ——
     * 而用户真正想看的是"服务端给了我什么"。这是两个不同的问题。
     */
    const { body } = prepareFullStreamRange();
    const applyAt = indexIn(body, CALL.applyPlayback);
    const filterAt = indexIn(body, CALL.filter);

    expect(applyAt, 'prepareFullStream 里没有调 pageState.applyPlayback()').toBeGreaterThan(-1);
    expect(filterAt).toBeGreaterThan(applyAt);
  });

  it('★ 过滤用的是下发的规则常量，不是调用点自己发明的对象', () => {
    /**
     * `DEFAULT_REWRITE_RULES` 是 `core/cdn/filter.ts` 里**唯一**允许出现镜像域名的
     * 地方（ADR 0039 边界 6）。调用点另写一份域名表 = 两处真相源，
     * 漂移的表现是"开关开着仍走 PCDN"。
     */
    const { body } = prepareFullStreamRange();
    expect(body).toMatch(/rewriteDashOf\(merged,\s*DEFAULT_REWRITE_RULES\)/);
  });

  it('★ 过滤受开关门控（不是无条件执行）', () => {
    /**
     * `rewriteDashOf()` 的第二个参数要显式写，不能靠默认值 —— 默认规则一旦被
     * 放宽，所有调用点都会静默跟着变。门控判据走 `pcdnFilterEnabledNow()`
     * （它内部读 `readPcdnFilterEnabled()`，是"判据在读取函数里"的唯一出口）。
     */
    const { body } = prepareFullStreamRange();
    expect(body).toContain('pcdnFilterEnabledNow()');
  });

  it('★ 开关值现读一次，**不靠模块级变量的初值**', () => {
    /**
     * `pcdnFilterKnown` 的初值是 `false`（= "还没读出来"与"真的关着" 无法区分）。
     * 写缓存是不可逆动作，不能以"大概已经读到了"为前提 ——
     * 那正是 ADR 0028「洞 1」的形态（`extensionEngagedKnown` 天生读到 `null`）。
     *
     * 所以判定点必须**当场读** `storage.local`：`pcdnFilterEnabledNow()` 在这个文件里
     * 只有一处实现，它内部调 `readPcdnFilterEnabled()` 并回写 `pcdnFilterKnown`。
     */
    const fnStart = CONTENT.indexOf('async function pcdnFilterEnabledNow(');
    expect(fnStart, '找不到 pcdnFilterEnabledNow()（写侧的唯一判定点）').toBeGreaterThan(-1);
    const fnEnd = CONTENT.indexOf('\n}', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = CONTENT.slice(fnStart, fnEnd);

    expect(fnBody, '判定点必须真的读 storage.local').toContain('readPcdnFilterEnabled()');
    expect(fnBody, '读完要回写 pcdnFilterKnown（它服务"重发 cfg 带什么"）').toContain(
      'pcdnFilterKnown =',
    );
  });

  it('★ 改了才上报（`changed === false` 时不许发 `pcdn-filter-stats`）', () => {
    /**
     * 与主世界四处口径一致：**"剔了 0 条"不需要报告**。
     * 无条件上报会让导出里的 `applied` 恒为 true，
     * 于是"开关开着但什么都没做"这个最危险的失败形态再也看不出来。
     */
    const { body } = prepareFullStreamRange();
    expect(body).toMatch(/if \(stats\.changed\) reportPcdnFilterChange\(/);
  });
});

describe('★ 配套：关掉开关必须清 PGC 缓存（否则"关开关不生效"）', () => {
  /**
   * 取出 `chrome.storage.onChanged` 里处理 `PCDN_FILTER_ENABLED_KEY` 的那一段。
   *
   * 边界：从 `const filterChange = changes[PCDN_FILTER_ENABLED_KEY];`
   * 到 `const change = changes[BADGE_ENABLED_KEY];`（下一段的开头）。
   */
  function filterChangeBlock(): string {
    const start = CONTENT.indexOf('const filterChange = changes[PCDN_FILTER_ENABLED_KEY];');
    expect(start, '找不到 PCDN_FILTER_ENABLED_KEY 的 onChanged 分支').toBeGreaterThan(-1);
    const end = CONTENT.indexOf('const change = changes[BADGE_ENABLED_KEY];', start);
    expect(end, '找不到该分支的结束边界').toBeGreaterThan(start);
    return CONTENT.slice(start, end);
  }

  it('★ `nextOn === false` 时清 `sessionStorage` 缓存', () => {
    /**
     * 写侧过滤让缓存**永久携带**换过的 authority（TTL 100 分钟）。
     * 用户关掉开关后刷新，主世界照旧从 `sessionStorage` 同步读走并注入 ——
     * 注入的仍是**过滤过**的流。表现就是"关开关不生效"，
     * 与 ADR 0028 那一类「开关的动作在另一个方向不生效」同源。
     */
    const block = filterChangeBlock();
    expect(block, '关掉开关时必须调 clearPgcSessionCache()').toContain('clearPgcSessionCache()');
  });

  it('★ `nextOn === false` 时也清 `storage.local` 缓存（两份都要）', () => {
    /**
     * 只清 `sessionStorage` 不够：`storage.local` 里那份 LRU
     * （`pluma:pgc-playurl-cache`）会在下一次进同一集时被读出来。
     * 与 `disabled` 分支同一手法（两处都清）。
     */
    const block = filterChangeBlock();
    expect(block, '关掉开关时必须调 clearPgcCache()').toContain('clearPgcCache()');
  });

  it('★ 只在"关"这一个方向清，开→不清（否则重开还要多取一次流）', () => {
    const block = filterChangeBlock();
    // 清缓存必须被 `nextOn === false` 这个条件包住
    expect(block).toMatch(/if \(nextOn === false\) \{[\s\S]*?clearPgcSessionCache\(\)/);
    // 清缓存不能出现在 `else` 分支里（开→清）—— 那种写法会把刚过滤好的缓存扔掉
    expect(block).not.toMatch(/else \{[\s\S]{0,200}?clearPgcSessionCache\(\)/);
  });

  it('⛔ 绝不清 `pluma:pgc-reload:` 刷新护栏（ADR 0030 的三条硬护栏）', () => {
    /**
     * 清护栏会让"取流 → 刷新 → 又没有缓存 → 再取 → 再刷"变成死循环。
     * `clearPgcSessionCache()` 只清 `pluma:pgc-vi:` 前缀、`clearPgcCache()` 只删
     * `pluma:pgc-playurl-cache` 一个键 —— **两者都不碰护栏**。
     *
     * 这条断言把"有人在分支里顺手加了 `clearPgcReloadGuards()`"这种情况拦住。
     */
    const block = filterChangeBlock();
    expect(block).not.toContain('clearPgcReloadGuards');
  });
});

describe('★ 文档：ADR 0038 必须记下第五个生效点', () => {
  const ADR = readFileSync(
    resolve(process.cwd(), 'docs/decisions/0038-filter-pcdn-candidates.md'),
    'utf8',
  );

  it('★ 记录了 PGC 写缓存侧（prepareFullStream）这个调用点', () => {
    /**
     * 「三处来源 / 四条消费路径」那张表**没有错** —— 它对的是"数据从哪来"。
     * 写侧过滤是"在产出数据的地方判"，属于**第五个生效点**而非第四处来源。
     * 所以历史叙述不改，只追加调用点记录（ADR 0038 §「调用点记录」）。
     */
    expect(ADR).toContain('prepareFullStream');
    expect(ADR).toContain('第五个生效点');
  });

  it('★ 记下了真机时序（357 / 358 / 4）作为"结构性失效"的依据', () => {
    /**
     * 没有这三个数，下一个人会以为"主世界不是已经过滤了吗"。
     * 那句注释 `ssAt 357 / patchedAt 358 / cfgCount 4` 是整件事的物证。
     */
    expect(ADR).toContain('357');
    expect(ADR).toContain('358');
    expect(ADR).toContain('cfgCount');
  });

  it('★ 记下了"写侧过滤 + 关开关清缓存"是一对配套', () => {
    /**
     * 只写一半就会留下另一个方向的 bug：开关关掉后缓存里仍是过滤过的流。
     * 这条断言确保两个动作在文档里也绑在一起，而不是只提过滤。
     */
    expect(ADR).toContain('配套动作');
    expect(ADR).toContain('关开关不生效');
  });
});
