#!/usr/bin/env node
/**
 * 广告清理判据的**构造性守卫** —— 防「判据在，预筛漏」这类静默失效。
 *
 * ## 为什么需要这个脚本（2026-11-01 真 bug）
 *
 * 「保留活动横幅」这个开关曾经**完全无效**，而三层代码各自看都"对"：
 *
 * | 层 | 状态 |
 * | --- | --- |
 * | CSS 判据 `.activity-m-v1 { --pluma-ad-card: 1 }` | ✅ 语法正确 |
 * | 判据是否命中元素 | ✅ `--pluma-ad-card` = `"1"` |
 * | **元素是否进入 JS 的候选集** | ❌ **不在 `prescreenSelector()` 里 → 从不被扫描** |
 *
 * 只有第三层断了。于是：判据命中 → 但元素从未被标记 → 永不隐藏 → **开关无效**。
 * `tsc` 不报错、单测测不到（要真实 DOM）、`verify` 全绿。
 *
 * 根因是**两份独立的数据源**：
 * - `ads-css.ts` 里硬编码了一段 CSS 判据
 * - JS 预筛来自 `prescreenSelector(ALL_AD_RULES)`，那份数据不含它们
 *
 * 而 `ad-selectors.ts` 文件头自己写着「**不要在别处再写第二份选择器清单**」——
 * 这条约定被打破了，**而且没有任何机器检查能发现**。
 *
 * ## 检查什么
 *
 * **构造性断言**（不是抽样）：
 * 1. `ALL_AD_RULES` 里**每一条**判据的"叶子"（最后一个 id/class），
 *    都必须出现在 `prescreenSelector()` 的结果里
 * 2. `ads-css.ts` / `ad-selectors.ts` 之外**不得**出现 `--pluma-ad-card` 判据声明
 *    （防止又有人在别处写第二份清单）
 * 3. 关键回归项：活动横幅三个选择器必须在预筛中
 *
 * ## 与 `check-patch-scope.mjs` 的分工
 *
 * | 脚本 | 守什么 |
 * | --- | --- |
 * | `check-patch-scope.mjs` | **响应体改写**的授权边界（改的是网络数据） |
 * | **本文件** | **页内 CSS 判据**与 JS 预筛的一致性（改的是 DOM 样式） |
 *
 * 两者都防"静默越权/静默失效"，但作用面完全不同，**不要合并**。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-ad-selectors.mjs
 * ```
 *
 * 有违规时退出码 1。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 判据数据的唯一真相源 */
const SELECTORS_SRC = 'src/content/site-clean/ad-selectors.ts';

/**
 * 允许声明 `--pluma-ad-card` 的文件。
 *
 * 只允许 `ad-selectors.ts`（生成判据）与 `ads-css.ts`（拼装最终 CSS）。
 * 其它文件出现这个变量 = 又造了一份判据清单。
 */
const ALLOWED_JUDGEMENT_FILES = new Set([SELECTORS_SRC, 'src/content/site-clean/ads-css.ts']);

/** 关键回归项 —— 这个 bug 就是它漏了 */
const KEY_SELECTORS = ['.activity-m', '.activity-m-v1', '.ad-report.ad-floor-exp'];

const SCAN_DIRS = ['src', 'entrypoints'];
const SCAN_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

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
 * 把注释替换成等长空白（保留换行），字符串原样保留。
 *
 * 与 `check-page-gate.mjs` 同款实现：注释里**故意**写着反面教材
 * （比如本项目的 CSS 注释里引用了旧选择器），不掩就会把警告当违规。
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
      if (c === '\n') state = 'code';
      else out[i] = ' ';
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

    // 字符串/模板内部：只关心转义与闭合
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

async function main() {
  console.log('[ad-selectors] 检查广告判据与 JS 预筛是否同源');

  /** @type {{ what: string, why: string }[]} */
  const problems = [];

  // ── 用 tsx 子进程读真实模块数据（Node 原生不能 import .ts） ──
  /**
   * ⚠️ 不能 `import()` 一个 .ts 文件 —— Node 没有 TS loader 会抛错。
   * 项目已有 `tsx`，用它跑一个最小脚本把数据以 JSON 吐出来。
   *
   * 这里**必须读运行时数据**而不是正则解析源码：
   * 2026-10-31 就试过正则方案（v3），它把 import、注释、复合选择器全拆错，
   * **检查结论本身不可信**。
   */
  const { execFileSync } = await import('node:child_process');
  const probe = `
    import { ALL_AD_RULES, TOGGLE_RULES, prescreenSelector } from './src/content/site-clean/ad-selectors.ts';
    console.log(JSON.stringify({
      rules: ALL_AD_RULES.map((r) => r.selector),
      toggle: TOGGLE_RULES.map((r) => r.selector),
      prescreen: prescreenSelector(),
    }));
  `;

  let mod;
  try {
    const raw = execFileSync('node', ['node_modules/tsx/dist/cli.mjs', '--eval', probe], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    /** tsx 可能打警告到 stdout，取最后一个 JSON 行 */
    const jsonLine = raw
      .trim()
      .split('\n')
      .reverse()
      .find((l) => l.trim().startsWith('{'));
    mod = JSON.parse(jsonLine ?? '{}');
  } catch (e) {
    console.error(
      '[ad-selectors] ❌ 无法加载 ad-selectors.ts：',
      String(e.stderr ?? e.message ?? e).slice(0, 300),
    );
    process.exitCode = 2;
    return;
  }

  const rules = Array.isArray(mod.rules) ? mod.rules : [];
  const prescreen = typeof mod.prescreen === 'string' ? mod.prescreen : '';
  const parts = new Set(
    prescreen
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (rules.length === 0) {
    problems.push({
      what: 'ALL_AD_RULES 为空或无法读取',
      why: '判据数据是这个检查的前提，读不到就不能给结论',
    });
  }

  // ── 规则 1：每条判据的叶子都必须在预筛中 ──
  for (const sel of rules) {
    const stripped = String(sel)
      .replace(/:has\([^)]*\)/g, '')
      .replace(/:not\([^)]*\)/g, '');
    const tokens = stripped.split(/\s+/).filter(Boolean);
    const leaf = tokens[tokens.length - 1] ?? '';
    if (!leaf) continue;
    if (!parts.has(leaf)) {
      problems.push({
        what: `判据 \`${sel}\` 的叶子 \`${leaf}\` 不在 JS 预筛里`,
        why:
          '元素**永远不会被扫描** → 从不被标记 → 永不隐藏，而 CSS 判据看起来完全正确。' +
          '2026-11-01 就是这样让「保留活动横幅」完全失效的（ADR 0031 实施期）',
      });
    }
  }

  // ── 规则 2：判据**声明**只能在允许的文件里 ──
  /**
   * ⚠️ 只抓「声明」，不抓「读取」。
   *
   * `ads.ts` 里有一行 `getPropertyValue('--pluma-ad-card')` —— 那是**读**这个变量
   * 来判定元素是否命中，完全合法。首版用裸字符串匹配把它误判成"又写了一份判据"。
   *
   * 声明形态只有一种：`--pluma-ad-card: 1;`（CSS 声明）。
   */
  const DECLARATION_RE = /--pluma-ad-card\s*:/;

  const files = [];
  for (const dir of SCAN_DIRS) files.push(...(await walk(dir)));

  for (const f of files) {
    if (ALLOWED_JUDGEMENT_FILES.has(f)) continue;
    const src = await readFile(join(ROOT, f), 'utf8');
    const masked = maskComments(src);
    if (DECLARATION_RE.test(masked)) {
      problems.push({
        what: `${f} 里出现了 \`--pluma-ad-card:\` 判据声明`,
        why:
          '判据选择器只许写在 ad-selectors.ts，由 prescreenSelector() 同源生成预筛。' +
          '在别处再写一份 → 预筛必然漏掉它 → 开关静默失效（2026-11-01 的真 bug）',
      });
    }
  }

  // ── 规则 3：关键回归项 ──
  for (const key of KEY_SELECTORS) {
    if (!parts.has(key)) {
      problems.push({
        what: `关键选择器 \`${key}\` 不在预筛中`,
        why:
          '这是「保留活动横幅」控制的活动横幅。2026-11-01 它曾因不在预筛里而完全无效，' +
          '本项是那次 bug 的固定回归断言',
      });
    }
  }

  if (problems.length === 0) {
    console.log(
      `[ad-selectors] ✅ ${rules.length} 条判据的叶子全部在预筛中（token ${parts.size} 个）· ` +
        `${KEY_SELECTORS.length} 个关键项齐全 · ${files.length} 个文件里无越界判据声明`,
    );
    return;
  }

  console.error(`\n[ad-selectors] ❌ 发现 ${problems.length} 处问题\n`);
  for (const p of problems) {
    console.error(`  ${p.what}`);
    console.error(`    ${p.why}\n`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(
    `[ad-selectors] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 2;
});
