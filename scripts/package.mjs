#!/usr/bin/env node
/**
 * 打包发布产物 —— 产出两个 zip。
 *
 * ## 规范来源（不要在脚本里另立一套）
 *
 * - 命名 / 结构 / 安装说明全文：`docs/guides/releasing.md`
 * - 为什么这么分发：`docs/decisions/0018-ship-built-artifacts.md`
 *
 * 本脚本只负责**执行**那些规范，并把该报的错报出来。
 *
 * ## 两个产物
 *
 * ```
 * dist/pluma-<ver>.zip              构建产物，manifest.json 在根，可直接加载
 * dist/pluma-<ver>-with-source.zip  同上（放 extension/）+ 完整源码
 * ```
 *
 * ## 为什么脚本要做这么多自检
 *
 * 打包是**只在发版时跑一次**的动作，所以"跑过一次就好了"的错觉最强。
 * 而它的失败方式是静默的：zip 里多一层目录 → 用户报"清单文件缺失"；
 * 版本号不一致 → 用户装了两个版本却被当成同一个。
 * 这些错误人不会在发布那一刻发现，只会在用户抱怨时发现。
 * 所以宁可在打包时就红。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/package.mjs            # 打包
 * node scripts/package.mjs --dry-run  # 只自检，不写文件
 * ```
 *
 * 退出码：0 成功｜1 自检未通过｜2 脚本自身出错
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const BUILD_DIR = join(ROOT, '.output', 'chrome-mv3');
const DIST_DIR = join(ROOT, 'dist');
const MANIFEST = join(BUILD_DIR, 'manifest.json');
const PKG = join(ROOT, 'package.json');

/**
 * 源码版要带的顶层条目。
 *
 * 用**白名单**而不是黑名单：新增目录时默认不打包，人得主动加进来。
 * 反过来（黑名单）会让 `.workbuddy-ai`、日志、临时文件这类东西默默漏进 release。
 */
const SOURCE_ENTRIES = [
  'src',
  'entrypoints',
  'public',
  'scripts',
  'docs',
  'tests',
  'package.json',
  'pnpm-lock.yaml',
  'wxt.config.ts',
  'tsconfig.json',
  'README.md',
  'AGENTS.md',
  'LICENSE',
  'ADDITIONAL-TERMS.md',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierignore',
];

/** 无论在哪一层，出现这些目录名就直接判失败（不该被白名单带进来，但再防一道） */
const FORBIDDEN_DIRS = ['node_modules', '.git', '.workbuddy-ai', 'coverage', '.output'];

const problems = [];
const notes = [];

function fail(what, why) {
  problems.push({ what, why });
}

function note(msg) {
  notes.push(msg);
}

/** 读版本号，并核对两处一致 —— 这是最容易漂移的地方 */
async function readVersion() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const pkg = JSON.parse(await readFile(PKG, 'utf8'));

  if (manifest.version !== pkg.version) {
    fail(
      '版本号不一致',
      `manifest.version = ${manifest.version}，package.json version = ${pkg.version}\n` +
        '    两处必须相同（wxt.config.ts 的 manifest.version 与 package.json 由发布流程同步）。',
    );
  }

  const v = manifest.version;
  /**
   * Chrome 的 manifest.version 每段上限 65535。
   * 日期类方案（20261026）会直接超限装不上，这里提前拦。
   */
  for (const seg of String(v).split('.')) {
    const n = Number(seg);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      fail('版本号不合法', `"${seg}" 超出 0..65535（Chrome 扩展版本号规范）`);
    }
  }
  return v;
}

/** 递归收集文件（相对 BUILD_DIR），用于校验扁平结构 */
async function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full, base)));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

/** 安装说明全文。**文案的权威位置是 releasing.md，改动请先改文档** */
function installReadme(version) {
  return `Pluma ${version} — 安装说明

一、必须先解压
   不能直接在压缩包里选文件夹。请先右键 → 全部解压到当前文件夹。

二、加载扩展（Edge / Chrome 都一样）
   1. 地址栏输入  edge://extensions  （Chrome 用 chrome://extensions）
   2. 打开左下角「开发者模式」
   3. 点「加载解压缩的扩展」
   4. 选择解压出来的这个文件夹 —— 里面有 manifest.json

   ⚠️ 最常见的错误：选了上一级目录，或者选进了某个子文件夹。
      只要报「清单文件缺失或不可读取」，就是选错了层级。
      正确的层级是「选中 manifest.json 所在的那个文件夹」。

三、第一次使用
   1. 点工具栏的 Pluma 图标
   2. 按提示扫码登录你的大会员账号（会开一个独立窗口，不会动你当前登录的号）
   3. 打开任意 B站视频，画质菜单里应该出现 4K / 1080P60

四、本扩展不做什么
   · 不绕过付费墙（会员专享番剧、电影仍需购买）
   · 不伪装会员标识（界面显示你的真实状态）
   · 不解锁地区限制

五、出问题怎么办
   · 画质没变：确认总开关是开的，并且刷新过页面
   · 提示凭据失效：重新扫码登录播放账号
   · 其他：设置页 →「诊断」分区可以导出诊断信息

许可证：GPL-3.0-only + 附加条款，完整文本见仓库根目录。
本项目与哔哩哔哩官方无任何关联，仅供学习交流使用。
`;
}

/** Release 说明。**结构与语气见 docs/guides/release-notes-template.md** */
function releaseNotes(version) {
  return `## Pluma ${version}

B站双账号画质助手。用主账号浏览、点赞、收藏，让一个大会员账号专门负责取流。

### 下载

| 文件 | 内容 |
| --- | --- |
| \`pluma-${version}.zip\` | 构建产物，解压后在 \`edge://extensions\` 加载 |
| \`pluma-${version}-with-source.zip\` | 同上 + 完整源码 |

也可以自己从源码构建：\`pnpm install && pnpm build\`，加载 \`.output/chrome-mv3\`。

这份产物由本项目开发者构建，未经过浏览器扩展商店签名，仅供学习交流使用。

### 边界

- **不绕过付费墙**：会员专享番剧、电影仍需购买
- **不伪装会员标识**：界面显示你的真实状态
- **不解锁地区限制**
- **与哔哩哔哩官方无任何关联**，未获授权或认可

### 已知限制

- 番剧 / 直播不支持

### 许可证

GPL-3.0-only + 附加条款（见仓库根目录 \`ADDITIONAL-TERMS.md\`）
`;
}

/** 用系统 zip 打包（Windows 有 bsdtar，可用 -a 自动按扩展名选格式） */
function zipDir(cwd, outFile, entries) {
  if (process.platform === 'win32') {
    /**
     * ⚠️ `--force-local` 不能省。
     *
     * Windows 的 bsdtar 会把 `D:\...` 里的 `D:` 当成**远程主机名**，
     * 报 `tar: Cannot connect to D: resolve failed`。
     * 加了这个开关才把参数当本地路径。（2026-10-27 首次打包时踩到）
     */
    execFileSync('tar', ['--force-local', '-a', '-c', '-f', outFile, ...entries], {
      cwd,
      stdio: 'pipe',
    });
  } else {
    execFileSync('zip', ['-r', '-q', outFile, ...entries], { cwd, stdio: 'pipe' });
  }
}

async function sha256(file) {
  const buf = await readFile(file);
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

async function sizeOf(file) {
  const s = await stat(file);
  return `${(s.size / 1024).toFixed(0)} KB`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // ── 1. 构建产物必须存在 ──
  if (!existsSync(MANIFEST)) {
    console.error(`找不到 ${MANIFEST}\n先跑 \`pnpm build\`（或 node_modules/.bin/wxt build）。`);
    process.exit(2);
  }

  // ── 2. 自检：扁平结构 ──
  const files = await walkFiles(BUILD_DIR);
  if (!files.includes('manifest.json')) {
    fail(
      'manifest.json 不在构建产物根目录',
      '浏览器靠根目录的 manifest.json 识别扩展。「加载解压缩的扩展」只认这一层。',
    );
  }

  for (const forbidden of FORBIDDEN_DIRS) {
    if (files.some((f) => f.split('/').includes(forbidden))) {
      fail(`构建产物里含 ${forbidden}/`, '这是源码/依赖目录，不该出现在可加载的产物里。');
    }
  }

  // ── 3. 自检：版本号 ──
  const version = await readVersion();

  // ── 4. 自检：源码版需要的顶层条目都在 ──
  for (const entry of SOURCE_ENTRIES) {
    if (!existsSync(join(ROOT, entry))) {
      note(`源码版跳过不存在的条目：${entry}`);
    }
  }

  const lightName = `pluma-${version}.zip`;
  const srcName = `pluma-${version}-with-source.zip`;

  if (problems.length > 0) {
    console.error(`\n[package] ❌ 自检未通过（${String(problems.length)} 项）\n`);
    for (const p of problems) console.error(`  ${p.what}\n    ${p.why}\n`);
    process.exit(1);
  }

  console.log(`[package] 版本 ${version} · ${String(files.length)} 个文件 · 自检通过`);
  for (const n of notes) console.log(`  · ${n}`);

  if (dryRun) {
    console.log('[package] --dry-run：不写文件');
    return;
  }

  // ── 5. 打轻量版：直接压 BUILD_DIR，绝不套一层目录 ──
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  /**
   * 安装说明要写进**构建产物目录之外**，否则会污染 `.output/`。
   * 做法：先复制一份到临时 staging 目录，再往 staging 里加说明文件。
   */
  const staging = join(DIST_DIR, '.staging-light');
  await cp(BUILD_DIR, staging, { recursive: true });
  await writeFile(join(staging, '安装说明.txt'), installReadme(version), 'utf8');
  zipDir(staging, join(DIST_DIR, lightName), ['.']);
  await rm(staging, { recursive: true, force: true });

  // ── 6. 打源码版：产物放 extension/，源码在旁边 ──
  const stagingSrc = join(DIST_DIR, '.staging-src');
  await mkdir(stagingSrc, { recursive: true });
  await cp(BUILD_DIR, join(stagingSrc, 'extension'), { recursive: true });

  const present = [];
  for (const entry of SOURCE_ENTRIES) {
    if (!existsSync(join(ROOT, entry))) continue;
    await cp(join(ROOT, entry), join(stagingSrc, entry), { recursive: true });
    present.push(entry);
  }

  zipDir(stagingSrc, join(DIST_DIR, srcName), ['.']);
  await rm(stagingSrc, { recursive: true, force: true });

  // ── 7. Release 说明 ──
  await writeFile(join(DIST_DIR, 'release-notes.md'), releaseNotes(version), 'utf8');

  // ── 8. 报告 ──
  const light = join(DIST_DIR, lightName);
  const src = join(DIST_DIR, srcName);
  console.log('');
  console.log(
    `  ${lightName.padEnd(36)} ${(await sizeOf(light)).padStart(9)}  sha256:${await sha256(light)}`,
  );
  console.log(
    `  ${srcName.padEnd(36)} ${(await sizeOf(src)).padStart(9)}  sha256:${await sha256(src)}`,
  );
  console.log(`  ${'release-notes.md'.padEnd(36)}`);
  console.log('');
  console.log('[package] ✅ 打包完成 → dist/');
  console.log('[package] 下一步：人工冒烟（解压 zip 并实际加载），见 releasing.md §4');
}

main().catch((err) => {
  console.error(`[package] 脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
