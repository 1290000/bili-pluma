/**
 * `entrypoints/background.ts` 的播放页判据接线测试（B-02 / B-03）。
 *
 * ## 为什么测的是「这个文件里那段判断」，而不是重测 `parsePlayPage`
 *
 * `parsePlayPage()` 本身已有 38 例单测（`tests/unit/shared/video-page.test.ts`），
 * 再写一份只是复制。真正的空洞在**接线**：
 *
 *   2026-10-29 审查发现 `entrypoints/background.ts` 自己写着
 *   `/^https?:\/\/(www\.)?bilibili\.com\/(video|bangumi\/play)\//`，
 *   而 `tsc` 不报错、641 个单测全绿、`verify` 全绿 —— **没有任何测试问过
 *   "这里到底调没调统一判据"**。上一轮 PGC 开发里，同一个形状的 bug
 *   （`page-state-client.ts`）让番剧页静默失效了整整一轮。
 *
 * ## 为什么不 `import` 那个文件
 *
 * `entrypoints/background.ts` 顶层就调 `defineBackground(...)`（WXT 全局，Node 里不存在），
 * 一 import 就 `ReferenceError`。为了一个纯函数去 mock 整个 WXT 运行时 + `chrome.*`，
 * 成本远高于收益（而且会把"零单测的边界层"这条架构债伪装成已覆盖）。
 *
 * 所以这里**直接读源码文本**，把待测的那段实现抠出来在测试里求值 ——
 * 测的是"文件里真正写着的那段代码"，不是复刻品。源码形态变了就立刻红，
 * 而不是像复刻品那样静默漂移。
 *
 * （这种做法的先例：`tests/unit/content/main-world-real.test.ts` 也是读源码求值。）
 *
 * 代价要说清楚：如果函数的**名字**改了，`extractIsVideoPageUrlSource()` 会返回 null，
 * 下面第一条用例会红，并提示"判据搬家了，请更新本测试" —— 不会静默通过。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePlayPage } from '@shared/utils/video-page';

const ROOT = join(__dirname, '..', '..', '..');

/** background 入口的源码（每个用例各自读，避免缓存掩盖改动） */
function readBackgroundSource(): string {
  return readFileSync(join(ROOT, 'entrypoints', 'background.ts'), 'utf8');
}

/**
 * 从源码里抠出 `export function isVideoPageUrl(...) { ... }` 的函数体。
 *
 * 用大括号配平而不是正则贪婪匹配：函数体里还有别的花括号，
 * `/export function isVideoPageUrl[\s\S]*?\n}/` 会在第一个行首 `}` 处提前收尾。
 *
 * @returns 完整的函数声明源码；找不到返回 null
 */
function extractIsVideoPageUrlSource(src: string): string | null {
  const start = src.indexOf('export function isVideoPageUrl(');
  if (start < 0) return null;

  const bodyOpen = src.indexOf('{', start);
  if (bodyOpen < 0) return null;

  let depth = 0;
  for (let i = bodyOpen; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 把抠出来的函数源码求值成可调用的真函数。
 *
 * 抠出来的是 **TypeScript** 源码（含 `: boolean` 返回类型标注），
 * 而 `new Function` 只认 JS —— 所以先做两件事：
 *   1. 去掉 `export ` 前缀（函数体里不接受 ES 模块导出语法）
 *   2. 去掉顶层声明的返回类型：`(url: string): boolean {` → `(url: string) {`
 *      以及参数类型：`: string` → 空
 *
 * 只处理这两处已知形态，不做通用 TS 剥离（那需要一个语法解析器，不值当）。
 * 源码形态变化会在 `extractIsVideoPageUrlSource` 的判空用例上先红。
 *
 * @param src 函数声明源码（TypeScript）
 * @returns 与 `isVideoPageUrl` 同签名、同实现的函数
 */
function buildIsVideoPageUrl(src: string): (url: string) => boolean {
  const body = src
    .replace(/^export\s+/, '')
    // 参数类型标注：`(url: string)` → `(url)`
    .replace(/\(\s*url\s*:\s*string\s*\)/, '(url)')
    // 返回类型标注：`) : boolean {` → `) {`
    .replace(/\)\s*:\s*boolean\s*\{/, ') {');

  const factory = new Function('parsePlayPage', `${body}\nreturn isVideoPageUrl;`);
  return factory(parsePlayPage) as (url: string) => boolean;
}

describe('background.ts 的 isVideoPageUrl —— 必须走 parsePlayPage()', () => {
  it('函数仍然存在于 entrypoints/background.ts（判据搬家了就先改本测试）', () => {
    const src = extractIsVideoPageUrlSource(readBackgroundSource());
    expect(src, '找不到 `export function isVideoPageUrl(` —— 判据搬家或改名了').not.toBeNull();
  });

  it('实现里必须真的调用 parsePlayPage（不是只 import）', () => {
    const src = extractIsVideoPageUrlSource(readBackgroundSource()) ?? '';
    expect(src).toContain('parsePlayPage(');
    // 反向：不许再出现手写的视频页正则（B-02 的原形态）
    expect(src).not.toContain('video|bangumi');
  });

  /**
   * 真机见过的 URL 形态（2026-10-29 实测抓的）。
   *
   * 每条都断言两件事：
   *   1. `isVideoPageUrl` 的答案
   *   2. 与 `parsePlayPage(...) !== null` 一致 —— 这是「统一判据」的字面含义
   */
  const CASES: ReadonlyArray<{ url: string; expected: boolean; why: string }> = [
    {
      url: 'https://www.bilibili.com/video/BV1jt421t7XH',
      expected: true,
      why: '普通视频页标准形态',
    },
    {
      url: 'https://www.bilibili.com/video/BV1jt421t7XH?p=2',
      expected: true,
      why: '分 P：query 不影响判断',
    },
    {
      url: 'https://bilibili.com/video/BV1jt421t7XH',
      expected: true,
      why: '无 www 的裸域也是真播放页 —— 这条边界不许收紧',
    },
    {
      url: 'https://www.bilibili.com/bangumi/play/ep3854821',
      expected: true,
      why: 'PGC 集页（ADR 0019）',
    },
    {
      url: 'https://www.bilibili.com/bangumi/play/ss28747',
      expected: true,
      why: 'PGC 季页',
    },
    {
      url: 'https://www.bilibili.com/bangumi/media/md28233943',
      expected: false,
      why: '详情页不是播放页 —— 那里没有播放器，不该留规则',
    },
    {
      url: 'https://space.bilibili.com/123',
      expected: false,
      why: '其它子域：`onUpdated` 会收到任意 host 的 URL',
    },
    {
      url: 'https://www.bilibili.com/',
      expected: false,
      why: '首页',
    },
    {
      url: 'https://www.bilibili.com/live/12345',
      expected: false,
      why: 'v1 不支持直播（ADR 0007），不该留规则',
    },
    {
      url: 'not a url',
      expected: false,
      why: '非法 URL：`new URL()` 抛错必须变成 false，不能把异常抛进 onUpdated',
    },
  ];

  for (const c of CASES) {
    it(`${c.expected ? '是' : '不是'}播放页：${c.url}（${c.why}）`, () => {
      const fn = buildIsVideoPageUrl(extractIsVideoPageUrlSource(readBackgroundSource()) ?? '');
      expect(fn(c.url)).toBe(c.expected);
      // 契约：与统一判据完全等价。改回正则时这一行先红。
      expect(fn(c.url)).toBe(parsePlayPage(c.url) !== null);
    });
  }
});

describe('严格化的方向性 —— 旧正则多接受的两种形态（安全的那个方向）', () => {
  /**
   * ⚠️ 这两条**故意**与旧正则的行为不同。
   *
   * 旧正则 `/^https?:\/\/(www\.)?bilibili\.com\/(video|bangumi\/play)\//` 判 true，
   * 新判据判 false。**这是有意的，不是回归。**
   *
   * 为什么安全：判 false 的唯一后果是撤掉这个标签页的 DNR 规则 = **少代理**。
   * 反向（判 true）才会留下一条无主规则，让该页所有命中白名单的请求
   * 继续带播放账号 Cookie —— 那才是危险方向。
   */
  const OLD = /^https?:\/\/(www\.)?bilibili\.com\/(video|bangumi\/play)\//;

  it('`/video/非BV` 判非播放页（旧正则判是）', () => {
    const fn = buildIsVideoPageUrl(extractIsVideoPageUrlSource(readBackgroundSource()) ?? '');
    const url = 'https://www.bilibili.com/video/xxx';
    expect(OLD.test(url)).toBe(true); // 记录旧行为
    expect(fn(url)).toBe(false);
  });

  it('`/bangumi/play/`（空尾）判非播放页（旧正则判是）', () => {
    const fn = buildIsVideoPageUrl(extractIsVideoPageUrlSource(readBackgroundSource()) ?? '');
    const url = 'https://www.bilibili.com/bangumi/play/';
    expect(OLD.test(url)).toBe(true); // 记录旧行为
    expect(fn(url)).toBe(false);
  });
});
