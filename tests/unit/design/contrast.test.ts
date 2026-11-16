/**
 * 文字对比度（WCAG 2.1 AA，4.5:1）—— 明暗两套一起核。
 *
 * ## 为什么值得写成测试
 *
 * Stage 5 之前，"颜色够不够清楚"全靠人眼。手工看两眼分不出 4.3 与 4.6，
 * 于是 muted / ok / warning / danger 四个语义色长期不达标，没人发现。
 * 换成算式之后，改任何一个色值都会立刻被这条测试拦下来。
 *
 * ## 为什么是 readFileSync 而不是 import
 *
 * 与 `panel-css-source.test.ts` 同一个理由：被查的东西自己坏掉时，
 * 检查者必须还能跑起来。这里只读文本，不解析 TS、不依赖 Vite 的 CSS 处理。
 *
 * ## 一个刻意的简化：材质面板按"铺在白底上"算
 *
 * 面板真实底色取决于背后页面内容，逐像素都不同。取近白（页面白 + 70% 近白材质）
 * 是最不利的一档 —— 亮底上浅色文字吃暗，算得过这里就处处过。
 * 深色同理，取深灰底。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tokensPath = fileURLToPath(new URL('../../../src/design/tokens.css', import.meta.url));
const css = readFileSync(tokensPath, 'utf8');

const darkStart = css.indexOf('prefers-color-scheme: dark');
const lightBlock = css.slice(0, darkStart);
const darkBlock = css.slice(darkStart);

type Rgba = [number, number, number, number];

function token(name: string, dark: boolean): string {
  const block = dark ? darkBlock : lightBlock;
  const hit = block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
  if (hit) return hit;
  // 深色块只覆盖变化过的令牌，其余继承浅色
  if (dark) return token(name, false);
  throw new Error(`tokens.css 里找不到 --${name}`);
}

function parse(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const inner = value.match(/rgba?\(([^)]+)\)/)?.[1];
  if (inner) {
    const [r, g, b, a] = inner.split(',').map((x) => Number(x.trim()));
    return [r ?? 0, g ?? 0, b ?? 0, a ?? 1];
  }
  throw new Error(`认不出的颜色写法：${value}`);
}

/** 半透明层压在底上，得到实际呈现的颜色 */
const over = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top[3];
  return [
    top[0] * a + bottom[0] * (1 - a),
    top[1] * a + bottom[1] * (1 - a),
    top[2] * a + bottom[2] * (1 - a),
    1,
  ];
};

const relativeLuminance = (c: Rgba): number => {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
};

const ratio = (a: Rgba, b: Rgba): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};

/** 面板材质：70% 近白压在页面白上（浅）/ 64% 近深压在深灰上（深） */
function panel(dark: boolean): Rgba {
  const fill = parse(token('pluma-menu-fill', dark));
  return over(fill, dark ? parse('#101012') : parse('#ffffff'));
}

for (const dark of [false, true]) {
  const label = dark ? '深色' : '浅色';
  const t = (n: string) => parse(token(n, dark));

  describe(`对比度 · ${label}`, () => {
    const cases: ReadonlyArray<[string, Rgba, Rgba]> = [
      ['正文 / 材质面板', t('pluma-text'), panel(dark)],
      ['正文 / canvas', t('pluma-text'), t('pluma-canvas')],
      ['元数据 11px / 材质面板', t('pluma-text-muted'), panel(dark)],
      ['元数据 11px / canvas', t('pluma-text-muted'), t('pluma-canvas')],
      ['元数据 11px / surface', t('pluma-text-muted'), t('pluma-surface')],
      ['强调文字 / 材质面板', t('pluma-accent'), panel(dark)],
      ['强调文字 / canvas', t('pluma-accent'), t('pluma-canvas')],
      ['强调填充上的字', t('pluma-surface'), t('pluma-accent')],
      // 徽章：11px 蓝字压在浅蓝/深蓝底上，这一组是最紧的
      ['徽章文字 / accent-bg', t('pluma-accent'), t('pluma-accent-bg')],
      ['ok 文字 / 材质面板', t('pluma-ok'), panel(dark)],
      ['ok 文字 / 16% 底', t('pluma-ok'), over([...toRgb(t('pluma-ok')), 0.16], panel(dark))],
      ['警告文字 / canvas', t('pluma-warning'), t('pluma-canvas')],
      ['危险文字 / canvas', t('pluma-danger'), t('pluma-canvas')],
    ];

    for (const [name, fg, bg] of cases) {
      it(`${name} ≥ 4.5:1`, () => {
        expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });
}

/** 把 Rgba 的前三位拆出来（给 color-mix 的 alpha 用） */
function toRgb(c: Rgba): [number, number, number] {
  return [c[0], c[1], c[2]];
}
