#!/usr/bin/env node
/**
 * 「这是不是受支持的播放页」判据守卫 —— 防路径正则复活。
 *
 * ## 为什么需要这个脚本
 *
 * 2026-10-28 审查发现一个持续了整整一轮 PGC 开发的 bug：popup 与 `tabs.handler`
 * 各自写着 `/^https?:\/\/(www\.)?bilibili\.com\/video\//`，而项目早已有
 * `parsePlayPage()`（同时认 `/video/BV…` 与 `/bangumi/play/ep…`）。
 *
 * 后果不是"显示不好看"，是**功能对用户不存在**：
 *   - 番剧页 popup 显示「未生效 · 当前页不是播放页」，而代理正在工作
 *   - 闸门先 return，`page/summary:get` 根本没发出去 → §2.3 画质对比永不显示
 *   - 关总开关后番剧页收不到"需要刷新"的提示 → 用户以为开关坏了
 *
 * 而这一切 **`tsc` 不报错、571 个单测全绿、`verify` 11 项全绿**。
 * 判据本身有单测（`video-page.test.ts`），但"有没有真的调它"没有任何守卫 ——
 * 谁把正则改回去，只有人肉看 diff 才能发现。
 *
 * ## 检查什么
 *
 * 1. **必须用统一入口**：`entrypoints/popup/main.tsx`、`src/background/handlers/tabs.handler.ts`
 *    的代码里必须出现 `parsePlayPage`
 * 2. **路径字面量只许出现在两处**：`shared/utils/video-page.ts`（解析）与
 *    `shared/constants/routes.ts`（白名单）。其余 `entrypoints/` + `src/` 下出现 `/video/`
 *    一律判失败 —— 那是"又一个手写判据"的形状
 *
 * ## 为什么注释要先掩掉
 *
 * 上面那两个文件的注释里**故意**写着"曾经用 `/video/` 正则"，那是给后来人看的警告。
 * 不掩注释就会把警告本身当成违规。掩码用等长空白，保证报出的行号还是真实行号。
 *
 * 字符串**不掩**：`url.includes('/video/')` 和正则一样是 bug 的形状，必须抓。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-page-gate.mjs
 * ```
 *
 * 有违规时退出码 1。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * 必须走统一判据的文件（漏一个就等于某个入口在自说自话）。
 *
 * ⚠️ 2026-10-29 补入 `entrypoints/background.ts`：
 * 它用 `/^https?:\/\/(www\.)?bilibili\.com\/(video|bangumi\/play)\//` 判
 * 「这个标签页还是不是播放页」，决定要不要撤掉 DNR 标签页规则。
 * 这个文件**没有**进过本列表，所以规则 1 从来没管它 —— 它就这么带着一份手写判据
 * 活了一整轮 PGC 开发（B-02）。加进来后规则 1 立刻抓到。
 *
 * `src/platform/page/page-state-client.ts` 不在 MUST_USE_GATE 里：
 * 它**不判断**播放页，只用 `PLAY_PAGE_URL_PATTERNS` 喂 `tabs.query`，
 * 已被规则 2b（常量必须含两个模式）与规则 3（不许出现字面量）覆盖。
 */
const MUST_USE_GATE = [
  'entrypoints/popup/main.tsx',
  'src/background/handlers/tabs.handler.ts',
  'entrypoints/background.ts',
];

/**
 * content script 入口：`matches` 必须写字面量，且两个模式都要在。
 *
 * 为什么不能引用 `PLAY_PAGE_URL_PATTERNS`：WXT 生成 manifest 时对入口文件做**静态分析**，
 * 取不到跨文件常量的值 —— 换了会让 manifest 里 `matches` 变空，等于扩展不注入。
 * 这是"框架的约束"，所以这里退一步，用检查脚本保证两份字面量与解析器覆盖同一批页面。
 */
const MANIFEST_MATCHES = ['entrypoints/content.ts', 'entrypoints/main-hook.content.ts'];

/** 每个 content 入口都必须同时出现的两个模式 */
const REQUIRED_MATCH_PATTERNS = ['*://*.bilibili.com/video/*', '*://*.bilibili.com/bangumi/play/*'];

/** 允许出现 `/video/` 字面量的文件：解析入口与白名单，各一个 */
const PATH_LITERAL_ALLOWED = new Set([
  'src/shared/utils/video-page.ts',
  'src/shared/constants/routes.ts',
  ...MANIFEST_MATCHES,
]);

/**
 * 共享常量所在的文件 —— 它必须同时含两个模式。
 *
 * 不检查的话有个洞：`page-state-client.ts` 引用常量、自己不含字面量，规则 3 就放它过了；
 * 而谁把常量里的 PGC 那条删掉，`tabs.query` 会静默查不到番剧页，检查却全绿。
 */
const PATTERN_SOURCE = 'src/shared/utils/video-page.ts';

/** 扫描范围 */
const SCAN_DIRS = ['entrypoints', 'src'];

const SCAN_EXT = /\.(ts|tsx|mts|cts)$/;

/**
 * 把注释替换成等长空白（保留换行），字符串原样保留。
 *
 * 手写状态机而不是正则：`https://` 里的 `//` 会被朴素正则当成行注释起点，
 * 于是整行后半段被吞掉，后面的违规就漏了。
 *
 * @param {string} src
 * @returns {string}
 */
function maskComments(src) {
  const out = src.split('');
  /** @type {'code'|'line'|'block'|'sq'|'dq'|'tpl'} */
  let state = 'code';

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
      } else if (c === '/' && next === '*') {
        state = 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
      } else if (c === "'") {
        state = 'sq';
      } else if (c === '"') {
        state = 'dq';
      } else if (c === '`') {
        state = 'tpl';
      }
      continue;
    }

    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
      } else {
        out[i] = ' ';
      }
      continue;
    }

    if (state === 'block') {
      if (c === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        state = 'code';
      } else if (c !== '\n') {
        out[i] = ' ';
      }
      continue;
    }

    // 字符串内部：只关心转义与闭合，内容原样保留
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (state === 'sq' && c === "'") state = 'code';
    else if (state === 'dq' && c === '"') state = 'code';
    else if (state === 'tpl' && c === '`') state = 'code';
  }

  return out.join('');
}

/** 列出某目录下所有待扫描文件（相对仓库根） */
async function walk(dir) {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = await readdir(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    const rel = join(dir, e.name).replace(/\\/g, '/');
    if (e.isDirectory()) files.push(...(await walk(rel)));
    else if (SCAN_EXT.test(e.name)) files.push(rel);
  }
  return files;
}

/**
 * 把 import 语句替换成等长空白。
 *
 * 为什么要单独掩 import：`import { parsePlayPage } from '…'` 里就有这个名字，
 * 只查"字符串里出现过 parsePlayPage"的话，**把调用删掉只留 import 也能过** ——
 * 而那种状态恰恰是最危险的（看起来用了统一判据，实际没调）。
 */
function maskImports(masked) {
  return masked.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
}

/**
 * 找 `/video/`，返回 1-based 行号。
 *
 * ⚠️ 必须同时认**转义写法**：正则在源码里写成 `/\/video\//`，
 * 直接按裸串 `/video/` 去搜**一个都找不到**（2026-10-29 反例验证时踩到的）。
 *
 * 做法是先把 `\/` 归一化成 `/` 再搜 —— 比写一个"可选反斜杠"的正则可靠得多：
 * 那种正则里 `\\?` 会被编译成**字面问号**，看起来对、实际全漏（同一个坑踩过一次）。
 * 归一化只删反斜杠不碰换行，所以行号仍然准确。
 *
 * @param {string} masked
 * @returns {number[]}
 */
function findVideoLiteral(masked) {
  const flat = masked.split('\\/').join('/');
  /** @type {number[]} */
  const lines = [];
  const re = /\/video\//g;
  let m;
  while ((m = re.exec(flat)) !== null) {
    lines.push(flat.slice(0, m.index).split('\n').length);
  }
  return lines;
}

async function main() {
  console.log('[page-gate] 检查「是不是播放页」是否只走 parsePlayPage()');

  /** @type {{ what: string, why: string }[]} */
  const problems = [];

  const files = [];
  for (const dir of SCAN_DIRS) files.push(...(await walk(dir)));

  /** @type {Map<string, string>} */
  const maskedByFile = new Map();
  for (const f of files) {
    const src = await readFile(join(ROOT, f), 'utf8');
    maskedByFile.set(f, maskComments(src));
  }

  // 规则 1：关键入口必须**调用**统一判据（不是只 import 了它）
  for (const f of MUST_USE_GATE) {
    const masked = maskedByFile.get(f);
    if (masked === undefined) {
      problems.push({
        what: `${f} 不存在或不在扫描范围内`,
        why: '这个文件是「是不是播放页」的判据落点之一，消失前请先确认判据搬去了哪',
      });
      continue;
    }
    if (!maskImports(masked).includes('parsePlayPage')) {
      problems.push({
        what: `${f} 没有调用 parsePlayPage()`,
        why:
          '判据必须是 shared/utils/video-page.ts 的统一入口。手写正则会漏掉 PGC 页（2026-10-28 的真实 bug：' +
          '番剧页 popup 谎报「未生效」、§2.3 画质对比永不显示）',
      });
    }
  }

  // 规则 2：content 入口的 matches 必须覆盖两种播放页
  for (const f of MANIFEST_MATCHES) {
    const masked = maskedByFile.get(f);
    if (masked === undefined) {
      problems.push({
        what: `${f} 不存在或不在扫描范围内`,
        why: '这是 content script 入口，`matches` 决定 hook 在哪些页面注入 —— 少了 PGC 就等于番剧页没有 hook',
      });
      continue;
    }
    for (const p of REQUIRED_MATCH_PATTERNS) {
      if (!masked.includes(p)) {
        problems.push({
          what: `${f} 的 matches 里缺 \`${p}\``,
          why:
            '两个 content 入口的 matches 必须一致且覆盖普通视频 + PGC。' +
            '只改一边会让某个页面"有 hook 没报到"或反之（2026-10-27 真机踩过）',
        });
      }
    }
  }

  // 规则 2b：共享常量必须同时含两个模式（否则引用它的地方静默漏掉一类页面）
  {
    const masked = maskedByFile.get(PATTERN_SOURCE);
    if (masked === undefined) {
      problems.push({
        what: `${PATTERN_SOURCE} 不存在`,
        why: '`PLAY_PAGE_URL_PATTERNS` 与 `parsePlayPage()` 都住在这里，它是播放页判据的唯一真相源',
      });
    } else {
      for (const p of REQUIRED_MATCH_PATTERNS) {
        if (!masked.includes(p)) {
          problems.push({
            what: `${PATTERN_SOURCE} 的 PLAY_PAGE_URL_PATTERNS 里缺 \`${p}\``,
            why:
              '`chrome.tabs.query` 用它找标签页。少一类 → options 的主账号卡片与诊断页的' +
              '「当前页取流数据」在该类页面上显示"打开任意视频页后可见"（2026-10-28 真实 bug）',
          });
        }
      }
    }
  }

  // 规则 3：路径字面量只许出现在真相源文件与 content 入口里
  for (const [f, masked] of maskedByFile) {
    if (PATH_LITERAL_ALLOWED.has(f)) continue;
    for (const line of findVideoLiteral(masked)) {
      problems.push({
        what: `${f}:${line} 出现 \`/video/\` 路径字面量`,
        why:
          '播放页路径只允许写在 shared/utils/video-page.ts（解析）、shared/constants/routes.ts（白名单）' +
          '与两个 content 入口的 matches。这里出现等于又造了一份判据 —— ' +
          'page-state-client.ts 就是这么漏掉番剧页的',
      });
    }
  }

  if (problems.length === 0) {
    console.log(
      `[page-gate] ✅ ${MUST_USE_GATE.length} 个入口走统一判据 · ` +
        `${MANIFEST_MATCHES.length} 个 content 入口覆盖两种播放页 · ` +
        `${files.length} 个文件里无越界路径字面量`,
    );
    return;
  }

  console.error(`\n[page-gate] ❌ 发现 ${problems.length} 处问题\n`);
  for (const p of problems) {
    console.error(`  ${p.what}`);
    console.error(`    ${p.why}\n`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(
    `[page-gate] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 2;
});
