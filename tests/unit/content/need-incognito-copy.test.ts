// @vitest-environment jsdom

/**
 * InPrivate 说明页的**文案硬指标**（2026-11-12，task-4 / 裁决 2）。
 *
 * 用户原话：「弹出来这个弹窗中的文字内容太过杂乱，太过多了，必须精简，精简再精简，
 * 让用户一眼就知道怎么做才能快速的扫码登录上账号」。
 *
 * ## 断言对象是"用户看得见的东西"，不是源码标签
 *
 * 所以这里**真的用 DOM 解析 `index.html`**，再用 `innerText` 语义（跳过 `hidden` /
 * 折叠内的 `details` / 注释 / `script`）取可见文本 —— 不是数源码里的标签个数。
 * 改一次排版不该给假绿灯，改一句文案也不该假红。
 *
 * ## 改前 / 改后实测（同一套测量函数）
 *
 * | 指标 | 改前 | 目标 | 改后 |
 * | --- | --- | --- | --- |
 * | `<details>` 外可见字数 | 283 | ≤ 150 | 103 |
 * | 折叠内字数 | 195 | 只留一份 | 143 |
 * | `<ol>` 个数 | 1 | = 1 | 1 |
 * | `<ol>` 步数 | 2 | ≤ 3 | 3 |
 *
 * ## 反向验证（`AGENTS.md` §1.5）
 *
 * 把删掉的 lead 段（92 字）塞回 `<body>` → 第一条测试变红（103 → 195 > 150）。
 * 把 `why` 折叠里的技术理由复制到正文 → 同样变红。
 * 两段合并成两个 `<ol>` → 第二条变红。见本卡完成说明里的实测记录。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const HTML = readFileSync(resolve(process.cwd(), 'entrypoints/need-incognito/index.html'), 'utf8');

/** 裁决 2 的硬上限。改这个数等于改裁决。 */
const VISIBLE_LIMIT = 150;
const MAX_STEPS = 3;

/**
 * 用 DOMParser 解析（jsdom 环境自带），而不是正则去标签：
 * 正则分不清 `hidden` 与折叠状态，也分不清属性里的 `<`。
 */
function parse(): Document {
  return new DOMParser().parseFromString(HTML, 'text/html');
}

/**
 * 取"用户默认看得见"的文本。
 *
 * 与浏览器 `innerText` 的差异：jsdom 不实现 innerText，所以自己走一遍：
 * 跳过 `hidden`、`script`、`style`、注释与 `<details>` 内部（默认收起）。
 * 空白折叠成单空格并 trim —— 与浏览器渲染后的计数口径一致。
 */
function visibleText(doc: Document): string {
  const clone = doc.body.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll('script, style, details, [hidden]')) el.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 折叠里（`<details>` 内）的文本 —— 用来确认技术理由确实还在、且只有一份。 */
function collapsedText(doc: Document): string {
  const parts = [...doc.body.querySelectorAll('details')].map((d) =>
    (d.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
  return parts.join(' ');
}

describe('★★ 默认可见文案 ≤ 150 字（改前 283）', () => {
  it('★★ `<details>` 外的可见文本 ≤ 150 字', () => {
    /**
     * 反向验证：把改前的 lead 段塞回 body
     * `B站 的登录状态存在 Cookie 里，而 同一个浏览器里 bilibili.com 只能有一份……`
     * → 本条变红（实测 226 字）。
     */
    const n = visibleText(parse()).length;
    expect(n, `默认可见 ${String(n)} 字，超出 ${String(VISIBLE_LIMIT)} 字上限`).toBeLessThanOrEqual(
      VISIBLE_LIMIT,
    );
  });

  it('正文里不再出现「同一个浏览器只能有一份 Cookie」这类重复解释', () => {
    /**
     * 裁决 2：lead 与 why 折叠**重复解释同一件事**（277 字讲一个理由）。
     * 可见部分只许给结论，技术理由只许留在折叠里。
     * 反向验证：把 why 的正文复制到正文 → 本条变红。
     */
    const visible = visibleText(parse());
    expect(visible).not.toMatch(/Set-Cookie/);
    expect(visible).not.toMatch(/Cookie 库|覆盖同一份/);
    expect(visible).not.toMatch(/forbidden response header/);
  });
});

describe('★★ 只许一个动作列表，≤ 3 步', () => {
  it('★★ 整个页面只有一个 `<ol>`', () => {
    /**
     * 反向验证：把"复制地址"那套拆成第二个 `<ol>` → 本条变红（2 !== 1）。
     */
    const lists = parse().body.querySelectorAll('ol');
    expect(lists.length, `发现 ${String(lists.length)} 个 <ol>`).toBe(1);
  });

  it('★★ 步数 ≤ 3', () => {
    const steps = parse().body.querySelectorAll('ol > li');
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBeLessThanOrEqual(MAX_STEPS);
  });

  it('★ 每步一句话（不含句号之外的第二句）', () => {
    /**
     * 判据：步骤文本里 `。` 至多出现一次且必须在结尾 —— 「找到 X，点「详细信息」」
     * 这种逗号连句是**一个动作**，算一句话；出现两句就是塞了解释。
     */
    for (const li of parse().body.querySelectorAll('ol > li')) {
      const t = (li.textContent ?? '').replace(/\s+/g, ' ').trim();
      const sentences = t.split('。').filter((s) => s.trim().length > 0);
      expect(sentences.length, `步骤「${t}」不是一句话`).toBeLessThanOrEqual(1);
    }
  });
});

describe('★★ 修复事实错误：入口是面板按钮，不是「点图标」', () => {
  it('★★ 全文（含注释）不再出现「点图标」这类错误指引', () => {
    /**
     * 事实（ADR 0033 之后）：popup 只剩「显示悬浮入口」一个开关，
     * 真实入口是**面板「账号」Tab 的「扫码登录取流账号」按钮**。
     * 反向验证：把 `main.ts` 里旧文案「开完记得重新点图标」塞回来 → 本条变红。
     */
    const src = readFileSync(resolve(process.cwd(), 'entrypoints/need-incognito/main.ts'), 'utf8');
    for (const [name, text] of [
      ['index.html', HTML],
      ['main.ts', src],
    ] as const) {
      // 只禁"让用户去点图标"的指令式写法；文件头里解释 ADR 的叙述允许出现
      expect(text, `${name} 里还有「点图标」的动作指引`).not.toMatch(
        /(重新)?点(工具栏)?图标|点图标会直接/,
      );
    }
  });

  it('★★ 指纹向真实入口：面板里的「扫码登录取流账号」', () => {
    expect(HTML).toContain('扫码登录取流账号');
    const src = readFileSync(resolve(process.cwd(), 'entrypoints/need-incognito/main.ts'), 'utf8');
    expect(src).toContain('扫码登录取流账号');
  });
});

describe('★ 折叠里保留唯一一份技术理由', () => {
  it('★ `why` 折叠存在，且技术理由在里面', () => {
    const collapsed = collapsedText(parse());
    expect(collapsed).toMatch(/Set-Cookie/);
    expect(collapsed.length).toBeGreaterThan(0);
  });

  it('★ 折叠只有一处（不许两份「为什么」）', () => {
    expect(parse().body.querySelectorAll('details').length).toBe(1);
  });
});

describe('★ 不写做不到的承诺', () => {
  it('★ 不再承诺「自动变绿」这类说明页管不到的效果', () => {
    /**
     * 旧文案「开好后这一步会自动变绿」—— 那个"变绿"只依赖说明页自己还在，
     * 而旧实现 8 秒后就不再监听了。现在状态行只说**当前读到的状态**，
     * 不承诺任何"立刻/马上"的效果。
     */
    expect(HTML).not.toMatch(/自动变绿/);
    expect(visibleText(parse())).not.toMatch(/马上|立刻/);
  });
});
