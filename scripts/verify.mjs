#!/usr/bin/env node
/**
 * 验收入口 —— **唯一**的检查串联点，不依赖 pnpm 在 PATH 里。
 *
 * ## 为什么需要这个脚本
 *
 * 直接写 `pnpm verify` 时，在 Git Bash / PowerShell 里都可能报 `command not found`。
 * 结果是**谁想跑验收，都得先知道"要用 ./node_modules/.bin/"这个不成文的约定**。
 * 换机器、换 shell、换 Agent 平台后这个知识必然丢失，然后就少跑一步——**而且没有任何提示**。
 *
 * 所以检查项只在这里定义一次：`package.json` 的 `verify` 直接转调本脚本，
 * 不再自己列一遍命令（两处各写一份必然漂移——曾经就是这样漏掉了 secrets 与 patch 两项）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify.mjs            # 跑全部
 * node scripts/verify.mjs --fast     # 跳过 vitest（改了文档/脚本时够用）
 * node scripts/verify.mjs --help
 * ```
 *
 * ⚠️ 反例验证（"把关键判据改回去，测试必须变红"）不在本脚本里，它是**人做的判断**，
 *    操作步骤见 `docs/guides/methodology.md` §5 ⑤。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 工具链：用 node_modules/.bin 下的相对路径，绕开 PATH 与 pnpm 依赖 */
const BIN = join(ROOT, 'node_modules', '.bin');

/**
 * 定位 node_modules/.bin 下的可执行文件。
 *
 * ⚠️ **Windows 上必须选 `.cmd`。** `node_modules/.bin/tsc` 是没有扩展名的
 * **POSIX shell 脚本**，Windows 下 `spawn` 它会直接 ENOENT
 * （2026-10-26 实测：`spawn D:\...\node_modules\.bin\tsc ENOENT`）。
 * npm/pnpm 在 Windows 下同时生成 `.cmd` / `.ps1` / 无扩展名三份，`.cmd` 才是能 spawn 的那个。
 *
 * @param {string} name 命令名（如 'tsc'）
 * @returns {string} 绝对路径
 */
function binPath(name) {
  return process.platform === 'win32' ? join(BIN, `${name}.cmd`) : join(BIN, name);
}

/** 按顺序执行的检查项。first=true 表示失败即中止（后面的结果没有意义） */
const STEPS = [
  { name: 'typecheck', cmd: binPath('tsc'), args: ['--noEmit'], first: true },
  { name: 'format', cmd: binPath('prettier'), args: ['--check', '.'], first: false },
  { name: 'lint', cmd: binPath('eslint'), args: ['.'], first: false },
  { name: 'boundaries', cmd: binPath('tsx'), args: ['scripts/check-boundaries.ts'], first: true },
  { name: 'messages', cmd: process.execPath, args: ['scripts/check-messages.mjs'], first: true },
  {
    name: 'design',
    cmd: process.execPath,
    args: ['scripts/check-design-imports.mjs'],
    first: true,
  },
  { name: 'docs', cmd: process.execPath, args: ['scripts/check-docs.mjs'], first: true },
  {
    // 2026-10-27 加：发布前才发现测试账号 mid 散在 11 个文件里。
    // 凭据检查当时做了，mid 没想到 —— 这类"想不起来要查"的事必须机器化。
    name: 'secrets',
    cmd: process.execPath,
    args: ['scripts/check-secrets.mjs'],
    first: true,
  },
  { name: 'patch', cmd: process.execPath, args: ['scripts/check-patch-scope.mjs'], first: true },
  {
    // 2026-10-30 加：代码里有 200+ 处注释写着「见 ADR 0020」——它们是**知识索引**，
    // 而 ADR 会被重新编号/合并/作废，**没有任何东西在检查这些编号还在不在**。
    // 失效的后果比"没有引用"更糟：编号被复用后会指向**另一份** ADR，
    // 读者读到的是错的理由。（同类失败已发生：ADR 0030 初稿把 pgcPatched 归错了模块。）
    name: 'adr-refs',
    cmd: process.execPath,
    args: ['scripts/check-adr-refs.mjs'],
    first: true,
  },
  {
    // 2026-10-30 加：`reload-extension.mjs`（能自动重载扩展）在 AGENTS.md 里一次都没被提到，
    // 结果团队里没人记得它存在，每次改完 src/ 都手工点「重新加载」。
    // 根因不是文档太长，是**清单不完整**，而且没有任何机制会提示"你漏登记了一个工具"。
    // 现在 AGENTS-TOOLS.md 是脚本清单的唯一权威位置，本项断言两者一致。
    name: 'tools',
    cmd: process.execPath,
    args: ['scripts/check-tools.mjs'],
    first: true,
  },
  {
    // 2026-10-29 加：审查发现 popup 与 tabs.handler 各自写着 /video/ 正则，
    // 而项目早有 parsePlayPage()（同时认 /video/ 与 /bangumi/play/）。
    // 后果是番剧页 popup 谎报「未生效」、§2.3 画质对比永不显示 ——
    // 而 tsc 不报错、571 个单测全绿、本脚本 11 项全绿。判据有测试，接线没有。
    name: 'page-gate',
    cmd: process.execPath,
    args: ['scripts/check-page-gate.mjs'],
    first: true,
  },
  {
    // 2026-10-27 加：secrets 查的是文件内容，泄露却发生在运行时打印。
    // 诊断步骤把 getUpdates 的完整响应打进公开日志，secrets 全绿也拦不住。
    // 这里只抓 100% 有害的写法（set -x / printenv），其余靠 AGENTS.md §4.3 人工审。
    name: 'workflow-logs',
    cmd: process.execPath,
    args: ['scripts/check-workflow-logs.mjs'],
    first: true,
  },
  {
    // 2026-10-29 加：本脚本 12 项全绿的 3 天里，`dist/pluma-0.9.0.zip` 一直缺图标、
    // 缺 world:'MAIN' 入口、带着已废弃的 web_accessible_resources ——
    // 也就是说**用户装到的扩展里主世界 hook 根本没跑**。
    // 上面所有检查看的都是源码，没有一项看产物（B-01 / B-08）。
    // 没有 zip 时本项跳过（dist/ 是本地目录），有 zip 才断言。
    name: 'artifact',
    cmd: process.execPath,
    args: ['scripts/check-artifact.mjs'],
    first: true,
  },
  { name: 'test', cmd: binPath('vitest'), args: ['run'], first: false, slow: true },
];

/** 每项一句话说明。**项数不写死**：增删检查项时只改 STEPS，帮助文本自动跟上 */
const STEP_DOC = {
  typecheck: 'tsc --noEmit',
  format: 'prettier --check .',
  lint: 'eslint .',
  boundaries: 'core/shared 不许碰 chrome/window/document/fetch',
  messages: 'messages.ts ↔ background.ts 路由对齐（抓孤儿消息）',
  design: '只有 entrypoints/* 可以引用 @design/*',
  docs: '死链 + scripts/ 引用 + 篇幅上限 + 主文档章节连号',
  secrets: '测试账号标识 / 凭据形态 / 本机路径',
  patch:
    '响应体改写范围：PATCH_PATHS↔ADR 0013（会员字段）、PROGRESS_PATCH_PATHS↔ADR 0017（观看进度）',
  tools: 'AGENTS-TOOLS.md 与 scripts//poc/ 下每个脚本对账（防"工具没人记得"）',
  'adr-refs': '代码注释里的 ADR 编号必须指向真实存在的 ADR（知识索引不许断）',
  'page-gate': '「是不是播放页」只许走 parsePlayPage()，路径字面量不许越界',
  'workflow-logs': 'Actions 日志：抓 set -x / printenv，其余靠人工审（AGENTS.md §4.3）',
  artifact: 'dist/*.zip 与源码一致：含图标、world:MAIN 入口、无 WAR、main-world.js 字节一致',
  test: 'vitest run',
};

const TOTAL = STEPS.length;
const FAST_TOTAL = STEPS.filter((s) => !s.slow).length;
const ITEM_LINES = STEPS.map((s) => `  ${s.name.padEnd(14)} ${STEP_DOC[s.name] ?? ''}`).join('\n');

const HELP = `
Pluma 验收入口（不依赖 pnpm 在 PATH 里）

  node scripts/verify.mjs           跑全部 ${TOTAL} 项（约 45s）
  node scripts/verify.mjs --fast    跳过 vitest，${FAST_TOTAL} 项（约 20s，改文档/脚本时够用）
  node scripts/verify.mjs --help    显示本帮助

本脚本覆盖的 ${TOTAL} 项（顺序执行）：
${ITEM_LINES}

═══════════════════════════════════════════════════════════════
⚠️ 本脚本**不等于**"全部自检"。另有两档它跑不了，必须单独做：
═══════════════════════════════════════════════════════════════

【第 2 档】DNR 真实浏览器回归 —— 改了 dnr.ts 就必须跑

  node poc/verify/run-q2-auto.cjs        （约 3 分钟）

  为什么不在本脚本里：它要启动真实 Edge、加载独立扩展、跑 180 并发。
  塞进来会让每次交付都等 3 分钟，然后所有人开始用 --no-verify 绕过，
  最后连上面这些也没人跑。所以改为**本脚本主动提醒**：
  检测到 diff 里有 src/platform/http/dnr.ts 就打印警告（见 AGENTS.md §4.3 路由表）。

  ⚠️ 2026-10-30 实测校正：这里原写「约 10 分钟」，与 AGENTS.md §4.3 和本文件
  路由表提示（都写 3 分钟）矛盾。实跑一遍：**全程约 3 分 17 秒**，
  其中 4 个策略的测试本体只占 **约 15 秒**，其余约 3 分钟是启动浏览器 +
  临时 profile + 收尾。**只看测试本体的耗时会严重低估**——这是最容易犯的误判。

【第 3 档】反例验证 —— 无法自动化，只能靠人

  规则：把被修的关键判据改回旧实现 → 相关测试必须变红 → 恢复 → 必须全绿。
  为什么不能自动化：脚本无法判断"你改回去的那个判断是不是关键的"。
  操作步骤见 docs/guides/methodology.md §5 ⑤（这里不复述，避免第二份漂移）。

⇒ 一句话：本脚本全绿只说明"静态检查 + 单测过了"，
  不代表"改 dnr.ts 的回归跑过了"、更不代表"做过反例验证"。

退出码：0 全绿｜1 有检查未通过｜2 脚本自身出错
`.trimStart();

/**
 * Windows 下带空格的路径必须自己加引号，否则 `shell: true` 会把 `D:\Projects\My App\tsc.cmd` 拆开。
 *
 * 本项目路径 `D:\Projects\Pluma` 恰好没空格，但 `git worktree add ../Pluma-feat-x` 或
 * 换到 `C:\Users\某 人\…` 就会出现，所以现在就处理掉。
 *
 * @param {string} s
 * @returns {string}
 */
function quoteIfNeeded(s) {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function runStep(step) {
  return new Promise((resolve) => {
    const rel = step.cmd.startsWith(ROOT) ? step.cmd.slice(ROOT.length + 1) : step.cmd;
    const started = Date.now();

    // ⚠️ Windows 上 `.cmd` 无法被 shell:false 的 spawn 直接执行（实测 EINVAL）。
    //    必须 shell:true。而 shell:true 下参数要自己拼，所以统一走 command 字符串，
    //    并对每个参数加引号 —— 本项目参数里没有空格，但一次性写对，免得以后踩。
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(step.cmd);
    const command = useShell
      ? [quoteIfNeeded(step.cmd), ...step.args.map(quoteIfNeeded)].join(' ')
      : step.cmd;

    const child = useShell
      ? spawn(command, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      : spawn(command, step.args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: false });

    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });

    child.on('error', (err) => {
      resolve({
        ok: false,
        ms: Date.now() - started,
        out: `无法启动 ${rel}：${err.message}`,
        step,
      });
    });

    child.on('close', (code) => {
      resolve({ ok: code === 0, ms: Date.now() - started, out: out.trim(), step, code });
    });
  });
}

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * 取本次改动涉及的文件（含未提交 + 未跟踪）。
 *
 * 拿不到 git 时返回 null —— verify 不该因为"不是 git 仓库"而失败。
 *
 * @returns {string[] | null}
 */
function changedFiles() {
  const run = (args) => {
    try {
      const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
      if (r.status !== 0) return '';
      return r.stdout ?? '';
    } catch {
      return '';
    }
  };
  const tracked = run(['diff', '--name-only', 'HEAD']).trim();
  const untracked = run(['ls-files', '--others', '--exclude-standard']).trim();
  const all = `${tracked}\n${untracked}`
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return all.length > 0 ? [...new Set(all)] : null;
}

/**
 * AGENTS.md §4.3 里**脚本不能代跑、但必须提醒**的项。
 *
 * ⚠️ 能自动跑的检查已经在 STEPS 里（check-messages / check-design / check-docs）。
 * 这里只放"跑不了但忘了会出事"的，重复提醒会让人不再读提示。
 *
 * @returns {Array<{signal: string, action: string}>}
 */
function detectRouteWarnings() {
  const files = changedFiles();
  if (!files) return [];

  const out = [];
  const hit = (p) => files.includes(p);

  if (hit('src/platform/http/dnr.ts')) {
    out.push({
      signal: 'src/platform/http/dnr.ts 被改动',
      action:
        '必须重跑 `node poc/verify/run-q2-auto.cjs`（并发安全，约 3 分钟）**和** `node poc/verify/dnr-disable-clears-tab-rules.cjs`（关开关后两类规则清零，约 15 秒）。**两个都不需要登录态**；单测测不到 DNR 行为（AGENTS.md §5.4），不跑等于没验。',
    });
  }

  if (hit('src/content/main-world.js')) {
    out.push({
      signal: 'src/content/main-world.js 被改动',
      action:
        '`node --check src/content/main-world.js`；若涉及轨道判定/角标，必须向用户要一次真机日志（自动化拿不到登录态 + 调试端口）。',
    });
  }

  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const fast = argv.includes('--fast');

  if (!existsSync(BIN)) {
    console.error(`[verify] ❌ 找不到 ${BIN}，先装依赖（pnpm install）`);
    process.exitCode = 2;
    return;
  }

  const steps = fast ? STEPS.filter((s) => !s.slow) : STEPS;

  // ── 路由提醒（AGENTS.md §4.3）──
  // 有些检查**不能**放在这里自动跑：最典型的是 dnr.ts 的 Q2 回归，
  // 它要启动真实浏览器，属于用户环境操作，脚本代跑会变成"看起来验过了"。
  // 所以这里只做提醒 —— 让"忘了跑"这件事至少有一次可见的提示。
  const warnings = detectRouteWarnings();
  if (warnings.length > 0) {
    console.log('[verify] ⚠️  这次改动命中了 AGENTS.md §4.3 路由表：\n');
    for (const w of warnings) {
      console.log(`  ${w.signal}`);
      console.log(`    → ${w.action}\n`);
    }
  }

  console.log(`[verify] 共 ${steps.length} 项${fast ? '（--fast：已跳过 vitest）' : ''}\n`);

  const results = [];
  for (const step of steps) {
    process.stdout.write(`  ${pad(step.name, 12)} 跑…`);
    // 用 \r 覆盖"跑…"，跑完写终态
    const r = await runStep(step);
    results.push(r);

    const mark = r.ok ? '✅' : '❌';
    const time = `${(r.ms / 1000).toFixed(1)}s`;
    process.stdout.write(`\r  ${pad(step.name, 12)} ${mark} ${pad(time, 8)}`);

    if (!r.ok) {
      console.log('');
      // 失败时把输出完整打出来——被截断的报错等于没有报错
      if (r.out) {
        console.log(`\n───── ${step.name} 输出 ─────`);
        console.log(r.out);
        console.log('─'.repeat(30) + '\n');
      }
      if (step.first) {
        console.log(`[verify] ⛔ ${step.name} 是前置项，后续检查已跳过（结果无意义）`);
        process.exitCode = 1;
        return;
      }
    } else {
      console.log('');
    }
  }

  const failed = results.filter((r) => !r.ok);
  const totalMs = results.reduce((a, r) => a + r.ms, 0);

  console.log('');
  if (failed.length === 0) {
    console.log(`[verify] ✅ ${results.length} 项全绿（共 ${(totalMs / 1000).toFixed(1)}s）`);
    return;
  }

  console.log(
    `[verify] ❌ ${failed.length}/${results.length} 项未通过：${failed.map((f) => f.step.name).join(', ')}`,
  );
  if (failed.some((f) => f.step.name === 'format')) {
    console.log('[verify]     format 挂了就跑 `node_modules/.bin/prettier --write .`，不要手改');
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[verify] 脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
