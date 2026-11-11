#!/usr/bin/env node
/**
 * 消息路由对齐检查。
 *
 * ## 为什么需要这个脚本
 *
 * `src/shared/types/messages.ts` 用判别联合定义了所有请求类型，
 * `entrypoints/background.ts` 用一串 `if (type === '...')` 分发。
 *
 * **两者之间没有任何编译期约束。** 定义一个请求类型却忘了加分支，`tsc` 完全看不出来——
 * 判别联合的 `never` 检查只在 `switch` 的 `default` 分支里成立，而这里用的是 `if` 链。
 *
 * 后果是**静默失败**：发出去拿到 `undefined`，没有任何报错。
 *
 * 已知案例（2026-10-26）：`playinfo/get` 定义了、注释还写着"当前只有类型，没有 handler"，
 * 但没有任何机制在它该被补上时提醒人。注释防不住下一次。
 * （该类型已于 2026-10-27 删除 —— 体检表被 ADR 0016 砍掉后它再无实现可能。）
 *
 * ## 检查什么
 *
 * 1. 定义了请求类型，但 background 不路由 → 孤儿定义
 * 2. background 路由了，但类型里没定义 → 幽灵分支（多半是改名后漏改）
 *
 * `ALLOWED_UNROUTED` 里显式白名单的可以被豁免，**必须写明理由和计划**。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-messages.mjs
 * node scripts/check-messages.mjs --verbose   # 同时列出已对齐的项
 * ```
 *
 * 有违规时退出码 1，可直接用于 CI。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 请求类型的定义处 */
const MESSAGES_FILE = 'src/shared/types/messages.ts';

/** 路由分发处 */
const ROUTER_FILE = 'entrypoints/background.ts';

/**
 * content 侧的**直连**消息处理（不走 background 分发）。
 *
 * ## 为什么需要单独对账（2026-10-30 加，O6）
 *
 * `messages.ts` 里有 4 个类型**刻意不走 background**：
 *
 * | 类型 | 去向 |
 * | --- | --- |
 * | `PageQueryMsg` / `PageQueryReply` | 扩展页 → content 直连（`page/summary:get`） |
 * | `PageSnapshotMsg` / `PageSnapshotReply` | 页面 → content 直连（`page/snapshot:get`） |
 *
 * 理由写在 `messages.ts:162-166`：这份数据只对"当前这个标签页"有意义，
 * 而 content 本来就在那个页面里，绕到 SW 再回来只是多一份要维护的缓存。
 *
 * **但它们不在本脚本原来的扫描范围里**（`MESSAGES_FILE` + `ROUTER_FILE` 两个文件），
 * 于是"改了类型名却忘了改 content 的字符串判断"**不会有任何检查变红** ——
 * 而这正是本脚本存在的理由（见文件头"漏处理不会编译报错"）。
 *
 * 所以补这第三组对账：`messages.ts` 声明的直连类型 ↔ `content.ts` 实际处理的字面量。
 */
const CONTENT_FILE = 'entrypoints/content.ts';

/**
 * 直连消息的类型 ↔ 期望在 content 侧出现的字面量。
 *
 * ⚠️ 加条目时必须确认 `content.ts` 真的处理它；没处理的要写明为什么。
 *
 * @type {Record<string, string>}
 */
const DIRECT_TYPES = {
  PageQueryMsg: 'page/summary:get',
  PageSnapshotMsg: 'page/snapshot:get',
  PageQueryReply: 'page/summary:ok',
  // `PageQueryReply` 是判别联合，有两个应答分支，都要对账
  PageQueryReplyNone: 'page/summary:none',
  PageSnapshotReply: 'page/snapshot:ok',
};

/**
 * 出现但**不需要**纳入直连对账的字面量。
 *
 * ⚠️ 加任何一条必须写明为什么 —— 只写"不需要"等于把检查关掉。
 */
const DIRECT_LITERALS_IGNORED = {
  // 这是 `page/activate` 的应答，走 background 分发（messages.ts 的 ResponseMsg 联合），
  // 已被第一组对账（声明 ↔ background.ts 路由）覆盖，不属于"直连"。
  'page/activate:ok': '走 background 分发，非直连；由第一组对账覆盖',
};

/**
 * 已知的"只有类型、没有 handler"的请求。
 *
 * ⚠️ **加任何一条都必须写明：为什么现在不加、什么时候加。**
 * 只写"暂不需要"等于把检查关掉。
 *
 * @type {Record<string, string>}
 */
const ALLOWED_UNROUTED = {
  // 当前没有任何豁免。
  //
  // 曾经这里有一条 `playinfo/get`（体检表预留），但体检表被 ADR 0016 砍掉后
  // 那个类型永远不会被实现，2026-10-27 已连同两条响应类型一起删除。
  // 教训：豁免理由里写"做完 X 再删"时，X 被砍掉就必须真的来删——否则它会永远留着。
};

/**
 * 从 messages.ts 里抽出 `RequestMsg` 联合的 `type` 字面量。
 *
 * 只在 `export type RequestMsg =` 到 `export type ResponseMsg` 之间匹配，
 * 避免把 ResponseMsg 的 `:ok` / `:err` 也扫进来。
 *
 * @param {string} src
 * @returns {Set<string>}
 */
function extractDeclaredRequests(src) {
  const start = src.indexOf('export type RequestMsg');
  if (start < 0) throw new Error(`${MESSAGES_FILE} 里找不到 'export type RequestMsg'`);

  const end = src.indexOf('export type ResponseMsg', start);
  if (end < 0)
    throw new Error(
      `${MESSAGES_FILE} 里找不到 'export type ResponseMsg'，无法界定 RequestMsg 的范围`,
    );

  const block = src.slice(start, end);
  const found = new Set();
  for (const m of block.matchAll(/type:\s*'([a-zA-Z0-9/-]+)'/g)) {
    found.add(m[1]);
  }
  return found;
}

/**
 * 从 background.ts 里抽出实际路由的 `type === '...'`。
 *
 * 同时识别单引号和双引号，以及 `===` / `!==` 两侧任意顺序的写法。
 *
 * @param {string} src
 * @returns {Map<string, number>} type → 首次出现的行号
 */
function extractRoutedTypes(src) {
  const lines = src.split('\n');
  const found = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const m of line.matchAll(/type\s*===\s*['"]([a-zA-Z0-9/-]+)['"]/g)) {
      if (!found.has(m[1])) found.set(m[1], i + 1);
    }
  }
  return found;
}

/**
 * 核验「直连消息」类型与 content 侧处理是否对齐。
 *
 * 三类问题都要报：
 *   1. `messages.ts` 里声明的字面量，content.ts 里找不到
 *      → 改了类型名却忘了改 content 的字符串判断（**静默失效**）
 *   2. content.ts 里出现了直连前缀的字面量，但 `DIRECT_TYPES` 没登记
 *      → 新增直连消息却没纳入对账
 *   3. `DIRECT_TYPES` 登记的类型在 messages.ts 里已不存在
 *      → 类型被删/改名，对账表过期
 *
 * @param {string} messagesSrc
 * @param {string} contentSrc
 * @returns {{ok: boolean, problems: string[]}}
 */
function checkDirectMessages(messagesSrc, contentSrc) {
  /** @type {string[]} */
  const problems = [];

  // 1) 声明的类型必须真的存在于 messages.ts
  for (const [typeName, literal] of Object.entries(DIRECT_TYPES)) {
    const declRe = new RegExp(`type\\s*:\\s*'${literal.replace(/[/:]/g, '.')}'`);
    if (!declRe.test(messagesSrc)) {
      problems.push(
        `DIRECT_TYPES 里登记的 ${typeName} → '${literal}'，但 ${MESSAGES_FILE} 里已没有这个类型（表过期了）`,
      );
      continue;
    }
    // 2) content.ts 必须真的处理这个字面量
    if (!contentSrc.includes(literal)) {
      problems.push(
        `${typeName} 声明的 '${literal}' 在 ${CONTENT_FILE} 里找不到 —— 改了类型名却忘了改 content 的字符串判断，消息会静默失效`,
      );
    }
  }

  // 3) content.ts 里的直连字面量都要在表里登记过
  const declaredLiterals = new Set(Object.values(DIRECT_TYPES));
  for (const m of contentSrc.matchAll(/'(page\/[a-z]+:(?:get|ok|err|none))'/g)) {
    const lit = m[1];
    if (declaredLiterals.has(lit)) continue;
    if (lit in DIRECT_LITERALS_IGNORED) continue;
    problems.push(
      `'${lit}' 出现在 ${CONTENT_FILE} 里，但既没登记进 DIRECT_TYPES 也没在 DIRECT_LITERALS_IGNORED 写明理由 —— 它不受对账保护`,
    );
  }

  return { ok: problems.length === 0, problems };
}

function sortByKey(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

// ───────────────────────── 内联字面量联合检查 ─────────────────────────

/**
 * 已知的**封闭枚举字段名** —— 它们的取值域必须在 `messages.ts` / `playinfo.ts` 里定义一次，
 * 各消费方一律 `import type`，**不许手抄**。
 *
 * ## 为什么需要这条检查（2026-11-11，真出过事）
 *
 * 2026-11-11 给 `page/activate:ok` 的 `reason` 加新值 `'page-identity'` 时，
 * 它被**手抄了 5 份**：`messages.ts`（定义）、`page-snapshot.ts`、`playinfo.ts`、
 * `page-state.ts`、`entrypoints/content.ts`（内联断言）。
 *
 * 实际只改了 2 处，漏了 3 处，而 **`tsc` 全程没报错** —— 因为它是
 * `as { reason?: 'ok' | ... }` 这种**独立的结构类型断言**，与 `ResponseMsg`
 * 没有任何链接。四处一起错，互相抵消。
 *
 * 更糟的是：那 3 处当时**恰好没有生产调用方**，所以运行时也看不出来。
 * 一旦接上，新 reason 会被静默吞成旧的默认分支 → **界面谎报状态**。
 *
 * `check-messages.mjs` 存在的理由本来就是"`tsc` 看不见的消息层"，
 * 内联字面量断言属于同一类缺口，所以放在这里。
 *
 * ## 能抓什么、抓不到什么（**不许假装覆盖全部**）
 *
 * | 形态 | 抓得到吗 |
 * | --- | --- |
 * | `reason?: 'ok' \| 'self' \| ...`（属性签名 + 字面量联合） | ✅ |
 * | `reason: 'ok' \| 'self' \| ...` | ✅ |
 * | `x as { reason?: 'ok' \| ... }` 内联断言 | ✅（同上，被同一正则命中） |
 * | `x as ProxyActivateReason` 类型断言 | ❌ 断言本来就是绕过检查的 |
 * | `String(reason)` / 模板拼接 | ❌ 转成 string 后信息丢失 |
 * | `JSON.parse(...) as {...}` | ❌ 完全绕过类型系统 |
 * | 主世界 `main-world.js` 裸 JS | ❌ `tsc` 与正则都容易漏 |
 * | `Record<string, ...>` 宽容器 | ❌ 键是任意字符串 |
 *
 * 后 6 类**没有机械兜底**，只能靠代码审查。见 `messages.ts` 里
 * `ProxyActivateReason` 的「已知缺口」一节。
 */
const SEALED_ENUM_FIELDS = ['reason', 'proxyIdentity', 'lastActivateReason', 'identity'];

/** 唯一真相源：在这里定义联合是**正确**的，不报 */
const ENUM_DEFINITION_FILES = new Set([
  'src/shared/types/messages.ts',
  'src/shared/types/playinfo.ts',
  'src/shared/constants/streaming-identity.ts',
]);

/**
 * **同名但不同枚举**的豁免 —— 必须逐个写明"为什么它不是手抄"。
 *
 * 与 `ALLOWED_UNROUTED` 同一条纪律：白名单是**负债**，只有真的无关才登记。
 *
 * ## 为什么按"联合文本"匹配而不是按行号
 *
 * 行号会随任何无关改动漂移 → 豁免条目一漂就失效 → 要么天天报假红，
 * 要么被迫放宽匹配 → **真缺陷被放过**。而这条检查的全部价值就是"不许放过"。
 *
 * 按 `联合原文` 匹配则稳定得多：同一个枚举只要取值域没变，它就是这个字符串。
 * 取值域变了说明它**可能**又开始手抄了 —— 那时豁免失效，正好重新审一次。
 */
const INLINE_UNION_EXEMPTIONS = {
  // `login/open:ok` 的 reason —— 与 `page/activate:ok` 的 reason **毫无关系**。
  // 它是"登录窗口开没开成"的四种结局（无痕未授权 / 已开着 / 推定成功 / 未知），
  // 取值域与消息枚举完全不同，不属于同一类东西，各自独立是合理的。
  "reason: 'incognito-disabled' | 'already-open' | 'assumed' | 'unknown'":
    'login/open:ok 的 reason —— 与 page/activate 的 ProxyActivateReason 毫无关系',
};

/** 扫描范围（与 `check-boundaries` 对齐：只查会进产物的代码） */
const INLINE_SCAN_DIRS = ['src', 'entrypoints'];

/**
 * 把源码里的**注释剔除**，用等长空白替换 —— **保留行号与列号**。
 *
 * ## 为什么必须做这一步（2026-11-11 修的真误报）
 *
 * `findInlineUnions` 的正则只看"字段名 + 字面量联合"，**不区分注释与代码**。
 * 而项目的注释习惯恰好就是那种写法 —— 预审时实测三种形态全部误报：
 *
 * ```
 * ⚠️ JSDoc 里描述字段   → reason: 'ok' | 'self' | 'disabled'
 * ⚠️ 块注释内           → reason?: 'a' | 'b'
 * ⚠️ 行尾注释引用       → reason: 'a' | 'b'
 * ```
 *
 * 当前仓库里真实存在一处：`src/shared/types/messages.ts:131`
 * （它**恰好**没报错，因为 `messages.ts` 在 `ENUM_DEFINITION_FILES` 白名单里）。
 * **"恰好没报错"是最危险的状态** —— 它让检查看起来在工作，实际只是运气。
 *
 * ## 判据：检查工具误报一次，人就学会忽略它一次
 *
 * 与 `ROUTES_CHECKED_AT` 那条"假警报会训练用户忽略它"是同一原则。
 * 而这条检查是**新加的**，还没建立起"它报的通常是对的"的信誉 ——
 * 最早几次误报破坏力最大。所以**在源头消除，而不是逐条加豁免**。
 *
 * ## 为什么用等长空白替换而不是删掉
 *
 * 删掉会让后续所有行号偏移 → 报错指错行，**那比误报更糟**。
 * 等长替换后 `line` / `column` 与原文完全一致。
 *
 * ## 为什么写状态机而不是正则
 *
 * 注释形态有：`// 行注释` / `/* 块注释 *\/` / JSDoc `/** ... *\/`。
 * 而 `'字符串里的 //'` **不是注释** —— 例如 `const url = 'https://x'`，
 * 用正则剔除会把字符串内容一起吃掉，可能**掩盖真缺陷**（这次的方向是"漏检"，
 * 比误报更严重）。所以按字符扫描，识别到引号就整段跳过。
 *
 * 处理顺序：字符串 → 注释 → 其它。字符串优先，否则 `'//'` 会被当注释起点。
 *
 * @param src 原始源码
 * @returns 与 `src` **等长**、注释被替换成空白的字符串
 */
function stripComments(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;

  /** 把 [from, to) 区间替换成空白（保留换行符，行号才不会漂） */
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < n) {
    const c = src[i];

    // ── 字符串 / 模板字符串：整段跳过，内部的 `//` 不算注释 ──
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }

    // ── 行注释 ──
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }

    // ── 块注释（含 JSDoc）──
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      j = Math.min(j + 2, n);
      blank(i, j);
      i = j;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/**
 * 匹配"字段名 + 内联字面量联合"。
 *
 * ## 形态要求（2026-11-11 定稿，三处都为实测校准过）
 *
 * 1. 字段名之后（可跨行）紧跟 `?:` 或 `:`，再紧跟**至少两个**单引号字面量用 `|` 连接。
 *    两个是下限 —— 单个字面量不是"枚举联合"，不必 import。
 * 2. **允许前置竖线**：Prettier 会把宽联合格式化成像下面这样，
 *    第一个值前面带 `|`。**漏掉这一形态会静默漏检**（实测：`| 'ok' | 'self'` 命中 0）。
 *
 *    ```ts
 *    lastActivateReason?:
 *      | 'ok'
 *      | 'self';
 *    ```
 * 3. **输入必须是已剔除注释的源码**（见 `stripComments`）。否则 JSDoc 里写一句
 *    `reason: 'ok' | 'self'` 就会误报。
 *
 * ## 已知**误报**风险（已用字段白名单收敛，但仍需知道）
 *
 * 若将来有个与消息枚举无关的字段也叫 `identity`（例如 `identity: 'user' | 'group'`），
 * 它会误报。处理办法是登记进 `INLINE_UNION_EXEMPTIONS` 并写明理由 ——
 * **不要为了消掉它而放宽正则**（放宽正则会让真缺陷一起漏掉）。
 *
 * 这就是为什么 `SEALED_ENUM_FIELDS` 只收**四个确定的字段名**，
 * 而不是"任何字段 + 字面量联合"：字段名越少，误报面越小。
 *
 * ## ⚠️ 形态穷举已固化为自检
 *
 * `tests/unit/scripts/check-messages-inline-union.test.ts` 固化了 15 种形态
 * （7 种该报 / 8 种不该报）。**改这个正则时必须跑它** ——
 * 不要靠"跑一遍看看"来验证。
 */
function findInlineUnions(rawSrc, file) {
  const out = [];
  /**
   * ⚠️ 先剔注释，再做匹配。
   * 用 `rawSrc` 取行号（等长替换保证两边行号一致）。
   */
  const codeOnly = stripComments(rawSrc);
  const fields = SEALED_ENUM_FIELDS.join('|');
  const re = new RegExp(
    `\\b(${fields})\\s*\\??\\s*:\\s*(\\|?\\s*'[^']*'\\s*(?:\\|\\s*'[^']*'\\s*)+)`,
    'g',
  );

  for (const m of codeOnly.matchAll(re)) {
    const [, field, union] = m;
    const count = (union.match(/'/g) ?? []).length / 2;
    // 单值不算联合
    if (count < 2) continue;
    const line = codeOnly.slice(0, m.index).split('\n').length;
    // 归一化：去掉前置竖线与多余空白，让豁免表的键稳定
    const normalized = union
      .replace(/^\s*\|/, '')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ file, line, field, union: normalized });
  }
  return out;
}

async function collectCodeFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collectCodeFiles(full)));
    else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * 扫描全仓，找出「手抄的封闭枚举联合」。
 *
 * @returns {Promise<Array<{file:string,line:number,field:string,union:string}>>}
 */
async function checkInlineUnions() {
  const hits = [];
  const exempted = [];
  for (const dir of INLINE_SCAN_DIRS) {
    const files = await collectCodeFiles(join(ROOT, dir));
    for (const abs of files) {
      const rel = abs.slice(ROOT.length + 1).replace(/\\/g, '/');
      if (ENUM_DEFINITION_FILES.has(rel)) continue;
      const src = await readFile(abs, 'utf8');
      for (const hit of findInlineUnions(src, rel)) {
        const key = `${hit.field}: ${hit.union}`;
        if (key in INLINE_UNION_EXEMPTIONS) {
          exempted.push({ ...hit, why: INLINE_UNION_EXEMPTIONS[key] });
        } else {
          hits.push(hit);
        }
      }
    }
  }

  /**
   * 白名单过期检测 —— 与 `ALLOWED_UNROUTED` 那条同理。
   *
   * 条目不再命中任何实际代码，说明豁免所针对的代码已经没了/改了。
   * 留着它会让下一个人以为"这个枚举还需要豁免"，而其实早就不存在了。
   */
  const usedKeys = new Set(exempted.map((e) => `${e.field}: ${e.union}`));
  const staleExemptions = Object.keys(INLINE_UNION_EXEMPTIONS).filter((k) => !usedKeys.has(k));

  return { hits, exempted, staleExemptions };
}

async function main() {
  const verbose = process.argv.includes('--verbose');

  const [messagesSrc, routerSrc, contentSrc] = await Promise.all([
    readFile(join(ROOT, MESSAGES_FILE), 'utf8'),
    readFile(join(ROOT, ROUTER_FILE), 'utf8'),
    readFile(join(ROOT, CONTENT_FILE), 'utf8'),
  ]);

  const declared = extractDeclaredRequests(messagesSrc);
  const routed = extractRoutedTypes(routerSrc);

  const orphans = [...declared].filter((t) => !routed.has(t)).sort();
  const ghosts = [...routed.keys()].filter((t) => !declared.has(t)).sort();

  const allowed = orphans.filter((t) => t in ALLOWED_UNROUTED);
  const unallowed = orphans.filter((t) => !(t in ALLOWED_UNROUTED));

  // 白名单失效检测：白名单里的类型其实已经被路由了 → 该删掉
  const staleAllowlist = Object.keys(ALLOWED_UNROUTED).filter((t) => routed.has(t));

  console.log(
    `[messages] 定义 ${declared.size} 个请求类型 · 路由 ${routed.size} 个（${MESSAGES_FILE} ↔ ${ROUTER_FILE}）`,
  );

  if (allowed.length > 0) {
    console.log(`[messages] ${allowed.length} 个已豁免（白名单）：`);
    for (const t of allowed) console.log(`  ${t} —— ${ALLOWED_UNROUTED[t]}`);
  }

  if (staleAllowlist.length > 0) {
    console.error(
      `\n[messages] ⚠️  白名单已过期，这些类型现在已经有路由了，请从 ALLOWED_UNROUTED 删掉：`,
    );
    for (const t of staleAllowlist) console.error(`  ${t}`);
  }

  if (unallowed.length === 0 && ghosts.length === 0 && staleAllowlist.length === 0) {
    if (verbose) {
      console.log('[messages] 已对齐的：');
      for (const [t, line] of [...routed].sort(sortByKey)) {
        console.log(`  ${t}  (${ROUTER_FILE}:${line})`);
      }
    }
    console.log('[messages] ✅ 无孤儿、无幽灵分支');
    // 直连消息（不走 background 的那 4 个类型）单独对账
    const direct = checkDirectMessages(messagesSrc, contentSrc);
    if (direct.ok) {
      console.log(
        `[messages] ✅ 直连消息已对齐（${Object.keys(DIRECT_TYPES).length} 个类型 ↔ ${CONTENT_FILE}）`,
      );
    } else {
      console.error(`\n[messages] ❌ 直连消息（content 侧 ${CONTENT_FILE}）与实际处理不一致：\n`);
      for (const p of direct.problems) console.error(`  ${p}\n`);
      process.exitCode = 1;
    }

    /**
     * 内联字面量联合 —— **独立于上面的孤儿/幽灵检查**。
     *
     * 上面几项对齐的是"类型定义 ↔ 分支"，这一项对齐的是
     * "**取值域定义 ↔ 消费方有没有手抄**"。两者失败模式不同：
     * 前者是"忘了加分支"，后者是"抄了联合、加了值时漏改某一处"。
     */
    const inline = await checkInlineUnions();
    if (inline.exempted.length > 0) {
      console.log(`[messages] ${inline.exempted.length} 处已豁免（同名但不同枚举）：`);
      for (const e of inline.exempted) console.log(`  ${e.file}:${e.line} —— ${e.why}`);
    }
    if (inline.staleExemptions.length > 0) {
      console.error(`\n[messages] ⚠️  内联联合白名单已过期，这些条目不再命中任何代码，请删掉：`);
      for (const k of inline.staleExemptions) console.error(`  ${k}`);
      process.exitCode = 1;
    }
    if (inline.hits.length === 0) {
      console.log('[messages] ✅ 无手抄的封闭枚举联合（全部走 import type）');
    } else {
      console.error(
        `\n[messages] ❌ ${inline.hits.length} 处手抄了封闭枚举的取值域（加新值时会漏改，而 tsc 不报错）：\n`,
      );
      for (const h of inline.hits) {
        console.error(`  ${h.file}:${h.line}  ${h.field}: ${h.union}`);
      }
      console.error(
        `\n     → 改成 import type 引用唯一的定义处（如 \`import type { ProxyActivateReason } from '@shared/types/messages'\`）\n` +
          `     → 若确实是本处独立的枚举，登记进 INLINE_UNION_EXEMPTIONS 并写明理由\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (unallowed.length > 0) {
    console.error(
      `\n[messages] ❌ ${unallowed.length} 个请求类型已定义但没有 handler（发送它会静默拿到 undefined）：\n`,
    );
    for (const t of unallowed) {
      console.error(`  ${t}`);
      console.error(`    → 在 ${ROUTER_FILE} 加分支，或加进本脚本的 ALLOWED_UNROUTED 并写明计划\n`);
    }
  }

  if (ghosts.length > 0) {
    console.error(
      `\n[messages] ❌ ${ghosts.length} 个分支路由了但类型里没定义（多半是改名后漏改）：\n`,
    );
    for (const t of ghosts) {
      console.error(`  ${t}  (${ROUTER_FILE}:${routed.get(t)})`);
      console.error(`    → 在 ${MESSAGES_FILE} 补类型，或删掉这个分支\n`);
    }
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[messages] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
