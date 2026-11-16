// @vitest-environment node

/**
 * `scripts/lib/mask-source.ts` 的形态穷举（2026-11-17 抽出时补）。
 *
 * ## 为什么这个工具需要自己的测试
 *
 * 与 `tests/unit/scripts/check-messages-inline-union.test.ts` 同一个理由：
 * **检查工具出错时是静的**。它被两个地方依赖：
 *
 * | 使用方 | 依赖点 |
 * | --- | --- |
 * | `scripts/check-boundaries.ts` | 注释里的 `chrome` 不该报违规（误报一次，人就学会忽略它） |
 * | `tests/.../entry-panel-update-sync.test.ts` | 注释掉的代码必须**看不见**（否则断言形同虚设） |
 *
 * 这个函数原先写在 `check-boundaries.ts` 里、零测试覆盖。抽出来的时候正好把
 * "做过一次的穷举"固化成断言 —— 将来改它必须跑这里，而不是"跑一遍看看"。
 *
 * ## 两条最容易写错的
 *
 * 1. **字符串里的 `//` 不是注释**：`const u = 'https://a/b';` 若被当成注释，
 *    后面半行代码就凭空消失，断言从此瞎猜。
 * 2. **等长**：删掉而不是抹白会改变列号，报错位置就指错了。
 */

import { describe, expect, it } from 'vitest';

import { maskComments, maskCommentsAndStrings, maskSource } from '../../../scripts/lib/mask-source';

describe('maskComments：只遮注释，字符串原样', () => {
  it('行注释被抹掉，同一行的代码保留', () => {
    const src = 'const a = 1; // 这里写 chrome.\nconst b = 2;\n';
    const out = maskComments(src);
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
    expect(out).not.toContain('这里写 chrome');
  });

  it('块注释跨行整块抹掉，换行保留', () => {
    const src = 'const a = 1;\n/* 一整块\n   注释 */\nconst b = 2;\n';
    const out = maskComments(src);
    expect(out).not.toContain('一整块');
    expect(out).not.toContain('注释 */');
    expect(out).toContain('const b = 2;');
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('★ 字符串里的 `//` 不是注释（否则后半行会凭空消失）', () => {
    const src = "const u = 'https://a.b/c'; const keep = 1;\n";
    const out = maskComments(src);
    expect(out).toContain('https://a.b/c');
    expect(out, '字符串里的 // 被当成注释了，后面的代码整段消失').toContain('const keep = 1;');
  });

  it('★★ 字符串原样保留（这是它区别于 maskCommentsAndStrings 的唯一之处）', () => {
    const src = "const k = 'pluma:update-state';\n";
    expect(maskComments(src)).toContain("'pluma:update-state'");
    expect(maskCommentsAndStrings(src)).not.toContain('pluma:update-state');
  });

  it('转义引号不会提前结束字符串', () => {
    const src = "const s = 'a\\'b'; const keep = 2;\n";
    const out = maskComments(src);
    expect(out).toContain('const keep = 2;');
  });
});

describe('maskCommentsAndStrings：连字符串一起遮', () => {
  it('字符串里的禁用符号看不见（check-boundaries 靠这条避免误报）', () => {
    const src = "const s = 'chrome.runtime';\n";
    expect(maskCommentsAndStrings(src)).not.toContain('chrome');
  });

  it('注释里的禁用符号也看不见', () => {
    const src = '// 不要出现 fetch(\nconst a = 1;\n';
    expect(maskCommentsAndStrings(src)).not.toContain('fetch(');
  });

  it('代码本身不被遮', () => {
    const src = 'if (a) { doIt(); }\n';
    expect(maskCommentsAndStrings(src)).toBe(src);
  });
});

describe('共同契约：等长、保留换行', () => {
  it('输出与输入**逐字符等长**（遮的是高度不是宽度）', () => {
    const src = "// 短\nconst a = 'x';\n/* 多行\n 注释 */\nconst b = 2; // 尾\n";
    expect(maskComments(src)).toHaveLength(src.length);
    expect(maskCommentsAndStrings(src)).toHaveLength(src.length);
  });

  it('行号不漂：行数完全一致', () => {
    const src = 'a\n// x\nb\n/* y\nz */\nc\n';
    expect(maskComments(src).split('\n')).toHaveLength(src.split('\n').length);
  });

  it('未闭合的块注释吃到文件尾，不抛', () => {
    const src = 'const a = 1;\n/* 没关\nconst b = 2;\n';
    expect(() => maskComments(src)).not.toThrow();
    expect(maskComments(src)).not.toContain('const b = 2;');
  });

  it('options 缺省 = 不遮字符串', () => {
    const src = "const s = 'keep';\n";
    expect(maskSource(src)).toBe(src);
  });
});
