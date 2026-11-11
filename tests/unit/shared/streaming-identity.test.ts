/**
 * 取流身份选择 —— 纯判据单测（2026-11-11，步骤 4）。
 *
 * `shared/constants/streaming-identity.ts` 之所以只放类型与纯函数，
 * 就是为了这一层能被完整覆盖（存储实现在 `@platform/storage/streaming-identity-store`，
 * 那里碰 `chrome.storage`，`AGENTS.md` §5.1 不许它出现在 `shared/`）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STREAMING_IDENTITY,
  needsProxy,
  normalizeStreamingIdentity,
  switchingRequiresRebuild,
  type StreamingIdentity,
} from '@shared/constants/streaming-identity';

describe('normalizeStreamingIdentity —— 非法值不许穿透', () => {
  /**
   * 这个位置的取值会**直接影响网络行为**（要不要换 Cookie）。
   * 一个未知字符串流进规则逻辑，后果是"取流身份不明"——
   * 而那种状态既不在 UI 的状态表里，也没人测过。所以收敛在入口。
   */

  it('两个合法值原样通过', () => {
    expect(normalizeStreamingIdentity('extension')).toBe('extension');
    expect(normalizeStreamingIdentity('page')).toBe('page');
  });

  it('默认值是 extension（老用户升级不许静默失去高画质）', () => {
    expect(DEFAULT_STREAMING_IDENTITY).toBe('extension');
    /**
     * 为什么默认必须是 extension：已配置过取流账号的用户，其意图就是
     * "用扩展托管那个"。默认 `page` 会让他们升级后**静默失去高画质** ——
     * 一个升级导致的回归，而且用户完全不知道发生了什么。
     */
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['空串', ''],
    ['拼错的值', 'exstension'],
    ['大小写不对', 'Page'],
    ['旧版本留下的数字', 1],
    ['对象', { identity: 'page' }],
    ['数组', ['page']],
  ])('非法输入 %s → 回落默认值', (_label, raw) => {
    expect(normalizeStreamingIdentity(raw)).toBe(DEFAULT_STREAMING_IDENTITY);
  });
});

describe('🟡-4 normalizeStreamingIdentity 是"唯一的守门人" —— 钉住这个脆弱的正确', () => {
  /**
   * ## 为什么这条单独立一组
   *
   * `normalizeStreamingIdentity()` 只有 1 行业务逻辑：
   *
   * ```ts
   * return raw === 'page' ? 'page' : DEFAULT_STREAMING_IDENTITY;
   * ```
   *
   * 它把**任何**非 `'page'` 的值静默收敛成 `'extension'` —— 包括
   * `'PAGE'`、`' page'`、`'page-identity'`、`null`、`{}`、`[]`。
   *
   * **所以下游所有 `identity === 'page'` 的判断"不会出错"，靠的就是这 8 行。**
   * 那不是"物理上不可能"（类型是编译期的，运行时的 JSON / storage 可以塞任何值），
   * 而是"被一个函数拦住了"。
   *
   * ### 这个正确性脆弱在哪
   *
   * | 如果有人… | 后果 |
   * | --- | --- |
   * | 把 `normalizeStreamingIdentity` 改成 `raw as StreamingIdentity` | 非法值直接穿透 → 下游 `=== 'page'` 全部失效且**无类型错误** |
   * | 在某个入口**跳过** normalize 直接 `as StreamingIdentity` | 同上，而且只在那一条路径上失效（更难发现） |
   * | 新增第三个合法值但只改了类型 | normalize 会把它收敛成 `'extension'` → **静默失效** |
   *
   * 本组钉住前两条的"当前正确性"；第三条由下面的"补集"断言防。
   */

  it('★ 一切非 page 的输入都收敛成 extension（不是抛错、不是原样返回）', () => {
    /**
     * 关键性质：**收敛，不是拒绝**。
     * 抛错会让"存储被手改"变成整个功能起不来；收敛只是回落默认值。
     */
    const weird = [
      'PAGE',
      ' Page',
      'page ',
      'page-identity',
      'pages',
      'extension ',
      '',
      'undefined',
      'null',
      0,
      1,
      false,
      true,
      null,
      undefined,
      {},
      [],
      { page: true },
      ['page', 'page'],
      Symbol.iterator,
    ];

    for (const raw of weird) {
      const got = normalizeStreamingIdentity(raw);
      expect(got, `输入 ${String(raw)} 没有收敛成 extension`).toBe('extension');
      // 而且必须是**合法值**（不是原样返回一个怪东西）
      expect(['extension', 'page']).toContain(got);
    }
  });

  it('★ 返回值域与 StreamingIdentity 的补集关系：只有 page 返回 page', () => {
    /**
     * 这条把"脆弱的正确"变成一个**可验证的性质**：
     *
     * > `normalizeStreamingIdentity(x) === 'page'` ⟺ `x === 'page'`（严格相等）
     *
     * 任何"看起来像 page 但不是"的值都不许返回 `'page'` ——
     * 否则下游会以为用户选了浏览器账号。
     */
    const notExactlyPage = ['PAGE', 'Page', ' page', 'page ', 'page-identity', 'pages', 'page\n'];
    for (const raw of notExactlyPage) {
      expect(normalizeStreamingIdentity(raw), `"${raw}" 被当成了 page`).not.toBe('page');
    }
    // 反向：精确的 'page' 必须返回 'page'
    expect(normalizeStreamingIdentity('page')).toBe('page');
  });

  it('★ 新增第三个合法值时会**静默失效**（已知缺口，钉住它）', () => {
    /**
     * ## 这是一条"记录缺口"的测试，不是"验证正确"的测试
     *
     * 若将来 `StreamingIdentity` 扩成 `'extension' | 'page' | 'some-account'`，
     * **`tsc` 会报错**（`normalizeStreamingIdentity` 的返回类型对不上）——
     * 这是好的。
     *
     * 但如果有人图省事写成：
     * ```ts
     * return (raw === 'page' || raw === 'some-account') ? raw : DEFAULT;
     * ```
     * 或者更糟：
     * ```ts
     * return VALID.includes(raw) ? raw : DEFAULT;   // 忘了 VALID 加上新值
     * ```
     * 那就**没有类型错误**，而新值会被静默收敛成 `'extension'`。
     *
     * 本测试的用途：**任何人要扩取值域，跑到这里会看到这条注释**，
     * 从而知道必须同步改 `normalizeStreamingIdentity` 的三处
     * （白名单判断、`DEFAULT_*`、以及本文件的断言）。
     */
    // 当前实现：任何非 'page' 的值都是 'extension'
    expect(normalizeStreamingIdentity('some-account')).toBe('extension');
    expect(normalizeStreamingIdentity('three')).toBe('extension');

    /**
     * ⚠️ 若将来扩了取值域，上面两行**必须改成新值**，本注释也一并更新。
     * 上面两行红了 = 有人改了 normalize 但没看这条注释。
     */
  });

  it('★ normalize 的幂等性：收敛过的值再收敛一次不变', () => {
    /**
     * 幂等性保证"多处调用 normalize"不会产生漂移 ——
     * 例如 `background.ts` 收敛一次写进 storage，`readStreamingIdentity()` 又收敛一次。
     */
    for (const raw of ['page', 'extension', 'PAGE', '', null, undefined, {}, 42]) {
      const once = normalizeStreamingIdentity(raw);
      const twice = normalizeStreamingIdentity(once);
      expect(twice, `输入 ${String(raw)} 不幂等`).toBe(once);
    }
  });
});

describe('needsProxy —— 决定要不要 DNR 换 Cookie', () => {
  it('extension 需要代理', () => {
    expect(needsProxy('extension')).toBe(true);
  });

  it('page **不需要**代理（页面本来就是那个身份）', () => {
    /**
     * 这一条是步骤 2 「`self` 是一等状态」的姊妹判断。
     * `page` 模式下不装任何规则，但**总开关仍然是开的** ——
     * 界面说「无需代理」，不是「已停用」。
     */
    expect(needsProxy('page')).toBe(false);
  });
});

describe('switchingRequiresRebuild —— 只有变了才重建', () => {
  const ALL: StreamingIdentity[] = ['extension', 'page'];

  it('换成自己 → 不重建（避免无谓的规则表重算）', () => {
    for (const id of ALL) {
      expect(switchingRequiresRebuild(id, id)).toBe(false);
    }
  });

  it('两个方向都算变化 → 都要重建', () => {
    expect(switchingRequiresRebuild('extension', 'page')).toBe(true);
    expect(switchingRequiresRebuild('page', 'extension')).toBe(true);
  });
});
