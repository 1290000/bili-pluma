/**
 * 入口接线：`orchestratePgc` 的两处读取判据必须带 `expectedMs`（2026-10-30）
 *
 * ## 为什么用源码字符串断言
 *
 * `entrypoints/content.ts` 是 WXT 入口，`export default defineContentScript({...})`
 * 在 import 时就有副作用，**没有任何单测能 import 它**。而这次的修复点恰好
 * 两处都在这个文件里（`:1132` 的 `cachedUsable` 和 `isSyncCacheUsable(...)`）。
 *
 * 抽纯函数也解决不了：`cachedExpectedMs` 的**取值来源**（从哪份 SSR 取、
 * 用哪个函数取）就是接线本身，把它藏进被测纯函数里等于测不到接线。
 *
 * 所以这里沿用 `content-entry.test.ts` 的既有手法（同样的理由写在该文件头），
 * 只钉**结构**：两个调用点都传了同一个变量、那个变量的来源表达式是哪一个。
 *
 * ⚠️ 它测不了行为 —— 行为在 `pgc-sync-cache-expected-ms.test.ts` 里测。
 * 这个文件守的是"接线别被拆掉"，那个文件守的是"判据本身对"。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONTENT = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

describe('orchestratePgc：读取侧 expectedMs 接线', () => {
  it('★ cachedUsable 的判据带上 expectedMs', () => {
    /**
     * 反例（实测过）：把它改回 `isVideoInfoTruncated(cached)` → 本条红。
     * 后果：接口缺 `timelength` 时毒缓存被判可用 → `hadSync` 逻辑走错分支。
     */
    expect(CONTENT).toContain('isVideoInfoTruncated(cached, cachedExpectedMs)');
    expect(CONTENT).not.toContain('!isVideoInfoTruncated(cached)');
  });

  it('★ isSyncCacheUsable 的调用带上同一个 expectedMs', () => {
    /**
     * 两处**必须同一个变量**：判据一旦漂开，就出现"上面判可用、下面判不可用"
     * 的中间态 —— 缓存被下发进 `cfg`，同时 `hadSync=false` 触发一次多余刷新。
     *
     * ⚠️ 用 `[\s\S]` 而不是 `\s`：prettier 会把这条调用折成一行或拆成多行，
     * 断言不能对换行位置敏感（第一版就是被 `--write` 折行打红的）。
     */
    expect(CONTENT).toMatch(
      /isSyncCacheUsable\([\s\S]{0,80}?sessionStorage\.getItem\('pluma:pgc-vi:' \+ cid\),[\s\S]{0,40}?cachedExpectedMs/,
    );
    // 不带第二个参数的调用形态一律不许留
    expect(CONTENT).not.toMatch(
      /isSyncCacheUsable\([\s\S]{0,80}?sessionStorage\.getItem\('pluma:pgc-vi:' \+ cid\)\s*\)/,
    );
  });

  it('cachedExpectedMs 的来源与写入侧同口径（readSsrVideoInfo + expectedDurationMs）', () => {
    /**
     * 写入侧用的是 `expectedDurationMs(ssrVideoInfo)`，`ssrVideoInfo = readSsrVideoInfo(ssr)`。
     * 读取侧要是换了来源（比如用 `cached.timelength` —— 那正是缺字段的那个字段），
     * 兜底就白做了。
     */
    expect(CONTENT).toContain(
      'const cachedExpectedMs = expectedDurationMs(readSsrVideoInfo(ssrData));',
    );
    expect(CONTENT).toContain('const expectedMs = expectedDurationMs(ssrVideoInfo);');
  });

  it('没有第三处自己发明一个 expectedMs 取值表达式', () => {
    /**
     * 目前有**三处** `expectedDurationMs(...)`：`tryUpgradeForQuality`（画质补取）、
     * 本函数读取侧、`prepareFullStream`（写入侧取流）。三处都从 SSR 的
     * `video_info` 取，口径一致。
     *
     * 只数**代码行**（行首 `const` / `let`），注释里出现的同样字串不算 ——
     * 那几段注释就是在讲这件事，数进去等于这条测试自己跟自己打架。
     *
     * 多出第四处就要重新问一遍"它从哪儿取" —— 那个问题答错正是本 bug 的成因
     * （拿缓存自己的 `timelength` 当参照，而它恰恰是缺字段的那个）。
     *
     * ⚠️ 数字变化时**先读 diff 再改这里**，不要把这条改成 `toContain` 敷衍过去。
     */
    const hits = CONTENT.split('\n')
      .filter((line) => /^\s*(const|let)\s+\w+\s*=\s*expectedDurationMs\(/.test(line))
      .map((line) => line.trim());
    expect(hits).toEqual([
      'const expectedMs = expectedDurationMs(ssrInfo);',
      'const cachedExpectedMs = expectedDurationMs(readSsrVideoInfo(ssrData));',
      'const expectedMs = expectedDurationMs(ssrVideoInfo);',
    ]);
  });
});
