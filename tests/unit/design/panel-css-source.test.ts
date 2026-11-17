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

  /**
   * ★ 游离反引号：**逐行**找，并在失败时点名是第几行（2026-11-17，Lead 要求）。
   *
   * ## 为什么上面那条不够
   *
   * 上面那条只能回答"多了几个"，回答不了"在哪一行"。而 `tsc` 报的是
   * `TS1127 Invalid character`，位置指向**被截断之后**的语句 ——
   * 与真正写错的那行注释隔了几百行，实测踩了五次都是靠肉眼扫回来的。
   *
   * 这一条把判据换成**合法的结尾长什么样**：模板里只允许两种反引号 ——
   * 开头那个（在 `export const PANEL_CSS = ` 这一行），和**独占一行**的 `` `; ``。
   * 其余任何一行出现反引号，就是注释里写了 Markdown 记号。
   */
  it('★ 反引号只许出现在开头与行首的结尾（失败时点名行号）', () => {
    const lines = SOURCE.split('\n');
    const startLine = lines.findIndex((l) => l.startsWith('export const PANEL_CSS = `'));
    expect(startLine).toBeGreaterThan(-1);

    const offenders: string[] = [];
    let closed = false;
    for (let i = startLine + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      // 合法的结尾：整行只有一个反引号加分号
      if (line === '`;') {
        closed = true;
        break;
      }
      if (line.includes('`')) offenders.push(`第 ${String(i + 1)} 行：${line.trim()}`);
    }

    expect(closed, '没找到行首的结尾 `;，模板字符串可能被截断了').toBe(true);
    expect(offenders, '模板字符串内部出现了游离反引号（注释里写了 Markdown 记号）').toEqual([]);
  });

  it('花括号是配平的（截断的另一半常表现为少一个 }）', () => {
    const body = panelCssBody();
    const open = (body.match(/{/g) ?? []).length;
    const close = (body.match(/}/g) ?? []).length;
    expect(open).toBe(close);
  });
});
