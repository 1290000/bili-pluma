// @vitest-environment node

/**
 * `PANEL_CSS` 的**源码卫生** —— 只读文本，**不 import `sidebar.ts`**。
 *
 * ## 为什么这个文件必须独立存在
 *
 * `PANEL_CSS` 是一个模板字符串。在它的注释里写一个 Markdown 反引号，
 * 字符串就被提前截断：后面的 CSS 变成 JS 表达式，模块**加载失败**。
 *
 * 2026-11-16 的 UI 改版里，同一个坑踩了**三次**。而前两次的守卫写在
 * `ui-class-contract.test.ts` 里 —— 那个文件 `import { PANEL_CSS }`，
 * 于是断掉时它自己也是"0 test"，报错信息指向 `pane is not defined`
 * 而不是"你这儿多了一个反引号"。
 *
 * **守卫不能与被守卫的东西同生共死。** 所以这里只做一件事：
 * 用 `readFileSync` 读文本，不解析、不导入。文件坏成什么样它都能跑。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(join(process.cwd(), 'src/content/panel/sidebar.ts'), 'utf8');

/** 取 PANEL_CSS 模板字符串的正文（含开头的那个反引号） */
function panelCssBody(): string {
  const start = SOURCE.indexOf('export const PANEL_CSS = `');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('`;', start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('PANEL_CSS 源码卫生', () => {
  it('模板里除了开头那一个反引号，不许再出现第二个', () => {
    const body = panelCssBody();
    const ticks = body.match(/`/g) ?? [];
    // 只有开头那个定界符。多一个 → 字符串被提前截断
    expect(ticks).toHaveLength(1);
  });

  it('花括号是配平的（截断的另一半常表现为少一个 }）', () => {
    const body = panelCssBody();
    const open = (body.match(/{/g) ?? []).length;
    const close = (body.match(/}/g) ?? []).length;
    expect(open).toBe(close);
  });
});
