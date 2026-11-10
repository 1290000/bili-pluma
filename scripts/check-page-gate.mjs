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
 * ⚠️ 2026-11-10 变更：**移除 `entrypoints/popup/main.tsx`，加入 `content-panel.content.ts`**
 *
 * 原因：options 页废除（ADR 0033 阶段 4）+ popup 瘦身为纯开关后，
 * popup **不再判断任何页面** —— 它只是一个 `storage.local` 开关，
 * 不关心当前标签是不是播放页。强行要求它调用 `parsePlayPage()`
 * 等于让检查项绑架设计：那会诱使下一个人加一段**永远不执行的空调用**
 * 去喂检查脚本，而死代码下一个接手的人又不敢删。
 *
 * **判据没有消失，只是搬家**：页面类型判断搬到了页内面板
 * （`entrypoints/content-panel.content.ts` 的 `detectPageKind()`），
 * 所以守卫跟着搬过去。原守卫防的 bug 形态（手写 `/video/` 正则漏判番剧页）
 * 在 popup 里已经不可能发生 —— 它根本不判断。
 *
 * ### 为什么这也是一种**加强**
 *
 * 面板覆盖 `www` + `live` 全站，是**比 popup 更靠前**的判据落点：
 * 判错了会让画质 Tab 在番剧页显示「未生效」。
 * 守卫从"只显示状态的地方"挪到了"真正决定行为的地方"。
 *
 * `src/platform/page/page-state-client.ts` 不在 MUST_USE_GATE 里：
 * 它**不判断**播放页，只用 `PLAY_PAGE_URL_PATTERNS` 喂 `tabs.query`，
 * 已被规则 2b（常量必须含两个模式）与规则 3（不许出现字面量）覆盖。
 */
const MUST_USE_GATE = [
  'entrypoints/content-panel.content.ts',
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

/**
 * 「该入口的 matches 缺了登记过的某个域」的**通用**理由。
 *
 * ## 为什么这里写中性文案（2026-11-10 verifier 指出）
 *
 * 原本文案硬编码了"该入口只允许注入直播域……ADR 0031"。但这条循环现在服务
 * **三个**入口，其中两个的根本不是直播域 —— 于是出现这种自相矛盾的输出：
 *
 * ```
 * content-panel.content.ts 的 matches 里缺 `*://www.bilibili.com/*`
 *   该入口只允许注入直播域……是 ADR 0031 的越权     ← 理由指错了入口
 * ```
 *
 * 更糟的是它指向 ADR 0031（视觉清理边界），而多域入口的依据是 ADR 0033（页内面板）。
 * 读报错的人会去翻一份跟这件事无关的 ADR，然后**照着错的理由改代码**。
 *
 * 所以：缺域时只陈述"到底缺了什么、会有什么后果"，**不猜该看哪份 ADR**。
 * 需要 ADR 指向的入口，用 `why` 字段各自写明（见下面登记表）。
 */
const MISSING_DOMAIN_WHY =
  '这个域已在本脚本登记为该入口负责的范围，源码里却没有 —— ' +
  '两类后果：① 被删掉 → 那类页面上控件静默不出现（构建不报错、单测不覆盖）；' +
  '② 被换成更宽的模式（如 `*://*/*`）但少了这一项 → 看起来"覆盖到了"，' +
  '实际上任何一处改写都可能把它彻底删掉而没人发现';

/**
 * 「matches 里出现了未登记的多余域」的理由。
 *
 * 中性表述：多余项可能是 `*:\/\/*\/*`，也可能别的 —— 统一指向"先改登记表 / 先改 ADR"
 * 这条动作，不要在这里假定是哪一份 ADR。
 */
const EXTRA_DOMAIN_WHY =
  '每个匹配域都是一份注入面。新增域必须先改对应的 ADR，再改本脚本登记的期望值 —— ' +
  '只在源码里加一项而这里不知道，等于悄悄扩大了扩展能改哪些网站';

/**
 * **不是播放页**的 content 入口 —— 只需要存在性检查，不参与播放页模式断言。
 *
 * ## 为什么单独一张表（2026-10-31，ADR 0031）
 *
 * `entrypoints/content-live.content.ts` 只注入 `live.bilibili.com`，做样式层的水印隐藏，
 * **不判断"是不是播放页"**（`parsePlayPage()` 本来就明确不认直播，见 `video-page.ts`）。
 *
 * ⚠️ **文件名的 `.content.` 不是随便取的**：WXT 靠文件名判定入口类型
 * （`PATH_GLOB_TO_TYPE_MAP`：`*.content.[jt]s` → `content-script`，而兜底的 `*.[jt]s`
 * → `unlisted-script`）。叫 `content-live.ts` 时它会**正常构建出一个 js 文件，
 * 但不进 manifest 的 `content_scripts`** —— 直播页永远不会注入，且**构建不报任何错**。
 * 2026-10-31 实测踩到过。改这个名字等于让功能静默失效。
 *
 * 若把它并进 `MANIFEST_MATCHES`，规则 2 会要求它也含 `video/*` 与 `bangumi/play/*` ——
 * 那等于逼着直播入口去注入视频页，反向扩大暴露面。
 *
 * 若完全不登记，规则 1/3 都不知道它存在，将来谁把它删了或改成注入全站，这里也发现不了。
 *
 * ## 表格形状（2026-11-10 扩）
 *
 * 原来每项只有 `{file, match}` 两个字段，只够"某一条必须含"。页内面板入口
 * （ADR 0033）要覆盖**两个域**，于是把 `match` 升级成 `requires: string[]`，
 * 并新增 `onlyMatch`：
 *
 * | 字段 | 含义 |
 * | --- | --- |
 * | `requires` | `matches` 里**必须出现**的每一项（缺一项就红） |
 * | `match` | `requires` 单一项时的简写，两者取其一 |
 * | `onlyMatch` | `true` = `matches` 只许 1 项（只服务一个站点的入口用它） |
 * | `why` | 缺域时给这个入口专用的理由。**不给就用通用中性文案** |
 *
 * `why` 为什么存在（2026-11-10 verifier 指出）：通用文案原来硬编码了
 * "只允许注入直播域……ADR 0031"，而这条循环同时服务 www 与多域入口 ——
 * 于是报错会**指错 ADR**，把人引去翻一份无关的决策。理由指错比没有理由更坏。
 *
 * 为什么还要管"多出来的项"：`requires` 只回答"必须有什么"，
 * 谁往数组里**多加**一个 `*:\/\/*\/*` 它一个字都不会说 —— 而多一项正是
 * "注入面扩大"的唯一形态。所以规则 2c-2 逐项对账。
 */
const NON_PLAY_PAGE_ENTRIES = [
  {
    file: 'entrypoints/content-live.content.ts',
    match: '*://live.bilibili.com/*',
    onlyMatch: true,
    why:
      '这个入口只负责直播间。缺它 = 直播水印永远不隐藏；' +
      '若被改成覆盖全站，等于把注入面扩大到所有网站 —— 那是 ADR 0031 明确的越权',
  },
  /**
   * 视觉清理入口（ADR 0031 决定二：边界按**能力**划，不按站点划）。
   *
   * 它注入 `www.bilibili.com` 全站，**但不是"第二个播放页入口"**：
   * 不做取流、不调 `parsePlayPage()`、不碰播放器节点，
   * 内部按 URL 分支只对首页 / 视频页动作。
   *
   * ⚠️ 它**会**注入视频页（为了清广告），这是 ADR 0031 明确批准的。
   * 下面规则 2c 的反向断言仍要求它**不准含 `bangumi/play/*`** ——
   * 番剧页不在视觉清理范围内，多注入一类页面就是无谓扩大暴露面。
   */
  {
    file: 'entrypoints/content-home.content.ts',
    match: '*://www.bilibili.com/*',
    onlyMatch: true,
    why:
      '这个入口只负责 www 站内（首页 + 视频页清广告，ADR 0031）。' +
      '缺它 = 广告清理整块失效；多一项就是无谓扩大注入面',
  },
  /**
   * 页内侧栏面板入口（ADR 0033 决定二）。
   *
   * `requires` 两个域**同时**都要：面板要在首页 / 视频页 / 直播页都能唤起。
   * 只写一个域时不会报错，只会让另一类页面上的面板**静默不出现** ——
   * 这正是本脚本存在的理由（漏一个入口，只有人肉看 manifest 才能发现）。
   *
   * `onlyMatch: false`：它**故意**覆盖两个域，所以 `matches` 数组里可以有多项。
   * 另两个入口保持 `onlyMatch: true`（只许一项），它们各自只服务一个站点，
   * 多一项就等于扩大注入面。
   */
  {
    file: 'entrypoints/content-panel.content.ts',
    requires: ['*://www.bilibili.com/*', '*://live.bilibili.com/*'],
    onlyMatch: false,
    why:
      '面板要在首页 / 视频页 / 直播页都能唤起（ADR 0033 决定二），所以两个域缺一不可：' +
      '缺 www → 首页和视频页没有面板；缺 live → 直播页没有面板。' +
      '两种情况都是**构建不报错、单测不覆盖**的静默失效 —— 只有这条断言会发现',
  },
];

/** 每个 content 入口都必须同时出现的两个模式 */
const REQUIRED_MATCH_PATTERNS = ['*://*.bilibili.com/video/*', '*://*.bilibili.com/bangumi/play/*'];

/** 允许出现 `/video/` 字面量的文件：解析入口与白名单，各一个 */
const PATH_LITERAL_ALLOWED = new Set([
  'src/shared/utils/video-page.ts',
  'src/shared/constants/routes.ts',
  ...MANIFEST_MATCHES,
  ...NON_PLAY_PAGE_ENTRIES.map((e) => e.file),
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

  // 规则 2c：非播放页入口必须存在，且 matches 只指向它自己的站点
  for (const entry of NON_PLAY_PAGE_ENTRIES) {
    const { file } = entry;
    /** 该入口 `matches` 里**必须出现**的模式 */
    const required = entry.requires ?? [entry.match];
    const masked = maskedByFile.get(file);
    if (masked === undefined) {
      problems.push({
        what: `${file} 不存在或不在扫描范围内`,
        why:
          '这是页内非播放页入口（ADR 0031 / ADR 0033）。删掉它本身不会报错，' +
          '但对应的页内控件就永远不出现了 —— 而且没有任何其它检查会发现这件事',
      });
      continue;
    }
    /**
     * 规则 2c-0：先把 `matches` 数组抠出来，**逐项对账**，再决定报什么。
     *
     * ## 为什么必须先解析再报（2026-11-10 verifier 指出）
     *
     * 原来的顺序是"先按子串查缺哪项，再查多出来的项"。于是 matches 写成
     * `['*:\/\/*\/*']` 时会报 **3 条**：
     *
     * ```
     * 缺 `*://www.bilibili.com/*`    ← 误报：全站通配逻辑上包含它
     * 缺 `*://live.bilibili.com/*`   ← 误报
     * 有未登记的域：全站通配          ← 只有这条是真的
     * ```
     *
     * 判据红对了，但两条噪声把唯一要看的那条埋掉了。更麻烦的是那两条会让人
     * 往"我明明写了全站，为什么说缺 www"的方向去查 —— 查一个不存在的问题。
     *
     * ## 现在的对账方式
     *
     * ① **有多余项** → 只报这一条（多一项就是注入面扩大，这是根因；缺什么都不再重复说）
     * ② **没有多余项** → 再逐项查缺，且**点名缺的是哪一项**
     *
     * 两种错误不会同时出现：数组里没有未登记项时"缺少登记项"才是唯一可能的分支。
     *
     * 从源码里把 matches 数组整个抠出来（只抠这一句，不解析整个文件）。
     */
    const arrayRe = /matches:\s*\[([^\]]*)\]/;
    const arr = arrayRe.exec(masked);
    /** `matches` 数组里的每一项；数组都抠不出来时为 `null` */
    const items = arr === null ? null : [...arr[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);

    if (items === null) {
      problems.push({
        what: `${file} 里找不到 \`matches: [...]\` 字面量数组`,
        why:
          'WXT 靠静态分析读这个数组生成 manifest。改成变量或拼字符串会让 ' +
          'manifest 里 `matches` 变空 = 扩展根本不注入（这是框架的约束，不是风格问题）',
      });
      continue;
    }

    const known = new Set(required);
    const extra = items.filter((it) => !known.has(it));

    if (extra.length > 0) {
      // ① 有多余项：只报这一条，不再报"缺 X"（那些是误报，见上面的注释）
      problems.push({
        what: `${file} 的 matches 里有未登记的域：${extra.map((e) => `\`${e}\``).join(', ')}`,
        why: EXTRA_DOMAIN_WHY,
      });
      continue;
    }

    // ② 没有多余项：逐项查缺，点名缺的是哪一项
    for (const match of required) {
      if (!items.includes(match)) {
        problems.push({
          what: `${file} 的 matches 里缺 \`${match}\``,
          why: entry.why ?? MISSING_DOMAIN_WHY,
        });
      }
    }

    // 反向断言：不许它同时含播放页模式，否则就变成了"又一个播放页入口"
    for (const p of REQUIRED_MATCH_PATTERNS) {
      if (items.includes(p)) {
        problems.push({
          what: `${file} 的 matches 里出现了播放页模式 \`${p}\``,
          why:
            '非播放页入口不该注入视频页 / 番剧页。需要在那两个页面上做事，' +
            '改 `content.ts`，不要把这个入口变成第二个播放页入口（ADR 0031 / ADR 0033）',
        });
      }
    }

    if (entry.onlyMatch && items.length !== 1) {
      problems.push({
        what: `${file} 的 matches 应有且只有 1 项，实际 ${String(items.length)} 项`,
        why:
          '这个入口只服务一个站点。多一项就是无谓扩大注入面 —— ' +
          '需要覆盖多个域时，把该入口的 `onlyMatch` 改成 false 并在 `requires` 里列全，' +
          '让这份登记表如实反映权限范围',
      });
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
        `${NON_PLAY_PAGE_ENTRIES.length} 个非播放页入口的 matches 与登记表一致 · ` +
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
