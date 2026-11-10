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
 * node scripts/verify.mjs            # 跑全部（静态组与 vitest 并行）
 * node scripts/verify.mjs --fast     # 跳过 vitest（改了文档/脚本时够用）
 * node scripts/verify.mjs --changed  # 按 git 改动自动选档；判不出来退化为全量
 * node scripts/verify.mjs --help
 * ```
 *
 * ⚠️ 反例验证（"把关键判据改回去，测试必须变红"）不在本脚本里，它是**人做的判断**，
 *    操作步骤见 `docs/guides/methodology.md` §5 ⑤。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
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
  {
    // 2026-11-10 加：CSS 自定义属性写错名字**不会有任何运行时错误** ——
    // 浏览器安静地用 `var(--x, 兜底值)` 的兜底值，代码"看起来能用"，
    // 但日后改主题不会跟着变，而且没人会发现。
    // 真实踩过：`entrypoints/need-incognito/style.css` 用了 `--pluma-success` 与
    // `--pluma-warning-bg`，两个 token 在 tokens.css 里根本不存在。
    // `design` 那项只管"谁能 import @design/*"，管不到变量名。
    name: 'css-tokens',
    cmd: process.execPath,
    args: ['scripts/check-css-tokens.mjs'],
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
    // 2026-10-30 加：A 阶段先修"对 AGENTS.md 的引用指错位置"。
    // 实测抓到真实错误：docs/decisions/0011 与 0012 都写「§2 第 2 条 = 请求级代理，不切 cookie」，
    // 而 §2 是「先读什么」**没有编号条目**，那句实际在 §3 决策 2。
    // 之所以一直没发现：章节号 §2 是存在的，所以"章节存在性"检查会放行 ——
    // 错的是「第 2 条」这个条目级指向。本检查两级都查。
    name: 'doc-sections',
    cmd: process.execPath,
    args: ['scripts/check-doc-sections.mjs'],
    first: true,
  },
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
    // 2026-10-30 加：AGENTS-RULES.md §3 有一张「规则 → 机械保障」对照表，
    // 声称"某条规则有自动检查兜着"。**声称错了比没有表更糟** ——
    // 下一个人会以为有检查保障，于是放心违反。本项断言表里提到的检查名真实存在。
    name: 'rule-map',
    cmd: process.execPath,
    args: ['scripts/check-rule-map.mjs'],
    first: true,
  },
  {
    // 2026-10-30 加：AGENTS.md §4.1 有一份带 `[ ]` 复选框的「四个必读文件」清单，
    // 但**没有任何东西在勾它**。更糟的是：文件"存在"不代表"内容还对" ——
    // 例如 dnr.ts 的 rebuildRulesIfEnabled 被删了，只要没人 import，tsc 一声不吭，
    // 而 SW 启动自愈就静默失效了。本项查两级：文件存在 + 关键内容仍在。
    name: 'required-files',
    cmd: process.execPath,
    args: ['scripts/check-required-files.mjs'],
    first: true,
  },
  {
    // 2026-10-30 加：AGENTS.md §4.3 要求改 dnr.ts 就跑两个 DNR 脚本，
    // 但本脚本此前**只能打印提醒**（代跑会变成"看起来验过了"）→ 提醒容易被忽略，
    // 这条规则等于没有保障。现在 DNR 脚本跑完写凭据（脚本名+时间+dnr.ts 指纹），
    // 本项检查凭据是否覆盖当前改动：缺失或过期（改完又没重跑）都会红。
    name: 'dnr-regression',
    cmd: process.execPath,
    args: ['scripts/check-dnr-regression.mjs'],
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
  {
    // 2026-11-01 加：广告判据与 JS 预筛必须同源。
    //
    // 当时「保留活动横幅」**完全无效**，而三层代码各自看都"对"：
    //   1. CSS 判据 `.activity-m-v1 { --pluma-ad-card: 1 }` 语法正确 ✅
    //   2. 判据命中元素（`--pluma-ad-card` = "1"）✅
    //   3. 但元素**不在 JS 预筛里** → 从不被扫描 → 永不标记 → 永不隐藏 ❌
    //
    // 只有第三层断了，而 `tsc`、单测、当时的 `verify` 全都发现不了。
    // 根因是判据写在 `ads-css.ts`、预筛数据却在 `ad-selectors.ts` —— 两份独立来源。
    // 本项做**构造性断言**（每条判据的叶子都必须在预筛中），不是抽样。
    name: 'ad-selectors',
    cmd: process.execPath,
    args: ['scripts/check-ad-selectors.mjs'],
    first: true,
  },
  {
    // 单测项。**并行与否由 `vitest.config.ts` 的 `fileParallelism` 决定**（现为 true），
    // 这里不传 `--fileParallelism`，避免两处各写一份判据（改一处忘另一处必然漂移）。
    //
    // 曾经的风险（config 注释里记着原始判断）：并行 worker 写临时文件 EPERM
    // → 部分测试文件被**静默跳过**，只跑一半却显示通过。
    //
    // **那个结论靠两样东西撑着，缺一不可**：
    //   1. tests/ 下零写文件操作（只有 `readFile` / `readFileSync`）
    //   2. 本文件的 `assertTestTotals()` —— **每次**都断言「磁盘上的测试文件数 == vitest
    //      报告的文件数」且「用例数 > 0」。worker 一旦静默跳过，这里立刻变红。
    //      第 2 条才是保险：它让"现在的结论会不会过期"变成每次运行都重新验证的断言。
    //
    // 实测（2026-11-10）：串行 95.1s / 并行 13.5s，两种跑法都是 78 files / 1381 tests。
    name: 'test',
    cmd: binPath('vitest'),
    args: ['run'],
    first: false,
    slow: true,
  },
];

/**
 * ── 执行分组（2026-11-10 加：并行 + 增量）──────────────────────────────
 *
 * ## 为什么分组
 *
 * 改造前 20 项**串行**跑，实测 109–112s，其中 `test` 一项就占 89–93s（约 83%）。
 * 其余 19 项加起来只有约 15s，却排在 test 前面一份一份等。
 * 分组成三条**互不依赖**的流水线并行，墙面时间 ≈ 最慢那条（也就是 test）。
 *
 * ```
 *   G1 重型静态（三条互不依赖，并行；各自 first:true）
 *     typecheck | format | lint
 *   G2 静态检查组（原顺序，首个失败即中止）
 *     boundaries → messages → … → ad-selectors
 *   G3 单测组（独立，不与前两条抢"哪个先失败"的判定）
 *     test
 * ```
 *
 * ⚠️ **并行只改"怎么跑"，不改"跑什么"**：每组的命令行参数、退出码判据、
 *    `first`（失败即中止）语义全部原样保留。这里不新增、不删除任何检查项。
 *
 * ⚠️ **为什么 test 单独成组**：`test` 的 `first` 是 false（不中止别人），
 *    但若它和 `first:true` 的项在一个组里并行，`first` 的语义会变得不可预测
 *    （test 比 typecheck 先失败时该不该中止？）。拆成独立组后各自语义保持不变，
 *    且**任何一个组失败，整体都 exit 1** —— 见 `main()` 的汇总裁定。
 *
 * ⚠️ **为什么 typecheck / format / lint 单独并行**：它们各约 4.5–5.5s，
 *    且**互相不读对方的产物**（tsc 不读 prettier 结果，eslint 不读 tsc 输出），
 *    串行跑纯属白等约 10s。这三项任一失败仍然中止 G2（它就是原来的前置项语义）。
 */
const HEAVY_STATIC_GROUP = STEPS.filter((s) => ['typecheck', 'format', 'lint'].includes(s.name));
const CHECK_GROUP = STEPS.filter(
  (s) => !s.slow && !['typecheck', 'format', 'lint'].includes(s.name),
);
const TEST_GROUP = STEPS.filter((s) => s.slow);

/** 完整模式的分组。三组并行，任一组失败 → 整体 exit 1 */
const GROUPS = [
  { id: 'heavy', steps: HEAVY_STATIC_GROUP },
  { id: 'static', steps: CHECK_GROUP },
  { id: 'test', steps: TEST_GROUP },
];

/** 每项一句话说明。**项数不写死**：增删检查项时只改 STEPS，帮助文本自动跟上 */
const STEP_DOC = {
  typecheck: 'tsc --noEmit',
  format: 'prettier --check .',
  lint: 'eslint .',
  boundaries: 'core/shared 不许碰 chrome/window/document/fetch',
  messages: 'messages.ts ↔ background.ts 路由对齐（抓孤儿消息）',
  design: '只有 entrypoints/* 可以引用 @design/*',
  'css-tokens': 'var(--xxx) 引用的 CSS 变量必须在 tokens.css 或本文件里定义（防静默退回兜底值）',
  docs: '死链 + scripts/ 引用 + 篇幅上限 + 主文档章节连号',
  secrets: '测试账号标识 / 凭据形态 / 本机路径',
  patch:
    '响应体改写范围：PATCH_PATHS↔ADR 0013（会员字段）、PROGRESS_PATCH_PATHS↔ADR 0017（观看进度）',
  tools: 'AGENTS-TOOLS.md 与 scripts//poc/ 下每个脚本对账（防"工具没人记得"）',
  'adr-refs': '代码注释里的 ADR 编号必须指向真实存在的 ADR（知识索引不许断）',
  'doc-sections': '文档里「AGENTS.md §N」的章节与条目引用必须真实存在',
  'required-files': '§4.1 的四个必读文件存在，且关键导出/结构仍在',
  'dnr-regression': '改 dnr.ts 后两个 DNR 脚本的回归凭据齐全且未过期',
  'rule-map': '规则-保障对照表里提到的检查名必须真实存在（防止"假保障"）',
  'page-gate': '「是不是播放页」只许走 parsePlayPage()，路径字面量不许越界',
  'workflow-logs': 'Actions 日志：抓 set -x / printenv，其余靠人工审（AGENTS.md §4.3）',
  artifact: 'dist/*.zip 与源码一致：含图标、world:MAIN 入口、无 WAR、main-world.js 字节一致',
  'ad-selectors': '广告判据的叶子必须全部在 JS 预筛里（防"判据命中但元素从不被扫描"）',
  test: 'vitest run',
};

const TOTAL = STEPS.length;
const FAST_TOTAL = STEPS.filter((s) => !s.slow).length;
const ITEM_LINES = STEPS.map((s) => `  ${s.name.padEnd(14)} ${STEP_DOC[s.name] ?? ''}`).join('\n');

const HELP = `
Pluma 验收入口（不依赖 pnpm 在 PATH 里）

  node scripts/verify.mjs           跑全部 ${TOTAL} 项（约 30–50s，静态组与 test 并行）
  node scripts/verify.mjs --fast    跳过 vitest，${FAST_TOTAL} 项（约 15–25s，改文档时够用）
  node scripts/verify.mjs --changed 按 git 改动自动选档（见下）
  node scripts/verify.mjs --help    显示本帮助

本脚本覆盖的 ${TOTAL} 项（静态组内按下列顺序执行，test 与静态组并行）：
${ITEM_LINES}

⚠️ 上面的耗时是**区间不是承诺**：同一命令实测能差 20s 以上，取决于机器负载
   （2026-11-10 记录：完整 verify 多次实测落在 30–50s；改造前串行约 107–130s）。
   看单次数字请以脚本自己打印的耗时为准。

── --changed 的三档（改动判定不出来时一律退化为全量：宁可慢，不可漏）──

  只改 *.md                     → 等同 --fast，不跑 test
  只改 src/ entrypoints/ 的源码  → vitest related <改动文件>，只跑受影响的用例
  改到 scripts/ tests/ package.json / 锁定文件 /
       vitest.config / eslint.config / wxt.config / tsconfig /
       .github/workflows/** / 任何判不准的文件
                                → 退化为**全量**

  ⚠️ --changed 只是"少跑不相关的单测"，**任何检查项的判据都没有变**。
     交付前仍建议跑一次完整模式（AGENTS.md §8）。

  📌 related 档多跑一遍：为了让「防静默跳过」的断言仍有意义，related 档会先用
     JSON reporter 完整跑一次 related 当**基准尺子**，再跑第二次作为被检对象。
     两次的文件集合不一致 → 判红。所以 related 档耗时约是单次 related 的 2 倍
     （实测仍只有 3~7s）。**这不是浪费**：否则期望值只能取 vitest 自己报的数字，
     断言退化成 N === N，等于没设防。

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

function runStep(step, outBuf) {
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

    // 调用方可以传一个自己的缓冲区进来，用来在**跑的过程中**读部分输出
    // （并行模式下 "…… 仍在跑，最近输出" 那行靠它）。不传就自己开一个。
    const buf = outBuf ?? { stdout: '', stderr: '' };
    child.stdout.on('data', (d) => {
      buf.stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      buf.stderr += d.toString();
    });

    child.on('error', (err) => {
      resolve({
        ok: false,
        ms: Date.now() - started,
        out: `无法启动 ${rel}：${err.message}`,
        step,
        buf,
      });
    });

    child.on('close', (code) => {
      const out = `${buf.stdout}${buf.stderr}`.trim();
      resolve({ ok: code === 0, ms: Date.now() - started, out, step, code, buf });
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
 * `--changed` 的分类结果。
 *
 * `mode` 的三档，对应任务卡需求 A：
 * - `full`    退化为全量（判不出来 / 改到了会改变全局语义的文件）
 * - `static`  只跑静态组，**不跑 test**（只改了文档）
 * - `related` 跑静态组 + `vitest related <改动的源码文件>`（只改了几个源码文件）
 */
const MODE = { FULL: 'full', STATIC: 'static', RELATED: 'related' };

/** 改了这些就**退化为全量**：它们会改变"哪些测试存在"或"检查判据本身" */
const CONFIG_DIRS = new Set(['scripts', 'tests', 'poc', 'node_modules']);
const CONFIG_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'vitest.config.ts',
  'vite.config.ts',
  'tsconfig.json',
  'wxt.config.ts',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierignore',
  '.eslintignore',
]);
/** 扩展名 → 算"源码"。**只列 TS/JS 系**：`.css` / `.d.ts` 也算源码（有单测直接读它们） */
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css)$/i;

/**
 * 把改动文件列表分类成 `--changed` 的执行模式。
 *
 * ⚠️ **安全底线（任务卡红线 2）：任何判不出来的情况一律退化为全量。**
 *    下面每一个 `return MODE.FULL` 都是在说"我不确定，宁可慢"。
 *    **不要为了让它更"快"而放宽任何一条** —— 少跑一个断言比慢一万倍严重。
 *
 * @param {string[] | null} files `changedFiles()` 的结果；null = 没有任何改动或拿不到 git
 * @returns {{mode: string, reason: string, sourceFiles: string[], ignored: string[]}}
 */
function classifyChanged(files) {
  // 拿不到 git、或工作区干净 → 无从判断"改了哪些会影响测试的东西"，全量。
  if (!files || files.length === 0) {
    return {
      mode: MODE.FULL,
      reason: '拿不到改动列表（不是 git 仓库 / 工作区干净），无法判断 → 全量',
      sourceFiles: [],
      ignored: [],
    };
  }

  const sourceFiles = [];
  const ignored = [];

  for (const raw of files) {
    const f = raw.replace(/\\/g, '/'); // git 在 Windows 上给正斜杠，但防御性统一

    // ① 配置 / 检查逻辑 / 测试本身 → 全量。这一类任何一条命中就整体全量。
    const top = f.split('/')[0];
    if (CONFIG_FILES.has(f) || CONFIG_DIRS.has(top)) {
      return {
        mode: MODE.FULL,
        reason: `改到了 ${f}（配置 / 检查逻辑 / 测试本身），会影响"哪些测试该跑" → 全量`,
        sourceFiles: [],
        ignored: [],
      };
    }

    if (f.startsWith('.github/workflows/')) {
      return {
        mode: MODE.FULL,
        reason: `改到了 CI 工作流 ${f}，可能影响运行环境 → 全量`,
        sourceFiles: [],
        ignored: [],
      };
    }

    // ② 文档 → 不需要 test，静态组就够
    if (/\.(md|markdown)$/i.test(f)) {
      ignored.push(f);
      continue;
    }

    // ③ 源码（src/ entrypoints/ 及任何 TS/JS 文件）→ 进 related 候选
    const isSrcTree = f.startsWith('src/') || f.startsWith('entrypoints/');
    if (isSrcTree || SOURCE_EXT.test(f)) {
      // 但 test 目录下的源码已经在 ① 拦掉了
      if (f.startsWith('tests/')) {
        return {
          mode: MODE.FULL,
          reason: `改到了测试文件 ${f}（可能新增/删除用例）→ 全量`,
          sourceFiles: [],
          ignored: [],
        };
      }
      sourceFiles.push(f);
      continue;
    }

    // ④ 其他（图片、字体、LICENSE、.gitignore 等）：
    //    不可能是 test 的输入，但也说不准 —— **按重的走**。
    //    只有明确"文档类"才降到 static，其余一律全量。
    return {
      mode: MODE.FULL,
      reason: `改到了 ${f}（不是源码也不是文档，无法判断它是否是测试输入）→ 全量`,
      sourceFiles: [],
      ignored: [],
    };
  }

  if (sourceFiles.length === 0) {
    return {
      mode: MODE.STATIC,
      reason: `只改了文档（${ignored.length} 个 .md），不需要跑 test → 静态组`,
      sourceFiles: [],
      ignored,
    };
  }

  return {
    mode: MODE.RELATED,
    reason: `改了 ${sourceFiles.length} 个源码文件 → 只跑受影响的单测（vitest related）`,
    sourceFiles,
    ignored,
  };
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

/**
 * 单测"防静默跳过"闸门。
 *
 * ## 它防的是什么
 *
 * `vitest.config.ts` 原本用 `fileParallelism: false` 串行跑，理由是：
 * 「并行 worker 写临时文件会 EPERM，表现是**部分测试文件被静默跳过**
 * （只跑了一半却显示通过）」。
 *
 * 本仓库实测表明那个风险不成立（tests/ 里没有任何写文件的用例），于是改成并行以提速。
 * **但"不成立"是一条会过期的结论** —— 将来谁加一个写临时文件的测试，
 * 就可能重现"静默跳过 + 显示通过"这种最危险的失败形态。
 *
 * 所以这里把那个风险变成**每次都执行的断言**。
 *
 * ## 两档的不同期望值（2026-11-10 修：related 档原本恒假红）
 *
 * 期望值来自**谁**决定了该跟什么比：
 *
 * - **全量档**（`expected: undefined`）：本来就要跑 tests/ 下**全部**文件
 *   → 期望值 = `countTestFiles(tests/)`（磁盘实际个数）。
 * - **related 档**（`expected: number`）：`vitest related <文件>` 的语义就是**只跑子集**，
 *   用磁盘全量当期望值必然恒不相等 → 恒报"静默跳过"。
 *   **这不是门开松，是门焊死**；更糟的是使用者会因此开始无视 test 项的红灯。
 *   所以 related 档传入「本次实际被选中的文件数」作为期望值（来源见 `countRelatedFiles`）。
 *
 * ## 为什么 related 档的期望值不能靠"从输出里反推"
 *
 * 若拿 vitest 自己报的 `Test Files N passed (N)` 当期望值，断言就变成 `N === N`，
 * 永远成立 —— **等于没设防**。所以期望值必须来自**独立于本次运行**的来源。
 *
 * @param {string} out vitest 的完整输出
 * @param {number | undefined} expected 期望的测试文件数；undefined = 用磁盘全量
 * @returns {string | null} null = 通过；字符串 = 失败原因
 */
function assertTestTotals(out, expected) {
  // 全量档：期望值取磁盘上真实的测试文件数
  if (expected === undefined) {
    try {
      expected = countTestFiles(join(ROOT, 'tests'));
    } catch (err) {
      return `无法枚举 tests/ 下的测试文件，无法验证"有没有被静默跳过"：${err instanceof Error ? err.message : String(err)}`;
    }
    if (expected === 0) {
      return 'tests/ 下一个 *.test.ts 都没有 —— 说明用例被发现路径漏了（这本身就是失败）';
    }
  }

  // ⚠️ 取**最后一个**匹配，不是第一个（2026-11-10 修）。
  //
  // 为什么：vitest 的摘要打在输出**末尾**，而某个测试自己往 stdout 打印一行
  // `Test Files 78 passed (78)` 是完全可能的（比如测日志解析的用例）。用 `match()`
  // 取首个会让那行冒牌摘要抢在真实摘要之前被采信 → 断言被骗过。
  //
  // `matchAll` + 取末项：真实摘要永远在最后，所以末项才是真的。
  const filesMatches = [
    ...out.matchAll(/Test Files\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\((\d+)\))?/g),
  ];
  const testsMatches = [...out.matchAll(/Tests\s+(\d+)\s+passed(?:\s*\((\d+)\))?/g)];

  const filesMatch = filesMatches.at(-1);
  const testsMatch = testsMatches.at(-1);

  if (!filesMatch) return '在 vitest 输出里找不到「Test Files … passed」行，无法确认跑了多少文件';

  const filesRan = Number(filesMatch[2]);
  const testsRan = testsMatch ? Number(testsMatch[1]) : 0;

  if (filesRan !== expected) {
    // `expected < 0` = 基准尺子自己跑挂了（`countRelatedFiles` 返回 -1），不是"有文件被跳过"。
    // 这种情形下断言仍然红（fail-closed），但文案必须指向真正的排查方向，
    // 否则会把人引去"查哪个测试文件被静默跳过"——那是错的方向。
    if (expected < 0) {
      return (
        `⚠️ related 基准跑失败：没能确定「本该跑几个文件」（实跑 ${filesRan} 个）。\n` +
        '   这不是"有测试文件被静默跳过"，而是**基准尺子本身没拿到结果** ——\n' +
        '   先去看 `vitest related …` 那一遍为什么失败（语法？导入？vitest 启动？）。\n' +
        '   **本断言在拿不到期望值时一律判红（fail-closed）**：宁可挡住提交，也不放行无法确认的结果。'
      );
    }
    const hint =
      expected === countTestFilesSafe()
        ? '   这正是 vitest.config.ts 里 `fileParallelism` 注释描述的那个失败形态\n' +
          '   （worker EPERM → 文件被静默跳过 → 只跑一半却显示通过）。\n' +
          '   **不要忽略它，也不要调低这个断言** —— 去查是哪个文件被跳过。'
        : `   期望 ${expected} 个（related 选中的那几个），实际跑了 ${filesRan} 个。\n` +
          '   说明 `vitest related` 选中的文件里有人被静默跳过了（并行 worker 的经典失败形态）。\n' +
          '   **不要忽略它，也不要调低这个断言。**';
    return `⚠️ 静默跳过：期望 ${expected} 个测试文件，vitest 只报了 ${filesRan} 个。\n${hint}`;
  }

  if (testsRan === 0) {
    return `vitest 报 ${filesRan} 个文件通过，但执行用例数是 0 —— 这不叫绿`;
  }

  return null;
}

/** 尽力数磁盘测试文件；出错返回 -1（只用于在错误信息里区分"是全量档还是 related 档"） */
function countTestFilesSafe() {
  try {
    return countTestFiles(join(ROOT, 'tests'));
  } catch {
    return -1;
  }
}

/**
 * related 模式下，独立求出「`vitest related <files>` 应该跑几个测试文件」。
 *
 * ## 为什么需要独立来源（这是本函数存在的全部理由）
 *
 * 期望值**不能**从被测那次运行的输出里读 —— 那样断言退化成 `N === N`，永远成立，
 * 等于没设防（verifier-2 明确把这条定为红线：related 档「可以比全量弱，不能弱到没有」）。
 *
 * ## 怎么求：**先完整跑一次** related（带 JSON reporter），拿它实跑的文件清单当基准
 *
 * 即 related 档实际跑**两遍**：
 *   第一遍（本函数）当"基准尺子"，第二遍（`test` 项）才是被检对象。
 *   两边都是同样的 `vitest related <同一批文件>`，正常情况下文件集合必定一致；
 *   若第二遍比第一遍少，说明有文件被静默跳过了 → 判红。
 *
 * ⚠️ **实测过做不到更便宜的做法**（2026-11-10）：
 *   - `--shard=1/200` 只跑 1 个文件，拿不到全集；JSON 的 `numTotalTestSuites`
 *     是**测试套件数**（25）不是文件数（3），拿它当期望值必然误判。
 *   - vitest 没有 dry-run / `--filesOnly` 列表模式。
 *   - 没有公开 API 能静态算出 related 集合。
 *   所以只能实跑一遍。成本实测 **约 3.2s**（related 子集本来就小），可接受。
 *
 * @param {string[]} sourceFiles 改动的源码文件（相对仓库根）
 * @returns {Promise<number>} related 应跑的测试文件数；-1 = 求不出来（调用方保守处理）
 */
async function countRelatedFiles(sourceFiles) {
  const outFile = join(ROOT, '.tmp', 'verify-related-baseline.json');

  const probe = {
    name: 'related-baseline',
    cmd: binPath('vitest'),
    args: ['related', ...sourceFiles, '--run', '--reporter=json', `--outputFile=${outFile}`],
    first: false,
  };

  try {
    mkdirSync(join(ROOT, '.tmp'), { recursive: true });
    const r = await runStep(probe);

    // related 一个都没选中 → vitest 打印 "No test files found" 且不写 JSON → 就是 0 个
    if (!existsSync(outFile)) {
      return r.out.includes('No test files found') ? 0 : -1;
    }

    const report = JSON.parse(readFileSync(outFile, 'utf8'));
    const suites = Array.isArray(report.testResults) ? report.testResults : [];
    const files = new Set(suites.map((t) => t?.name).filter(Boolean));

    // 基准那次自己就失败了 → 拿它的文件数当期望值不可靠，交给调用方保守处理
    if (Number(report.numFailedTestSuites) > 0) return -1;
    return files.size;
  } catch {
    return -1;
  } finally {
    try {
      if (existsSync(outFile)) unlinkSync(outFile);
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

/**
 * 递归数目录下 `*.test.ts` 的个数。
 *
 * @param {string} dir
 * @returns {number}
 */
function countTestFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      n += countTestFiles(full);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      n += 1;
    }
  }
  return n;
}

/**
 * 跑一条"流水线"：组内**串行**，语义与改造前完全一致（`first: true` 失败即中止本组）。
 *
 * @param {Array} steps
 * @param {(step: object) => void} onStart
 * @param {(r: object) => void} onDone
 * @param {number | undefined} testExpected
 *   `test` 项的期望文件数。undefined = 全量档（用磁盘全量）；
 *   数字 = related 档（用 `countRelatedFiles()` 独立求出的 related 集合大小）。
 * @returns {Promise<{results: object[], aborted: object | null, groupMs: number}>}
 */
async function runGroup(steps, onStart, onDone, testExpected) {
  const started = Date.now();
  const results = [];
  for (const step of steps) {
    onStart(step);
    const r = await runStep(step);

    // 单测专有闸门：退出码 0 还不够，必须证明**没有被静默跳过**（见 assertTestTotals）。
    //
    // ⚠️ 只在 `r.ok` 时跑：vitest 已经失败了就把它的失败详情原样露出来，
    //    不要用"静默跳过"的判定去覆盖一个**真错**（2026-11-10 修：
    //    related 档曾有假红盖住真回归信息的问题）。
    if (step.name === 'test' && r.ok) {
      const problem = assertTestTotals(r.out, testExpected);
      if (problem) {
        r.ok = false;
        r.out = problem;
      }
    }

    results.push(r);
    onDone(r);
    if (!r.ok && step.first) {
      return { results, aborted: r, groupMs: Date.now() - started };
    }
  }
  return { results, aborted: null, groupMs: Date.now() - started };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const fast = argv.includes('--fast');
  const changed = argv.includes('--changed');

  if (fast && changed) {
    console.error('[verify] ❌ --fast 与 --changed 不能同时用：--changed 已经自己决定跑不跑 test');
    process.exitCode = 2;
    return;
  }

  if (!existsSync(BIN)) {
    console.error(`[verify] ❌ 找不到 ${BIN}，先装依赖（pnpm install）`);
    process.exitCode = 2;
    return;
  }

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

  // ── 决定要跑什么 ──
  /** @type {Array<{id: string, steps: Array}>} */
  let groups;
  let modeLabel = '';
  /** `test` 项的期望文件数：undefined = 全量档（磁盘全量）；数字 = related 档 */
  let relatedExpected;

  /** 不带 test 的三组（heavy + static）—— `--fast` / `--changed` 的纯静态档都用它 */
  const NO_TEST_GROUPS = [
    { id: 'heavy', steps: HEAVY_STATIC_GROUP },
    { id: 'static', steps: CHECK_GROUP },
  ];

  if (fast) {
    groups = NO_TEST_GROUPS;
    modeLabel = '--fast：已跳过 vitest';
  } else if (changed) {
    const cls = classifyChanged(changedFiles());
    console.log(`[verify] --changed 判定：${cls.reason}`);
    if (cls.mode === MODE.STATIC) {
      groups = NO_TEST_GROUPS;
      modeLabel = '--changed：只改文档，跳过 vitest';
    } else if (cls.mode === MODE.RELATED) {
      // ⚠️ `vitest related` 只跑**能静态追踪到这些文件**的用例。
      //    它比全量窄，但在"只动了实现、没动测试"的场景下是安全的。
      //
      // ⚠️ 期望值必须独立求（`countRelatedFiles`），**不能**拿 vitest 自己报的 N 当期望值
      //    —— 那会退化成 `N === N`，等于没设防（见 assertTestTotals 的注释）。
      relatedExpected = await countRelatedFiles(cls.sourceFiles);
      groups = [
        ...NO_TEST_GROUPS,
        {
          id: 'test',
          steps: [
            {
              ...TEST_GROUP[0],
              args: ['related', ...cls.sourceFiles, '--run'],
            },
          ],
        },
      ];
      modeLabel = '--changed：vitest related';
    } else {
      groups = GROUPS;
      modeLabel = '--changed：退化为全量';
    }
  } else {
    groups = GROUPS;
  }

  const total = groups.reduce((a, g) => a + g.steps.length, 0);
  const parallel = groups.length > 1;
  console.log(`[verify] 共 ${total} 项${modeLabel ? `（${modeLabel}）` : ''}\n`);

  // ── 并行跑各分组 ──
  //
  // ⚠️ **不消耗失败**：每条流水线自己收集结果，最后**统一**汇总。
  //    任何一组失败 → `failed.length > 0` → exit 1。
  //    这里用 `Promise.allSettled` 而不是 `Promise.all`：
  //    后者在第一个 reject 时就会丢掉其余结果，正是"吃掉失败"的经典写法。
  const allResults = [];
  const abortedGroups = [];
  const started = Date.now();

  const runners = groups.map((g) =>
    runGroup(
      g.steps,
      (step) => {
        if (!parallel) {
          process.stdout.write(`  ${pad(step.name, 12)} 跑…`);
        } else {
          // 并行模式下不同流水线的日志会交错，所以每行前面带组名
          process.stdout.write(`  [${g.id}] ${pad(step.name, 12)} 跑…\n`);
        }
      },
      (r) => {
        if (!parallel) {
          // 串行：用 \r 覆盖"跑…"，跑完写终态（与改造前一致）
          process.stdout.write(
            `\r  ${pad(r.step.name, 12)} ${r.ok ? '✅' : '❌'} ${pad(`${(r.ms / 1000).toFixed(1)}s`, 8)}`,
          );
        } else {
          console.log(
            `  [${g.id}] ${pad(r.step.name, 12)} ${r.ok ? '✅' : '❌'} ${pad(`${(r.ms / 1000).toFixed(1)}s`, 8)}`,
          );
        }

        if (!r.ok) {
          console.log('');
          // 失败时把输出完整打出来——被截断的报错等于没有报错
          if (r.out) {
            console.log(`\n───── ${r.step.name} 输出 ─────`);
            console.log(r.out);
            console.log('─'.repeat(30) + '\n');
          }
          if (r.step.first) {
            const others = parallel ? '（另一条流水线仍在跑，不中止）' : '';
            console.log(
              `[verify] ⛔ ${r.step.name} 是前置项，本组后续检查已跳过（结果无意义）${others}`,
            );
          }
        } else {
          console.log('');
        }
      },
      // 只有 test 组需要期望值；其余组传 undefined（它们的 step 名不会匹配 'test'）
      g.id === 'test' ? relatedExpected : undefined,
    ).then((res) => {
      allResults.push(...res.results.map((x) => ({ ...x, group: g.id })));
      if (res.aborted) abortedGroups.push(g.id);
      return res;
    }),
  );

  const settled = await Promise.allSettled(runners);
  const wallMs = Date.now() - started;

  // `Promise.allSettled` 里若真有 rejected（脚本自身挂掉），也必须算失败
  const runnerErrors = settled.filter((s) => s.status === 'rejected');
  for (const e of runnerErrors) {
    console.error(`[verify] ❌ 流水线自身出错：${e.reason}`);
  }

  const failed = allResults.filter((r) => !r.ok);
  const sumMs = allResults.reduce((a, r) => a + r.ms, 0);

  console.log('');
  if (failed.length === 0 && runnerErrors.length === 0) {
    const parallelNote = parallel
      ? `，并行墙面 ${(wallMs / 1000).toFixed(1)}s，串行合计 ${(sumMs / 1000).toFixed(1)}s`
      : '';
    console.log(
      `[verify] ✅ ${allResults.length} 项全绿（共 ${(wallMs / 1000).toFixed(1)}s${parallelNote}）`,
    );
    return;
  }

  if (failed.length > 0) {
    console.log(
      `[verify] ❌ ${failed.length}/${allResults.length} 项未通过：${failed.map((f) => f.step.name).join(', ')}`,
    );
    if (failed.some((f) => f.step.name === 'format')) {
      console.log('[verify]     format 挂了就跑 `node_modules/.bin/prettier --write .`，不要手改');
    }
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[verify] 脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
