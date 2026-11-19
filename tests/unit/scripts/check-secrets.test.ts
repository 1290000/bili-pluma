// @vitest-environment node

/**
 * `scripts/check-secrets.mjs` 的**判据自检**（2026-11-19）。
 *
 * ## 为什么这个文件非有不可
 *
 * 2026-11-19 发 1.4.0 时发现：**4 个文件、78 处完整 `upsig` 签名已经在公开仓库里
 * 躺了 25 天**，而 `check-secrets.mjs` 每次都打 `✅ 未发现测试账号标识或凭据`。
 *
 * 原因有三层，每一层都是"检查器自己是坏的，但它的输出看起来像好的"：
 *
 * | # | 缺陷 | 表现 |
 * | --- | --- | --- |
 * | 1 | 完全不认 `upsig` | 未知形态的凭据 = 不存在 |
 * | 2 | `SKIP_PATH` 显式豁免 `bg-ssr.json` / `bg.html` | **已知有问题的文件反被保护** |
 * | 3 | `--all` 用 `--exclude-standard` | 被 gitignore 的抓包目录**根本不在扫描范围** |
 *
 * 三条缺陷没有一条会报错。它们在代码里"看起来是对的"——
 * 所以本文件不测"脚本能跑"，测的是**每一条判据真的会红**。
 *
 * ## 做法
 *
 * 沙盒里造文件 + 跑真脚本（`cwd` = 沙盒，脚本的 ROOT 就是沙盒），
 * 与 `check-patch-scope.test.ts` 同一套方法：**测真 CLI 的退出码与输出原文**，
 * 不把逻辑抄一份进测试（抄一份只能证明抄得像）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const SCRIPT = join(REPO, 'scripts/check-secrets.mjs');

/** 32 位 hex，形态与实测的真签名一致（实测 98 处全是 32 位） */
const REAL_SIG = '4a03cb8f25edb2a1c7e40d9f6b8135ae';

let box = '';

afterEach(() => {
  if (box !== '') rmSync(box, { recursive: true, force: true });
  box = '';
});

/** 建沙盒并写入给定文件（相对路径 → 内容） */
function sandbox(files: Record<string, string>): string {
  box = mkdtempSync(join(tmpdir(), 'pluma-secrets-'));
  // 脚本会调 git；给个空仓，避免继承外层仓库
  try {
    execFileSync('git', ['init', '-q'], { cwd: box, stdio: 'pipe' });
  } catch {
    /* 沙盒里 git 不可用也不影响被测逻辑 */
  }
  for (const [rel, content] of Object.entries(files)) {
    const dst = join(box, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, content, 'utf8');
  }
  return box;
}

function runIn(dir: string, args: string[] = []): { status: number; out: string } {
  /**
   * 结果合并 stdout + stderr。
   *
   * `--history` 的进度行（"增量扫 …"/"全量扫 …"）走 stderr，结论走 stdout ——
   * 只看 stdout 会漏掉"它到底扫了多大范围"这个关键信息，
   * 而增量水印的正确性恰恰体现在那句话上。
   */
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 把沙盒里的文件纳入版本控制（「已跟踪文件」模式靠它） */
function track(dir: string, rels: string[]): void {
  execFileSync('git', ['add', '-f', ...rels], { cwd: dir, stdio: 'pipe' });
}

describe('check-secrets：取流签名判据（2026-11-19 补，事故驱动）', () => {
  it('★ 现状：仓库自身零误报（文档里的截断示例不该被报）', () => {
    /**
     * 回归基线：**判据加得过宽会把这个检查变成噪音**，噪音迟早被人 `--no-verify` 掉。
     * 仓库里有合法的示例（`upsig=7baa0aee…`）与测试桩（`upsig=SECRETSIG`），
     * 它们必须继续放过 —— 16 位门槛就是为这个留的。
     */
    const { status, out } = runIn(REPO);
    expect(status).toBe(0);
    expect(out).toContain('✅ 已跟踪文件未发现测试账号标识或凭据');
  });

  it('⛔ 已跟踪文件里的完整签名 → 红，且点名 upsig', () => {
    const dir = sandbox({
      'poc/probe/capture.json': `{"url":"https://x.bilivideo.com/v.m4s?upsig=${REAL_SIG}&uparams=e,os"}`,
    });
    track(dir, ['poc/probe/capture.json']);
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('取流签名 upsig');
  });

  it('⭐ SKIP_PATH 不再豁免 bg-ssr.json / bg.html（本次事故的直接原因）', () => {
    /**
     * 反例（补丁前的真实状态）：这两个路径在 `SKIP_PATH` 里，
     * 于是**含 20 处签名的文件被检查器主动跳过**，输出还是 ✅。
     *
     * 这是"检查器成了泄漏文件的保护伞"—— 比漏检更糟，
     * 因为人是看着 ✅ 才放心提交的。
     */
    const dir = sandbox({
      'poc/verify/bg-ssr.json': `{"url":"https://x.bilivideo.com/v.m4s?upsig=${REAL_SIG}"}`,
      'poc/verify/bg.html': `<script>var d={"url":"https://x.bilivideo.com/v.m4s?upsig=${REAL_SIG}"}</script>`,
    });
    track(dir, ['poc/verify/bg-ssr.json', 'poc/verify/bg.html']);
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('bg-ssr.json');
    expect(out).toContain('bg.html');
  });

  it('⭐ --all 会扫到被 gitignore 的文件（原来 --exclude-standard 把它们关在门外）', () => {
    /**
     * 这一条最难在补丁前被发现：`--all` 用的是 `--others --exclude-standard`，
     * 语义是"未跟踪**且没被忽略**"。所以**被忽略的抓包目录永远不被检查**。
     *
     * 而 `.gitignore` 的职责只是挡住 `git add`，不是"这文件从此免检"。
     * 更关键：被忽略的目录里藏着几千处真签名（实测 2188 处），
     * 只要有人 `git add -f`，它们立刻进仓库 —— 这个风险必须能查。
     */
    const dir = sandbox({
      '.gitignore': 'poc/probe/raw/\n',
      'poc/probe/raw/capture.json': `{"url":"https://x.bilivideo.com/v.m4s?upsig=${REAL_SIG}"}`,
    });
    const { status, out } = runIn(dir, ['--all']);

    expect(status).toBe(1);
    expect(out).toContain('poc/probe/raw/capture.json');
  });

  it('⭐ 输出必须区分「已在版本控制内」与「仅本地」', () => {
    /**
     * 实测 `--all` 报 2188 处，全部都在被忽略的本地目录。
     * 若不区分，人只会去改最容易改的本地文件，**把真正在仓库里的漏掉**。
     * 优先级必须由输出本身表达。这里两边的文件各放一个，断言两组都出现。
     */
    const dir = sandbox({
      '.gitignore': 'poc/local/\n',
      'poc/tracked/a.json': `{"u":"?upsig=${REAL_SIG}"}`,
      'poc/local/b.json': `{"u":"?upsig=${REAL_SIG}"}`,
    });
    track(dir, ['poc/tracked/a.json']);
    const { out } = runIn(dir, ['--all']);

    expect(out).toContain('已在版本控制内');
    expect(out).toContain('仅本地磁盘');
    expect(out).toContain('poc/tracked/a.json');
    expect(out).toContain('poc/local/b.json');
  });

  it('★ 截断示例与短测试桩仍然放过（16 位门槛的边界）', () => {
    const dir = sandbox({
      'docs/sample.md': '示例：`upsig=7baa0aee…` 与 `upsig=SECRETUPSIG`',
      'tests/a.test.ts': `const u = '/v.m4s?upsig=9f2c1e0b7a';`,
    });
    track(dir, ['docs/sample.md', 'tests/a.test.ts']);
    const { status } = runIn(dir);

    expect(status).toBe(0);
  });

  it('⛔ 文档（.md/.txt）里的完整签名 → 红（原来被 DOC_EXT 浅检整段跳过）', () => {
    /**
     * 补丁前：`deep = !DOC_EXT.test(file)`，而签名检查写在 `if (!deep) return hits;`
     * **之后** —— 于是 `.md` / `.txt` 走浅路径时签名检查根本不执行。
     *
     * 实测（2026-11-19）：把 32 位完整 `upsig` 追加进
     * `docs/guides/security-notes.md` 再 `git add`，
     * `--staged` 报"✅ 暂存区未发现测试账号标识或凭据"、退出码 0。
     *
     * 这不是理论风险：写安全审计文档时贴一段抓包原文，是这类文档最自然的写法。
     */
    const dir = sandbox({
      'docs/audit.md': `抓包原文：GET /v.m4s?upsig=${REAL_SIG}&uparams=e,os`,
    });
    track(dir, ['docs/audit.md']);
    const { status, out } = runIn(dir);

    expect(status).toBe(1);
    expect(out).toContain('upsig');
    expect(out).toContain('docs/audit.md');
  });

  it('★ 二进制文件不产生假签名（Chrome profile 的 SQLite 曾被误报 12 处）', () => {
    /**
     * `--all` 会列到 `poc/probe/.../raw/repro6/p-probe/Default/Login Data`
     * 这类 Chrome profile 文件（无扩展名、含 NUL）。按 UTF-8 解码成乱码后
     * **恰好会凑出 16 位以上的 `upsig=` 形态**。判据：含 NUL 就当二进制跳过。
     */
    const dir = sandbox({});
    mkdirSync(join(dir, 'poc'), { recursive: true });
    const buf = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from(`upsig=${REAL_SIG}`),
      Buffer.alloc(64, 0x00),
    ]);
    writeFileSync(join(dir, 'poc/Login Data'), buf);

    const { status } = runIn(dir, ['--all']);
    expect(status).toBe(0);
  });
});

describe('check-secrets：历史扫描能跑完（性能是防线的必要条件）', () => {
  it('★ --history 在真实仓库上能结束，且报告里点名了基线（29s vs 40min 未完成）', () => {
    /**
     * 补丁前：逐提交 `git show`，**实测 40 分钟没跑完**，为了发版只能手工绕过 ——
     * 于是"发布前扫一遍历史"这条防线实际上不存在。
     *
     * 补丁后：按 blob 去重 + `cat-file --batch`，实测 **29 秒**。
     *
     * 这条测试同时证明两件事：**跑得完** + **结论仍然正确**。
     * 只测"跑得完"是不够的 —— 一个立刻 `exit 0` 的实现也跑得完。
     *
     * 现状是绿的：那 4 个文件已在基线内（见 security-notes.md）。
     * 所以这里断言的是"它**扫到了**它们"，不是"它报了错"。
     */
    const { status, out } = runIn(REPO, ['--history']);

    expect(status).toBe(0);
    // 确实扫到了历史，且说了自己按 blob 去重（否则读的人不知道它为什么变快）
    expect(out).toContain('按 blob 去重');
    // 基线里的已知泄漏被认出来了（91 处 / 404 提交时的读数）
    expect(out).toContain('全部落在**已记录的基线**里');
    // 说清"基线 ≠ 安全"，否则下一个人会把它当放行条
    expect(out).toContain('基线不是"安全"，是"知道并接受"');
  }, 180_000);

  it('⛔ 基线外的历史泄漏 → 红（基线机制不能被当成放行条）', () => {
    /**
     * 这是基线机制的**反向证明**：如果基线成了"什么都放过"，这个检查就白加了。
     *
     * 沙盒里造一个有提交历史的仓库，把一个含签名的文件提交进去，
     * 它不在基线里 → 必须红。
     */
    const dir = sandbox({
      '.gitignore': '',
      'src/a.ts': 'export const a = 1;\n',
    });
    const g = (args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

    g(['add', '-A']);
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
      {
        cwd: dir,
        stdio: 'pipe',
      },
    );

    // 现在加一个含签名的新文件并提交 —— 它不可能在基线里
    writeFileSync(
      join(dir, 'src/leak.ts'),
      `export const u = 'https://x.bilivideo.com/v.m4s?upsig=${REAL_SIG}';\n`,
      'utf8',
    );
    g(['add', '-A']);
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add leak'],
      { cwd: dir, stdio: 'pipe' },
    );

    const { status, out } = runIn(dir, ['--history']);

    expect(status).toBe(1);
    expect(out).toContain('不在基线内');
    expect(out).toContain('src/leak.ts');
  }, 180_000);
});

describe('check-secrets：历史增量水印（2026-11-19 加，避免每次重扫静态基线）', () => {
  /** 在沙盒里造一个带提交历史的仓库；返回 git 调用器 */
  function repoWithHistory(files: Record<string, string>): {
    dir: string;
    g: (args: string[]) => string;
    commit: (msg: string) => void;
  } {
    const dir = sandbox(files);
    const g = (args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    const commit = (msg: string): void => {
      g(['add', '-A']);
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg],
        {
          cwd: dir,
          stdio: 'pipe',
        },
      );
    };
    commit('init');
    return { dir, g, commit };
  }

  it('★ 第二次扫走增量（水印生效），且扫得到水印之后的**新**泄漏', () => {
    /**
     * 全量 29 秒里有 91 处是静态基线，每次原样再报一遍 —— 纯重复劳动。
     * 水印机制把范围收窄到 `w..HEAD`。
     *
     * 但**变快本身不是目的**：必须同时证明增量扫得到新泄漏，
     * 否则"快"只意味着"漏"。
     */
    const { dir, commit } = repoWithHistory({ 'src/a.ts': 'export const a = 1;\n' });

    // 第一次：无水印 → 全量，并写下水印
    const first = runIn(dir, ['--history']);
    expect(first.status).toBe(0);
    expect(first.out).toContain('**全量**扫');
    expect(first.out).toContain('水印已更新');

    // 第二次：已经有水印，且 HEAD 没动 → 增量 0 提交
    const second = runIn(dir, ['--history']);
    expect(second.status).toBe(0);
    expect(second.out).toContain('**增量**扫');

    // 水印之后**新提交**一个泄漏 —— 增量必须抓到
    writeFileSync(
      join(dir, 'src/leak2.ts'),
      `export const u = 'https://x.bilivideo.com/v.m4s?upsig=${REAL_SIG}';\n`,
      'utf8',
    );
    commit('add leak2');

    const third = runIn(dir, ['--history']);
    expect(third.status).toBe(1);
    expect(third.out).toContain('src/leak2.ts');
  }, 180_000);

  it('⛔ 增量模式下**不认基线**：基线文件被重新加回也要报', () => {
    /**
     * `poc/verify/bg-ssr.json` 在 `HISTORY_BASELINE` 里（2026-11-19 那批已接受的
     * 既有泄漏）。如果有人在新提交里**又把它加回去**，按路径匹配会被判成
     * "已知"而放过 —— 那恰恰是最该报的一次。
     *
     * 判据：增量扫的范围是"水印之后的提交"，这个范围内出现的任何命中都是新的，
     * 所以基线一律不适用。
     */
    const { dir, commit } = repoWithHistory({ 'src/a.ts': 'export const a = 1;\n' });
    expect(runIn(dir, ['--history']).status).toBe(0); // 先打水印

    // 把基线里的那个路径重新造出来并提交
    mkdirSync(join(dir, 'poc/verify'), { recursive: true });
    writeFileSync(
      join(dir, 'poc/verify/bg-ssr.json'),
      `{"url":"https://x.bilivideo.com/v.m4s?upsig=${REAL_SIG}"}`,
      'utf8',
    );
    commit('re-add baseline file');

    const { status, out } = runIn(dir, ['--history']);
    expect(status).toBe(1);
    expect(out).toContain('poc/verify/bg-ssr.json');
  }, 180_000);

  it('★ 水印无效时退回全量（宁可白跑，不能漏扫）', () => {
    /**
     * 两种失效：水印指向不存在的提交、或不是 HEAD 的祖先（历史被 rewrite）。
     * 任一情况下都不能静默按"增量"扫 —— 那会漏。
     */
    const { dir } = repoWithHistory({ 'src/a.ts': 'export const a = 1;\n' });
    expect(runIn(dir, ['--history']).status).toBe(0);

    // 造一个有效格式但不存在的水印
    writeFileSync(join(dir, '.git/pluma-secrets-watermark'), '0'.repeat(40) + '\n', 'utf8');

    const { status, out } = runIn(dir, ['--history']);
    expect(status).toBe(0);
    expect(out).toContain('**全量**扫');
    expect(out).toContain('不是 HEAD 的祖先');
  }, 180_000);

  it('★ --full 强制全量（不信任水印）', () => {
    const { dir } = repoWithHistory({ 'src/a.ts': 'export const a = 1;\n' });
    expect(runIn(dir, ['--history']).status).toBe(0); // 打上水印

    const { status, out } = runIn(dir, ['--history', '--full']);
    expect(status).toBe(0);
    expect(out).toContain('**全量**扫');
    expect(out).toContain('本次显式要求全量');
  }, 180_000);
});
