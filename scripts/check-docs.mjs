#!/usr/bin/env node
/**
 * 文档一致性检查 —— 把 `docs/README.md` §「文档检查命令」里那段散装 bash 固化。
 *
 * ## 为什么需要这个脚本
 *
 * `AGENTS.md` §6.3 规定「改完文档必跑两项检查」，`docs/README.md` 给了实现，
 * 但那是一段**要人手动复制粘贴的 bash**。而本项目出过两次事故：
 *
 *   - 一次自检修出 **11 处矛盾**（两套实施路线、两个 `## 13`、3 个缺失文件、4 处悬空引用）
 *   - 一次发现 `docs/README.md` 自己写着「Q4 未做」，而 `03` §0 写着「Q4 已实测」
 *
 * 散装命令的问题是：**要先想起来去跑它**。固化成一个命令、并进 `verify` 链，才是真防住。
 *
 * ## 检查五项
 *
 * 1. **死链**：`[text](./relative/path)` 指向的文件必须存在
 * 2. **章节编号连号**：`## N` 必须从 0 起、步长为 1、不许重复
 * 3. **只读引用完整性**：被 `AGENTS.md` / `docs/` 引用的文件必须真实存在（由 1 覆盖）
 * 4. **`scripts/` 引用**：文中写的 `scripts/xxx` 必须真实存在（防脚本改名后文档悬空）
 * 5. **换行符**：Markdown 必须是 LF（`.editorconfig` 的要求，2026-10-26 加）
 *
 * > 第 5 项来自一次真实事故：Windows 上用 Python 文本模式改写文档，`\n` 被换成 `\r\n`，
 * > 于是「改 30 行」的提交在 git 里变成「改 1000 行」，review 完全没法看。
 * > 它不报错、不影响运行，只毁提交历史 —— 只能靠检查发现。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-docs.mjs
 * ```
 *
 * 有违规时退出码 1。
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = process.cwd();

/** 参与检查的 Markdown 文件（相对仓库根，glob 在代码里手写以保持零依赖） */
const SCAN_TARGETS = ['README.md', 'AGENTS.md', 'ADDITIONAL-TERMS.md', 'docs'];

/** 章节编号检查只针对这几份主文档 —— 子目录文件（ADR/guides）不按 `## N` 编号 */
const NUMBERED_DOCS = [
  'docs/01-architecture.md',
  'docs/02-ui-spec.md',
  'docs/03-open-questions.md',
  'docs/04-project-structure.md',
];

/**
 * 篇幅上限 —— 对应 `AGENTS.md` §6.4 那三条硬规则。
 *
 * ## 为什么需要机器检查
 *
 * §6.4 写的是「上限」，但**没有任何东西在数**。2026-10-26 实测：
 * 给 README 加两行 pnpm 说明，它就从 80 变成 83，越限了 3 行，
 * **是我自己数出来的**，不是错误提示告诉我的。
 * 而 `AGENTS.md` 当时 233/240，只剩 7 行余量 —— 下一次谁加一句话都会超，且没人会去数。
 *
 * ## 三条规则的对应关系
 *
 * - 整文件上限：`FILE_LIMITS`
 * - 单节上限（80 行）：按 `## ` 切节统计，**超了只警告不失败**（§6.4 原文是"考虑拆分"，
 *   不是"必须拆"；已有 8 节经判断决定不拆，见记忆 2026-10-26）
 * - 本文件上限：`AGENTS.md` 260 行
 */
/**
 * ⚠️ **只加"考虑过并写了理由"的放宽。** 数字变大本身不是问题，
 * 但如果理由是"省得删东西"，那就等于把检查关掉。
 */
const FILE_LIMITS = {
  /**
   * 2026-10-27：80 → 95。
   *
   * 80 是按"纯门面"定的。但 README 现在同时承担：风险披露、双身份原理、
   * 安装（下载 + 构建两条路径）、首次使用、凭据安全、音质环境、开发者入口。
   * 七类内容，80 行装不下 —— 实测反复为省行把三段并成一句 250 字符的长行，
   * **可读性反而变差，而可读性正是 README 的主要价值**。
   *
   * 放宽后第一件事是加行（把超宽行拆开），不是加内容。
   *
   * **若将来还要加：优先拆到 `docs/`，不要继续放宽这个数字。**
   */
  'README.md': 95,
  /**
   * 2026-10-27：240 → 260。
   *
   * 240 是按"必须一次读完"定的，这个性质没变，所以**不能拆文件**（没人会读第二个）。
   * 但 239/240 意味着下次谁加一句话就超 —— 而这个文件的内容只会增加（每次踩坑都记一条教训）。
   * 放宽的同时压掉了 §1.5 的表格和 §6.4 的解释，正文反而更短。
   *
   * **若将来还要加：先删过期的教训（教训的保质期到了就该走），不要继续放宽这个数字。**
   */
  'AGENTS.md': 260,
};

/** 单节上限。超出只提示，不判失败 —— §6.4 用的是"考虑拆分" */
const SECTION_LIMIT = 80;

/**
 * 已知超限且**经判断决定不拆**的节。
 *
 * ⚠️ 这张表只能加"考虑过并写了理由"的条目，
 * 加"暂时懒"的条目等于把检查关掉。
 * 名单来源：记忆 2026-10-26「仍超 80 行但不建议硬拆的 8 节」。
 *
 * @type {Record<string, string>}
 */
const SECTION_LIMIT_WAIVED = {
  'docs/01-architecture.md': '§4/§5/§9 是"最重要的一节"或由多个 ### 子节组成，硬拆会割裂阅读',
  'docs/02-ui-spec.md': '§2 是 popup 规范主体，拆开读者要来回跳',
  'docs/04-project-structure.md': '§2 分层禁令是全文最重要一节；§4/§6 同理',
  'docs/guides/debugging.md': '§1 是 DNR 调试主流程，拆开就断',
};

/**
 * 递归收集 Markdown。
 *
 * @param {string} target 相对路径（文件或目录）
 * @returns {Promise<string[]>} 绝对路径
 */
async function collectMarkdown(target) {
  const abs = join(ROOT, target);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return abs.endsWith('.md') ? [abs] : [];

  const out = [];
  const entries = await readdir(abs, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = join(abs, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectMarkdown(relative(ROOT, full))));
    } else if (ent.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 找出所有相对链接目标，校验文件是否存在。
 *
 * 只检查 `./` 与 `../` 开头的相对链接——绝对 URL（http/https）与纯锚点（#）跳过。
 * 带 `#锚点` 的会先剥掉锚点再判文件。
 *
 * @param {string} fileAbs
 * @param {string} src
 * @returns {Promise<Array<{line:number, link:string, raw:string}>>}
 */
async function checkLinks(fileAbs, src) {
  const dir = dirname(fileAbs);
  const lines = src.split('\n');
  const dead = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // ![alt](path) 与 [text](path) 都算；排除 ![](http…)
    for (const m of line.matchAll(/\]\((\.\.?\/[^)\s]*)\)/g)) {
      const link = m[1];
      const withoutAnchor = link.split('#')[0];
      if (!withoutAnchor) continue;

      // 链接可能带行内 title：`path "title"`
      const pure = withoutAnchor.split(/\s+/)[0] ?? withoutAnchor;
      const target = resolve(dir, pure);

      try {
        await stat(target);
      } catch {
        dead.push({ line: i + 1, link: pure, raw: line.trim().slice(0, 90) });
      }
    }
  }
  return dead;
}

/**
 * 检查文档里引用的**脚本文件**是否存在。
 *
 * ## 为什么需要这一项（2026-10-26 实装教训）
 *
 * 本轮精简时两度踩同一个坑：先只查了 `pnpm verify`，漏掉 `pnpm lint` / `pnpm test` / `pnpm build`；
 * 改完后再查又说"清零"，其实 `04` 里还有两处 `pnpm check:boundaries`。
 * **原因是靠"想起来 grep 哪些词"来保证覆盖，而不是靠结构化检查。**
 *
 * 所以这里反过来做：凡是形如 `scripts/xxx` 的路径引用，都必须真实存在。
 * 脚本改名/删除后，文档里的引用会被立刻抓到。
 *
 * @param {string} src
 * @returns {Array<{line:number, ref:string}>}
 */
function checkScriptRefs(src) {
  const lines = src.split('\n');
  const missing = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const m of line.matchAll(/\b(scripts\/[A-Za-z0-9_.-]+\.(?:mjs|cjs|ts|js))/g)) {
      const ref = m[1];
      // 只校验仓库根下的 scripts/，其它路径（poc/…）不在本检查范围
      if (!existsSync(join(ROOT, ref))) missing.push({ line: i + 1, ref });
    }
  }
  return missing;
}

/**
 * 篇幅上限检查。
 *
 * @param {string} rel 相对仓库根的路径
 * @param {string} src
 * @returns {{hard: Array<{kind:string, actual:number, limit:number}>, soft: string[]}}
 */
function checkLength(rel, src) {
  const lines = src.split('\n');
  // 文件末尾若以换行结束，split 会多出一个空字符串，不算实际行
  const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

  const hard = [];
  const soft = [];

  const fileLimit = FILE_LIMITS[rel];
  if (fileLimit !== undefined && lineCount > fileLimit) {
    hard.push({ kind: '全文', actual: lineCount, limit: fileLimit });
  }

  // 单节统计：从 `## ` 开始到下一个 `## ` 之前
  const sections = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^## /.test(line)) {
      if (cur) cur.end = i;
      cur = { title: line.replace(/^##\s*/, '').slice(0, 40), start: i, end: lines.length };
      sections.push(cur);
    }
  }
  for (const s of sections) {
    const size = s.end - s.start;
    if (size > SECTION_LIMIT) {
      soft.push(`${s.title}（${size} 行，上限 ${SECTION_LIMIT}）`);
    }
  }

  return { hard, soft };
}

/**
 * 章节编号连号检查。
 *
 * 规则：`## N` 出现的序列必须严格等于 0,1,2,…N（允许从 0 开始）。
 * 本项目所有主文档都从 `## 0.` 开始，所以起点固定为 0。
 *
 * @param {string} src
 * @returns {Array<{line:number, issue:string, actual:string}>}
 */
function checkNumbering(src) {
  const lines = src.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^## (\d+)[.、\s]/.exec(lines[i] ?? '');
    if (m) found.push({ line: i + 1, num: Number(m[1]), raw: (lines[i] ?? '').slice(0, 60) });
  }

  const issues = [];
  const seen = new Map();
  for (let k = 0; k < found.length; k += 1) {
    const cur = found[k];
    if (seen.has(cur.num)) {
      issues.push({
        line: cur.line,
        issue: `编号 ${cur.num} 重复（首次出现在第 ${seen.get(cur.num)} 行）`,
        actual: cur.raw,
      });
      continue;
    }
    seen.set(cur.num, cur.line);

    if (cur.num !== k) {
      issues.push({
        line: cur.line,
        issue: `编号不连号：第 ${k + 1} 个 ## 章节应为 ${k}，实际是 ${cur.num}`,
        actual: cur.raw,
      });
    }
  }
  return issues;
}

/**
 * 校验 `CHANGELOG.md` 的版本节标题格式。
 *
 * ## 为什么需要它（2026-10-27）
 *
 * `package.mjs` 的 `extractChangelogSection()` 按字符串精确匹配 `## <版本号>`，
 * 匹配不上会**硬失败**——但那只在**打包时**才发生，而打包往往离写 CHANGELOG 很久。
 *
 * 写的时候把 `## 1.0.0` 写成 `## v1.0.0` 或 `## 1.0.0（2026-10-27）`，
 * 当时完全不会报错，等到发布日才发现，那个时间点最不该出岔子。
 *
 * 这里提前在 `verify` 里卡住，成本几毫秒。
 *
 * @returns `{ line, issue, actual }[]`
 */
function checkChangelogFormat(src) {
  const issues = [];
  const lines = src.split('\n');

  // 允许的非版本号二级标题：文档自己约定的「未发布」收集节
  const ALLOWED_H2 = new Set(['未发布']);

  let versionCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const m = /^## (.+)$/.exec(raw);
    if (!m) continue;

    const title = (m[1] ?? '').trim();

    if (ALLOWED_H2.has(title)) continue;

    if (!/^\d+\.\d+\.\d+$/.test(title)) {
      issues.push({
        line: i + 1,
        issue:
          '版本节标题必须是纯 x.y.z（不带 v、不带日期、不带括号说明）——' +
          'package.mjs 按字符串精确匹配，格式不对会让打包硬失败',
        actual: raw.slice(0, 60),
      });
      continue;
    }

    versionCount += 1;
  }

  if (versionCount === 0) {
    issues.push({
      line: 1,
      issue: '没有任何 `## x.y.z` 版本节 —— 发布时 extractChangelogSection 会找不到内容',
      actual: '(整个文件)',
    });
  }

  return issues;
}

async function main() {
  const files = (await Promise.all(SCAN_TARGETS.map(collectMarkdown))).flat();
  const uniqueFiles = [...new Set(files)];

  const deadLinks = [];
  const numberingIssues = [];
  const missingScripts = [];
  const lengthViolations = [];
  const lengthWarnings = [];
  /** 含 CRLF 的文件。`.editorconfig` 写的是 `end_of_line = lf`，但没有任何东西在强制它 */
  const crlfFiles = [];

  for (const file of uniqueFiles) {
    const src = await readFile(file, 'utf8');
    const rel = relative(ROOT, file).split(sep).join('/');

    /**
     * 换行符检查（2026-10-26 加）。
     *
     * 起因：一次用 Windows 上的 Python 文本模式改写文档，`\n` 被悄悄换成 `\r\n`，
     * 于是「改 30 行」的提交在 git 里变成「改 1000 行」，review 完全没法看。
     * 这类问题不会报错、不会影响运行，只毁掉提交历史 —— 只能靠检查发现。
     */
    if (src.includes('\r\n')) {
      crlfFiles.push({ file: rel, count: (src.match(/\r\n/g) ?? []).length });
    }

    for (const d of await checkLinks(file, src)) {
      deadLinks.push({ file: rel, ...d });
    }

    for (const s of checkScriptRefs(src)) {
      missingScripts.push({ file: rel, ...s });
    }

    const len = checkLength(rel, src);
    for (const h of len.hard) lengthViolations.push({ file: rel, ...h });
    if (!SECTION_LIMIT_WAIVED[rel]) {
      for (const s of len.soft) lengthWarnings.push({ file: rel, section: s });
    }

    if (NUMBERED_DOCS.includes(rel)) {
      for (const n of checkNumbering(src)) {
        numberingIssues.push({ file: rel, ...n });
      }
    }
  }

  /**
   * `CHANGELOG.md` 单独查 —— 它按 `## x.y.z` 分节，不能套用 `NUMBERED_DOCS`
   * 的「章节连号」规则（会误报）。
   */
  const changelogIssues = [];
  try {
    const clSrc = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
    for (const c of checkChangelogFormat(clSrc)) changelogIssues.push(c);
  } catch {
    // 文件不存在是合法的（比如从模板新建的仓库），跳过
  }

  console.log(`[docs] 扫描 ${uniqueFiles.length} 个 Markdown`);
  console.log(
    `[docs] 死链 + scripts/ 引用 + 篇幅上限 + 换行符 + ${NUMBERED_DOCS.length} 份主文档的章节连号`,
  );

  if (lengthWarnings.length > 0) {
    console.log(
      `[docs] ℹ️  ${lengthWarnings.length} 个单节超过 ${SECTION_LIMIT} 行（§6.4 是"考虑拆分"，不判失败）：`,
    );
    for (const w of lengthWarnings) console.log(`  ${w.file}  ${w.section}`);
  }

  const clean =
    deadLinks.length === 0 &&
    numberingIssues.length === 0 &&
    missingScripts.length === 0 &&
    lengthViolations.length === 0 &&
    crlfFiles.length === 0 &&
    changelogIssues.length === 0;

  if (clean) {
    console.log('[docs] ✅ 无死链、无失效脚本引用、篇幅达标、换行符全 LF、章节编号连号');
    console.log('[docs] ✅ CHANGELOG 版本节格式合规');
    return;
  }

  if (changelogIssues.length > 0) {
    console.error(`\n[docs] ❌ CHANGELOG.md 有 ${changelogIssues.length} 处版本节格式问题\n`);
    for (const c of changelogIssues) {
      console.error(`  第 ${c.line} 行：${c.issue}`);
      console.error(`    ${c.actual}\n`);
    }
  }

  if (lengthViolations.length > 0) {
    console.error(`\n[docs] ❌ ${lengthViolations.length} 个文件超出篇幅上限（AGENTS.md §6.4）\n`);
    for (const v of lengthViolations) {
      console.error(
        `  ${v.file}  ${v.kind} ${v.actual} 行，上限 ${v.limit}（超 ${v.actual - v.limit} 行）`,
      );
      console.error(`    → 删"删掉也不影响该做什么"的段落；解释为什么的篇幅归 ADR\n`);
    }
  }

  if (deadLinks.length > 0) {
    console.error(`\n[docs] ❌ ${deadLinks.length} 处死链\n`);
    for (const d of deadLinks) {
      console.error(`  ${d.file}:${d.line}  → ${d.link}`);
      console.error(`    ${d.raw}\n`);
    }
  }

  if (crlfFiles.length > 0) {
    console.error(`\n[docs] ❌ ${crlfFiles.length} 个文件含 CRLF（.editorconfig 要求 LF）\n`);
    for (const c of crlfFiles) {
      console.error(`  ${c.file}  ${c.count} 行 CRLF`);
    }
    console.error(
      `\n    → Windows 上某些工具（Python 文本模式写文件）会把 \\n 换成 \\r\\n，` +
        `提交里会出现整文件 diff。\n` +
        `    → 修法：把该文件的 \\r\\n 换成 \\n，再重新提交。\n`,
    );
  }

  if (missingScripts.length > 0) {
    console.error(`\n[docs] ❌ ${missingScripts.length} 处引用了不存在的脚本\n`);
    for (const s of missingScripts) {
      console.error(`  ${s.file}:${s.line}  → ${s.ref}`);
      console.error(`    → 脚本已改名/删除，更新这处引用，或补回脚本\n`);
    }
  }

  if (numberingIssues.length > 0) {
    console.error(`\n[docs] ❌ ${numberingIssues.length} 处章节编号问题\n`);
    for (const n of numberingIssues) {
      console.error(`  ${n.file}:${n.line}  ${n.issue}`);
      console.error(`    ${n.actual}\n`);
    }
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[docs] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
