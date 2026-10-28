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
  'CHANGELOG.md',
  'LICENSE',
  'ADDITIONAL-TERMS.md',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierignore',
];

/**
 * 白名单里**必须存在**的条目 —— 缺任何一个就判失败。
 *
 * ## 为什么需要这个（2026-10-27）
 *
 * `SOURCE_ENTRIES` 的遍历逻辑是 `if (!existsSync(...)) continue`，
 * 也就是**不存在就静默跳过**。这对可选文件是合理的（不同机器可能没有 `.prettierrc`），
 * 但对必需文件是危险的：
 *
 * > 白名单里写了 `CHANGELOG.md`，文件名却打错了 → 脚本照样"自检通过"，
 * > 源码包里没有 CHANGELOG，而**没人会发现**。
 *
 * 判据是**缺了它源码包就不完整**：少了 README 无法了解项目，
 * 少了 LICENSE 无法合规分发，少了 lockfile 无法重建依赖。
 *
 * ⚠️ 往这里加条目时问一句：**它缺失时，源码包还能独立使用吗？** 能，就只放白名单。
 */
const REQUIRED_SOURCE_ENTRIES = [
  'src',
  'entrypoints',
  'package.json',
  'pnpm-lock.yaml',
  'wxt.config.ts',
  'tsconfig.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
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

/**
 * 安装说明全文。
 *
 * ## ⚠️ 文案**不在这里**，在 `assets/install-readme.txt`
 *
 * 第一版是把整段文案内嵌在这个函数里的（2026-10-27）。那造成同一个问题：
 * `releasing.md` 里展示了一份全文，脚本里又存一份 —— **改文档不会改产物**。
 * 这正是本项目反复踩的「两处各写一份，最后必然不一样」。
 *
 * 现在只有一个真相源：`assets/install-readme.txt`。`releasing.md` 只引用它，
 * 脚本只读它。改文案只需改那一个文件。
 *
 * 占位符 `{{VERSION}}` 在这里替换成实际版本号 —— 文案里要写版本，
 * 但版本号是打包时才知道的，所以不能硬编码进 txt。
 */
async function buildInstallReadme(version) {
  const tpl = await readFile(join(ROOT, 'assets', 'install-readme.txt'), 'utf8');
  if (!tpl.includes('{{VERSION}}')) {
    fail(
      'assets/install-readme.txt 缺少 {{VERSION}} 占位符',
      '安装说明标题要带版本号。没有占位符就意味着版本号写死在里面了，必然过期。',
    );
    return tpl;
  }
  return tpl.split('{{VERSION}}').join(version);
}

/**
 * 从 `CHANGELOG.md` 抽出某个版本的小节。
 *
 * ## 为什么需要它（2026-10-27）
 *
 * 原来的 `releaseNotes()` 是**整段硬编码**的模板，只有版本号会变 ——
 * 于是 1.0.0 的 Release 正文和 0.9.0 除了版本号一模一样，
 * **完全看不到"这一版改了什么"**。
 *
 * 用户直接指出：「那后面推送 1.0.0 或者 1.5.0 的时候
 * Release 里的内容不是应该写清楚一些 CHANGE 的吗？」
 *
 * 所以改成：**「本版内容」来自 CHANGELOG，其余（下载/怎么用/边界）来自模板。**
 * CHANGELOG 成为"这个版本有什么"的唯一真相。
 *
 * @param changelog 全文
 * @param version 版本号，如 `0.9.0`（对应 CHANGELOG 里的 `## 0.9.0`）
 * @returns 该版本的正文（不含 `## 0.9.0` 这一行本身）；找不到返回 null
 */
function extractChangelogSection(changelog, version) {
  const lines = changelog.split('\n');

  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return null;

  // 到下一个二级标题为止（或文件末尾）
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  // 去掉末尾的分隔线与空行
  const body = lines.slice(start + 1, end);
  while (
    body.length > 0 &&
    (body[body.length - 1].trim() === '' || body[body.length - 1].trim() === '---')
  ) {
    body.pop();
  }

  // 子节降一级 —— 它们要挂在「本版内容」下面用 ### 会和它平级，看不出从属关系
  return body.join('\n').replace(/^### /gm, '#### ').trim();
}

/**
 * Release 说明。
 *
 * **结构：**「本版内容」← CHANGELOG；「下载 / 怎么用 / 边界 / 许可证」← 本模板。
 * 判据：**会不会随版本变？** 会变的放 CHANGELOG，不变的放这里。
 * 规范说明见 `docs/guides/release-notes-template.md`。
 */
async function releaseNotes(version) {
  const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const section = extractChangelogSection(changelog, version);

  if (section === null) {
    /**
     * 这里**不能只 `fail()`** —— `problems` 数组在更早的步骤就被检查完了，
     * 而 releaseNotes() 在打包末尾才调用，`fail()` 记下的问题没人看。
     *
     * 实测：把 CHANGELOG 的 `## 0.9.0` 改成 `## 9.9.9` 后，脚本仍然「打包完成」，
     * 只是 Release 正文里的「本版内容」变成空的。这种事必须硬失败。
     */
    throw new Error(
      `CHANGELOG.md 里找不到 "## ${version}" 这一节。` +
        '打 tag 前必须先写 CHANGELOG，否则 Release 正文的「本版内容」会是空的。',
    );
  }

  return `## Pluma ${version}

B站双账号画质助手。用主账号浏览、点赞、收藏，让一个大会员账号专门负责取流。

### 本版内容

${section}

### 下载

| 文件 | 内容 |
| --- | --- |
| \`pluma-${version}.zip\` | 构建产物，解压后在 \`edge://extensions\`（Chrome 用 \`chrome://extensions\`）加载 |
| \`pluma-${version}-with-source.zip\` | 同上 + 完整源码 |

也可以自己从源码构建：\`pnpm install && pnpm build\`，加载 \`.output/chrome-mv3\`。

这份产物由本项目开发者构建，未经过浏览器扩展商店签名，仅供学习交流使用。

### 怎么用

1. 加载扩展后点工具栏图标
2. 点「扫码登录播放账号」，用大会员账号扫码（独立窗口，不影响当前登录）
3. 打开任意 B站视频，画质菜单里会出现 4K / 1080P60

**加载后还要开一个权限**，否则扫码窗口打不开：
\`edge://extensions\`（Chrome 用 \`chrome://extensions\`）→ Pluma →「详细信息」
→ 打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」）→ 重新加载扩展。

需要 Chrome 120+ 或 Edge，两个浏览器共用同一份产物。

### 边界

- **不绕过付费墙**：会员专享番剧、电影仍需拥有权益（用你登录的播放账号的权益）
- **不解锁你没有的权益**：4K / 1080P60 来自你登录的大会员账号；没买的单片、地区限制的内容照样看不了
- **不伪装会员标识**：界面显示你的真实状态
- **不解锁地区限制**
- **与哔哩哔哩官方无任何关联**，未获授权或认可

### 已知限制

- 直播不支持（这是决定，不是遗漏）
- 番剧 / 国创 / 电影：**只在主账号只能试看时接管**，改由播放账号取流；
  免费集不接管，画质与原来一致（避免把观看进度记到播放账号上）

### 许可证

GPL-3.0-only + 附加条款（见仓库根目录 \`ADDITIONAL-TERMS.md\`）
`;
}

/**
 * ## 为什么自己写 zip，不调系统 `tar` / `zip`（2026-10-27）
 *
 * 原来的实现调 `tar --force-local -a -c -f out.zip`（Windows）或 `zip -r`
 * （其他平台）。**这台机器上两个都不能用**：
 *
 * - 没有 `zip` 命令（`command not found`）
 * - `tar -a` 按扩展名选格式时，**exit code 是 0，但产出的 zip 全是 0 字节**，
 *   只有开头留了个 `./`。`unzip -l` 报 `End-of-central-directory signature
 *   not found`。
 *
 * 最要命的是**它不报错**：脚本照样打印「自检通过」，用户拿到的是坏包。
 *
 * 所以：自己按 ZIP 规范写，写完再用自己的解析器验一遍。
 * 不压缩（stored，method=0）就够用 —— 扩展产物本来就不大，
 * 少一个 zlib 依赖少一处出错可能。
 *
 * 格式参考 PKWARE APPNOTE.TXT：本地头(30B) + 文件名 + 数据，
 * 中央目录项(46B) + 文件名，末尾 EOCD(22B)。
 */

/** ZIP 用 CRC-32（IEEE 802.3） */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 收集目录下所有文件，返回 `{ name, data }[]`。`name` 用 `/` 分隔 */
async function collectFiles(rootDir, prefix = '') {
  const out = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = join(rootDir, e.name);
    const name = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await collectFiles(abs, name)));
    } else if (e.isFile()) {
      out.push({ name, data: await readFile(abs) });
    }
    // 符号链接与其他类型一律跳过：分发包里不该有
  }
  return out;
}

/**
 * 生成 zip 的 Buffer。
 *
 * @param files `{ name, data }[]`，`name` 是 zip 内路径
 */
function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    // ---- 本地文件头 30 字节 ----
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 签名
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6); // bit11 = UTF-8 文件名（中文路径必须）
    local.writeUInt16LE(0, 8); // method 0 = stored，不压缩
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0x21, 12); // 修改日期 1980-01-01（固定值，保证可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小（stored 时相等）
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度
    parts.push(local, nameBuf, data);

    // ---- 中央目录项 46 字节 ----
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // 签名
    ch.writeUInt16LE(20, 4); // 创建者版本
    ch.writeUInt16LE(20, 6); // 解压所需版本
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // 起始磁盘号
    ch.writeUInt16LE(0, 36); // 内部属性
    ch.writeUInt32LE(0, 38); // 外部属性
    ch.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(ch, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);

  // ---- EOCD 22 字节 ----
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...parts, centralBuf, end]);
}

/**
 * 自检：读回刚写的 zip，确认结构完整。
 *
 * **光靠 `writeFile` 成功不算数** —— 原来 `tar` 的失败方式就是
 * "exit 0 + 坏文件"。这里按 ZIP 结构真正解析一遍：
 * 找 EOCD → 定位中央目录 → 核对条目数与每个本地头签名。
 *
 * @returns 条目名列表；结构不对时抛错
 */
function verifyZip(buf, expectCount) {
  if (buf.length < 22) throw new Error(`zip 只有 ${String(buf.length)} 字节，太短`);

  // EOCD 在末尾，可能带注释；从后往前找签名
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('找不到 EOCD 签名（文件不是合法 zip）');

  const count = buf.readUInt16LE(eocd + 10);
  if (count !== expectCount) {
    throw new Error(`中央目录条目数 ${String(count)}，期望 ${String(expectCount)}`);
  }

  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) throw new Error('中央目录偏移越界');

  const names = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`第 ${String(i + 1)} 个中央目录项签名不对（偏移 ${String(p)}）`);
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const localOffset = buf.readUInt32LE(p + 42);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`第 ${String(i + 1)} 项的本地头签名不对`);
    }
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

/**
 * 把目录打成 zip 并**当场验证**。
 *
 * @param topDir 非空时，所有条目放在这层目录下。
 *   **必须给**：解压后会得到一个规整的文件夹，
 *   而不是把 manifest.json 撒在用户的下载目录里。
 *   安装说明也因此能写死"选哪一个文件夹"。
 */
async function zipDir(cwd, outFile, topDir) {
  const files = await collectFiles(cwd);
  if (files.length === 0) throw new Error('目录是空的，拒绝打包');

  const entries = topDir ? files.map((f) => ({ ...f, name: `${topDir}/${f.name}` })) : files;
  const buf = buildZip(entries);

  await writeFile(outFile, buf);

  // 写完立刻验，坏包不能流到产物目录
  const names = verifyZip(buf, entries.length);
  if (names.length !== entries.length) throw new Error('自检条数不一致');
  if (topDir && !names.every((n) => n.startsWith(`${topDir}/`))) {
    throw new Error('自检：条目没有全部落在顶层目录下');
  }
  return names;
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
  // REQUIRED 缺失直接判失败；其余缺失只记一条 note（允许可选文件不存在）
  const requiredSet = new Set(REQUIRED_SOURCE_ENTRIES);
  for (const entry of SOURCE_ENTRIES) {
    if (existsSync(join(ROOT, entry))) continue;
    if (requiredSet.has(entry)) {
      fail(
        `源码版必需条目缺失：${entry}`,
        '它在 REQUIRED_SOURCE_ENTRIES 里，缺了源码包不完整。若确实该去掉，先改那个数组。',
      );
    } else {
      note(`源码版跳过不存在的条目：${entry}`);
    }
  }

  const lightName = `pluma-${version}.zip`;
  const srcName = `pluma-${version}-with-source.zip`;

  /**
   * zip 内**不包顶层目录**，`manifest.json` 直接放在 zip 根。
   *
   * ## 为什么（2026-10-27 实测推翻前一版做法）
   *
   * 我一度在这里加了一层 `pluma-<版本>/`，理由是"解压后只有一个文件夹可选中"。
   * **实测发现那是错的**：Windows 资源管理器「全部解压」时，
   * **总是先用 zip 文件名建一层目录**，再按 zip 内结构展开。于是变成
   *
   *     pluma-0.9.0.zip  →  pluma-0.9.0/pluma-0.9.0/manifest.json   ← 两层
   *
   * 用户选外层就报「清单文件丢失或不可读取」，必须再点进去一层才对。
   *
   * 平铺之后 Windows 解压得到恰好一层：
   *
   *     pluma-0.9.0.zip  →  pluma-0.9.0/manifest.json                ← 一层 ✅
   *
   * **代价**：极少数情况下用户「解压到当前文件夹」会把文件散出来。
   * 但那是用户主动选择的行为，且安装说明里写了判据（那层应能看到 manifest.json）。
   * 相比之下"每个用 Windows 的人都踩两层"是必然而非偶然。
   *
   * ⚠️ **不要再用 zip 内目录去控制解压后的层级** —— 那层名字由解压工具决定，不由我们决定。
   */
  const TOP_DIR = '';

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

  // ── 5. 打轻量版：直接压 staging 内容（manifest.json 在 zip 根，理由见 TOP_DIR） ──
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  /**
   * 安装说明要写进**构建产物目录之外**，否则会污染 `.output/`。
   * 做法：先复制一份到临时 staging 目录，再往 staging 里加说明文件。
   */
  const staging = join(DIST_DIR, '.staging-light');
  await cp(BUILD_DIR, staging, { recursive: true });
  const readmeText = await buildInstallReadme(version);
  if (problems.length > 0) {
    console.error(`\n[package] ❌ 安装说明有误（${String(problems.length)} 项）\n`);
    for (const p of problems) console.error(`  ${p.what}\n    ${p.why}\n`);
    process.exit(1);
  }
  await writeFile(join(staging, '安装说明.txt'), readmeText, 'utf8');
  await zipDir(staging, join(DIST_DIR, lightName), TOP_DIR);
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

  await zipDir(stagingSrc, join(DIST_DIR, srcName), TOP_DIR);
  await rm(stagingSrc, { recursive: true, force: true });

  // ── 7. Release 说明 ──
  await writeFile(join(DIST_DIR, 'release-notes.md'), await releaseNotes(version), 'utf8');

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
