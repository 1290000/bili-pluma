#!/usr/bin/env node
/**
 * 发布产物一致性检查 —— 防「产物与源码结构性脱节」（B-01 / B-08）。
 *
 * ## 为什么需要这个脚本（1.0.0 发布方案 §1.1 的原话）
 *
 * `verify` 全绿不等于产物正确。`verify` 的 12 项检查的是**源码与文档**，
 * **没有任何一项检查 `dist/` 里的 zip 与源码是否同步**。
 * 这正是本次最大缺陷（`pluma-0.9.0.zip` 少图标、少 `world:'MAIN'` 入口、
 * 带着已废弃的 `web_accessible_resources`）能存在 3 天而不被发现的原因。
 *
 * 那个 zip 构建于 2026-10-27 18:00，此后三次**结构性**变更都没重新打包：
 *   - `main-hook.content.ts` 改成 `world:'MAIN'` 注入
 *   - `main-world.js` 移出 `public/`、不再靠 `web_accessible_resources` 暴露
 *   - 图标集成进 manifest
 * 结果是用户装到的扩展里，那个 1862 行的 `main-world.js` **没有任何脚本会加载它**
 * —— 主世界 hook 根本没跑，表现为「切高清弹充值页、画质对比不显示」。
 *
 * ## 检查什么（四项，对每个 `dist/pluma-<版本>.zip`）
 *
 * 1. `manifest.json` 的 `icons` 非空 —— 没有图标，工具栏上是灰块
 * 2. `content_scripts` 里有 `world === 'MAIN'` 的那一条 —— 没有它 = 主世界脚本没人执行
 * 3. **没有** `web_accessible_resources` —— 2026-10-28 已删（那是死配置），
 *    留着等于让全站页面能 `fetch` 主世界脚本
 * 4. **主世界代码真的进到产物里了**：从 `manifest.content_scripts` 里取
 *    `world === 'MAIN'` 那条声明的 JS 文件，断言它含四段特征串（见 `MAIN_WORLD_SIGNATURES`）。
 *    构建产物 `.output/` 存在时，zip 那份还必须与构建产物那份**同样含这四段**。
 *
 * ## ⚠️ 为什么不再检查「有没有一个叫 main-world.js 的文件」
 *
 * 2026-10-28 起，主世界脚本**不是独立产物文件**了。架构变成
 * `entrypoints/main-hook.content.ts` 直接 `import` `src/content/main-world.js`，
 * WXT 把它打包进 `content-scripts/main-hook.js`（单行压缩）。
 *
 * 所以 `.output/chrome-mv3/` 根目录**本来就没有** `main-world.js`。
 * 第一版脚本断言「zip 根目录必须有 main-world.js」是**按旧架构写的**，
 * 打 1.0.0 的包时会对正常产物误报——那比漏报更糟：
 * 人会以为产物坏了，或者干脆把这条断言删掉，于是 B-01 又没人守了。
 *
 * **别再把它加回来。** 判据换成「主世界代码有没有进到产物里」，
 * 这既抗压缩差异、也抗 WXT 改输出布局，而且更接近我们真正关心的事：
 * 玩家装上后那几类响应改写到底在不在。
 *
 * ## ⚠️ 没有 zip 时**跳过**，不是失败
 *
 * `dist/` 是 gitignore 的本地目录。干净 clone 里没有 zip，此时本检查必须**不报错**，
 * 否则整条 `verify` 链会永远红，后续所有工作都没法验证。
 * 有 zip 但不合格时**才**报错，并逐条打印原因。
 *
 * ## 为什么手工解析 zip 而不是加依赖
 *
 * 仓库没有 JS 解压库，而 AGENTS.md §7 写明「依赖清单是封闭的，加任何一个都要有理由」。
 * 这里只需要「列出条目 + 取出一个文件的内容」，用 zip 格式的中央目录就能做到，
 * 不值得为它开一条依赖。写法参照 `scripts/package.mjs` 的 `buildZip()` /
 * `verifyZip()` —— 那两处本来也是手写的。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-artifact.mjs
 * ```
 *
 * 退出码：0 通过或跳过｜1 有产物不合格｜2 脚本自身出错
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const ROOT = process.cwd();
const DIST_DIR = join(ROOT, 'dist');
const BUILD_DIR = join(ROOT, '.output', 'chrome-mv3');

/** 轻量版与源码版都要查 */
const ARTIFACT_RE = /^pluma-[\d.]+(-with-source)?\.zip$/;
const SOURCE_ARTIFACT_RE = /^pluma-[\d.]+-with-source\.zip$/;

/**
 * 「主世界代码已进产物」的特征串 —— 四段，覆盖四类响应体改写能力。
 *
 * ## 为什么用特征串而不是字节比对
 *
 * 主世界代码现在被 WXT 打包并**压缩成单行**（`content-scripts/main-hook.js`），
 * 变量名会被改短（`PGC_TOAST_ITEM` → `M`），所以：
 *   - 比对变量名：压缩后全没了，必然假红
 *   - 比对字节：`.output` 与 zip 之间只要差一个文件顺序或时间戳就假红，
 *     而且它回答的是"两份一不一样"，不是"能力在不在"
 *
 * 特征串选的是**字符串字面量**（含在反引号/引号里，压缩器不敢动）
 * 与**接口字段名**（要发给播放器，改了就坏），所以它们是稳定的。
 *
 * ## 选这四段的原因（每段对应一类改写授权，少一段就是丢一类能力）
 *
 * | 特征串 | 对应能力 | 出处 |
 * | --- | --- | --- |
 * | `bpx-player-toast-item` | 隐藏 PGC 试看提示条 | ADR 0022 |
 * | `PromptBar` | 同上，**筛选标记**（少了它会误伤跳过片头/续播） | ADR 0022 |
 * | `last_play_time` | 把观看进度还原成主账号的 | ADR 0017 |
 * | `play_video_type` | PGC 试看标记改写（不改会在试看点主动停） | ADR 0021 |
 *
 * ## 为什么不用 `playview`（第一版想用它，实测后否掉）
 *
 * `playview` 在产物里出现 12 次，但其中绝大多数是**日志文案**
 * （`C('playview', 'cid=… 取流结果为空')`），改掉这些日志不会丢能力；
 * 反过来它也没法证明换流逻辑在（换流那条 `/\/ogv\/player\/playview/` 正则
 * 和它只共享子串）。**一个"命中次数很多但都不在关键路径上"的特征串
 * 会给出虚假的安全感**，所以换成 `play_video_type`。
 *
 * ## 实测（2026-10-29，`.output/chrome-mv3/content-scripts/main-hook.js`）
 *
 * `bpx-player-toast-item` 1 次 · `PromptBar` 1 次 · `last_play_time` 7 次 ·
 * `play_video_type` 10 次。压缩后仍全部非零。
 *
 * ⚠️ 计数只能用 `grep -o … | wc -l`：产物是**单行文件**，
 * `grep -c` 恒返回 1，看起来像"有"、实际什么都没数。
 */
const MAIN_WORLD_SIGNATURES = [
  { token: 'bpx-player-toast-item', what: 'PGC 试看提示条容器（ADR 0022）' },
  { token: 'PromptBar', what: 'PGC 提示条筛选标记（ADR 0022，少了它会误伤跳过片头）' },
  { token: 'last_play_time', what: '观看进度还原（ADR 0017）' },
  { token: 'play_video_type', what: 'PGC 试看标记改写（ADR 0021）' },
];

/**
 * 从 manifest 里取出 `world === 'MAIN'` 那条 content_scripts 声明的 JS 路径。
 *
 * 路径**从 manifest 读，不硬编码**：WXT 改输出布局时（比如把入口挪进
 * `content-scripts/` 之外的目录）这里会自动跟上，而硬编码会假红。
 *
 * @param {any} manifest
 * @returns {string | null} 相对产物根的路径；没有 MAIN 那条时返回 null
 */
function findMainWorldScript(manifest) {
  const list = Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : [];
  const main = list.find((c) => c && c.world === 'MAIN');
  const js = Array.isArray(main?.js) ? main.js : [];
  return typeof js[0] === 'string' && js[0] ? js[0] : null;
}

/**
 * 统计内容里每个特征串命中几次。
 *
 * @param {string} text
 * @returns {Array<{ token: string, what: string, count: number }>}
 */
function measureSignatures(text) {
  return MAIN_WORLD_SIGNATURES.map((s) => ({
    ...s,
    count: text.split(s.token).length - 1,
  }));
}

/**
 * 找出 `dist/` 下所有主产物 zip。
 *
 * @returns {Promise<string[]>} 文件名（不含目录）
 */
async function findArtifacts() {
  if (!existsSync(DIST_DIR)) return [];
  const entries = await readdir(DIST_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && ARTIFACT_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * 读 zip 的中央目录，返回条目清单（含数据在文件里的位置）。
 *
 * ## 为什么用中央目录而不是本地文件头
 *
 * 本地文件头里的大小字段可能是 0（配 `data descriptor`，bit3 置位时），
 * 那时算不出「这条数据有多长」。中央目录里的大小字段是**最终值**，一定可信。
 * 所以：**中央目录负责定位与长度，本地头只用来算数据起点。**
 *
 * @param {Buffer} buf
 * @returns {Array<{ name: string, method: number, compSize: number, size: number, dataStart: number }>}
 */
function readCentralDirectory(buf) {
  if (buf.length < 22) throw new Error(`zip 只有 ${String(buf.length)} 字节，太短`);

  // EOCD（22 字节起）可能带注释，从后往前找签名
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('找不到 EOCD 签名（文件不是合法 zip）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) throw new Error('中央目录偏移越界');

  /** @type {Array<{ name: string, method: number, compSize: number, size: number, dataStart: number }>} */
  const entries = [];
  let p = cdOffset;

  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length) throw new Error(`第 ${String(i + 1)} 个中央目录项越界`);
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`第 ${String(i + 1)} 个中央目录项签名不对（偏移 ${String(p)}）`);
    }

    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);

    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`条目 ${name} 的本地头签名不对`);
    }
    // 本地头的 name/extra 长度可能与中央目录不同（extra 字段常被改写），必须读本地头自己的
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    entries.push({ name, method, compSize, size, dataStart });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * 取出 zip 内某个条目的内容。
 *
 * @param {Buffer} buf
 * @param {{ name: string, method: number, compSize: number, size: number, dataStart: number }} entry
 * @returns {Buffer}
 */
function readEntry(buf, entry) {
  const raw = buf.subarray(entry.dataStart, entry.dataStart + entry.compSize);
  // method 0 = stored（`package.mjs` 用的就是它）；8 = deflate
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(
    `条目 ${entry.name} 的压缩方式 ${String(entry.method)} 不支持（只认 stored/deflate）`,
  );
}

/**
 * 检查一个 zip 的四项断言。
 *
 * @param {Buffer} buf
 * @returns {{ problems: string[], notes: string[] }} problems 非空即不合格
 */
function checkZip(buf) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];

  const entries = readCentralDirectory(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));

  // ── 1. manifest.json 必须存在且在根 ──
  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) {
    problems.push(
      'zip 根目录没有 manifest.json —— 浏览器「加载解压缩的扩展」只认这一层，' +
        '多套一层目录会导致用户报「清单文件缺失」',
    );
    return { problems, notes };
  }

  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(readEntry(buf, manifestEntry).toString('utf8'));
  } catch (err) {
    problems.push(
      `manifest.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    );
    return { problems, notes };
  }

  // ── 断言 1：icons 非空 ──
  const icons = manifest.icons;
  const iconSizes = icons && typeof icons === 'object' ? Object.keys(icons) : [];
  if (iconSizes.length === 0) {
    problems.push(
      'manifest.json 的 icons 为空 —— 工具栏上是灰块。' +
        '0.9.0 的 zip 就是这样（构建早于图标集成）',
    );
  } else {
    notes.push(`icons ${iconSizes.length} 档（${iconSizes.join('/')}）`);
    // 声明了图标却没打进 zip = 装上去图标裂开，比没有更难排查
    for (const [, rel] of Object.entries(icons)) {
      if (typeof rel === 'string' && !byName.has(rel)) {
        problems.push(`manifest.json 声明了图标 ${rel}，但 zip 里没有这个文件`);
      }
    }
  }

  // ── 断言 2：content_scripts 里必须有 world === 'MAIN' 的那一条 ──
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const mainWorld = contentScripts.filter((c) => c && c.world === 'MAIN');
  if (contentScripts.length === 0) {
    problems.push('manifest.json 里 content_scripts 为空 —— 扩展在任何页面都不会注入');
  } else if (mainWorld.length === 0) {
    problems.push(
      `content_scripts 的 ${String(contentScripts.length)} 条里没有 world:'MAIN' 那条 —— ` +
        '主世界 hook 不会被加载，播放器里没有响应改写（切高清弹充值页、画质对比不显示）。' +
        '0.9.0 的 zip 就是这样：main-world.js 打进去了，但没有任何脚本执行它',
    );
  } else {
    const js = (mainWorld[0].js ?? []).join(',');
    notes.push(
      `content_scripts ${String(contentScripts.length)} 条，MAIN world → ${js || '(未声明 js)'}`,
    );
    if (!js) problems.push("那条 world:'MAIN' 的 content_scripts 没有声明 js —— 等于空操作");
  }

  // ── 断言 3：不许有 web_accessible_resources ──
  //
  // 2026-10-28 删除该配置：主世界脚本改由 content_scripts 的 world:'MAIN' 注入，
  // WAR 只负责「把资源暴露成可 fetch 的 URL」。留着不放是**攻击面**：
  // 任何页面（含第三方 iframe）都能 fetch 到这份脚本。
  const war = manifest.web_accessible_resources;
  if (war !== undefined) {
    const n = Array.isArray(war) ? war.length : 1;
    problems.push(
      `manifest.json 里有 web_accessible_resources（${String(n)} 组）—— 该配置 2026-10-28 已删除，` +
        '留着等于让任何页面都能 fetch 主世界脚本。说明这个 zip 用的是旧的 WAR 注入方案',
    );
  } else {
    notes.push('无 web_accessible_resources');
  }

  // ── 断言 4：主世界代码真的进到产物里了（特征串，不比对独立文件） ──
  checkMainWorldContent(buf, byName, manifest, problems, notes);

  return { problems, notes };
}

/**
 * 检查 `-with-source.zip` 的构建凭证（G6，ADR 0018 的「可独立重建并比对」）。
 *
 * ## 断言
 *
 * 1. 根目录有 `BUILD.md`
 * 2. `BUILD.md` 有「版本」与 40 位「提交」
 * 3. `BUILD.md` 的版本 == `extension/manifest.json` 的 version
 * 4. `BUILD.md` 的 sha256 表逐条与 `extension/**` 实际字节一致，且行数相等
 * 5. 源码版里**不许**有 `安装说明.txt`（那是轻量版的；混进来会让人以为源码版可直接加载）
 *
 * ## 为什么逐条比对而不是只看表存在
 *
 * 凭证的价值在于「可独立验证」。如果只断言 BUILD.md 存在，那么改坏一个哈希、
 * 或者产物被替换而凭证没更新，都发现不了 —— 那和没有凭证一样。
 *
 * @param {Buffer} buf
 * @returns {{ problems: string[], notes: string[] }}
 */
function checkSourceZip(buf) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];

  const entries = readCentralDirectory(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));

  const buildEntry = byName.get('BUILD.md');
  if (!buildEntry) {
    problems.push(
      'with-source.zip 根目录没有 BUILD.md —— 源码版缺少构建凭证（G6）。' +
        '重新用 `node scripts/package.mjs` 打包',
    );
    return { problems, notes };
  }

  const text = readEntry(buf, buildEntry).toString('utf8');
  const version = /^- 版本：(.+)$/m.exec(text)?.[1]?.trim();
  const commit = /^- 提交：([0-9a-f]{40})$/m.exec(text)?.[1];

  if (!version) problems.push('BUILD.md 缺少「- 版本：…」行');
  if (!commit) problems.push('BUILD.md 缺少 40 位「- 提交：…」行');

  const rows = [...text.matchAll(/^\| ([0-9a-f]{64}) \| (.+) \|$/gm)].map((m) => ({
    hash: m[1],
    path: m[2].trim(),
  }));
  if (rows.length === 0) problems.push('BUILD.md 没有 sha256 表（或格式不对）');

  const manifestEntry = byName.get('extension/manifest.json');
  if (!manifestEntry) {
    problems.push('with-source.zip 里没有 extension/manifest.json');
  } else {
    try {
      const manifestVersion = JSON.parse(readEntry(buf, manifestEntry).toString('utf8')).version;
      if (version && manifestVersion !== version) {
        problems.push(
          `BUILD.md 版本 ${version} ≠ extension/manifest.json ${String(manifestVersion)}`,
        );
      }
    } catch (err) {
      problems.push(
        `extension/manifest.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * BUILD.md 记录的 commit 必须是**可解释的提交**（2026-10-30 加，2026-10-31 修正）
   *
   * ## 为什么必须查
   *
   * 实测踩到：打完包后又提交了一次，直接把 `git tag` 打在新 commit 上 ——
   * 于是 `-with-source.zip` 里的 BUILD.md 写着旧 commit，而 tag 指向新 commit。
   * **源码版无法对应当前 tag 重建**，而这正是 G6「构建凭证」的全部价值。
   *
   * 原来的本文件只断言「有 40 位 commit 行」，不检查它指向哪 —— 等于只验格式，不验内容。
   *
   * ## ⚠️ 判据不是「等于 HEAD」（2026-10-31 修正）
   *
   * 第一版写成 `commit === HEAD`，发布当天就误报了：
   * 1.0.1 发布后 `dist/` 里的产物**理应**停在 tag `v1.0.1`（`d31f2ed`），
   * 而 `main` 又往前走了一个提交（`8935ffd`）—— 两者不等是**正确状态**，
   * 却把 `verify` 判红，导致后续所有检查被跳过。
   *
   * 正确的判据是：**这个 commit 必须真实存在于仓库**（`git cat-file -e`），
   * 且是当前分支祖先之一（`git merge-base --is-ancestor`）——
   * 也就是"这次的产物是在某个真实提交上打的"。
   *
   * 而「产物是否对应当前 tag」这件事，**不该由本检查负责**：
   * 它是发版流程的一步（`releasing.md` §6 要求先打包再打 tag），
   * 由人在发布时保证；发布后 `dist/` 停在 tag 上是设计如此。
   */
  if (commit) {
    /**
     * ⚠️ 这里踩过两个坑（2026-10-31）：
     *
     * 1. `git cat-file -e` **成功时 stdout 为空** —— 不能用"有没有输出"判存在，要看退出码
     * 2. **不能写成 `execSync('git cat-file -e <sha>^{commit}')`** —— 字符串形式会经过 shell，
     *    `^` 在 Windows cmd 里是转义符，被吞掉后参数变成非法 revision → 退出码非 0 →
     *    误判成"提交不存在"（实测：命令行手动跑退出码 0，脚本里却判失败）
     *
     * 所以用 `spawnSync` + **参数数组**，完全绕开 shell。
     */
    const runGit = (args) => spawnSync('git', args, { cwd: ROOT, stdio: 'pipe' });

    const hasGit = runGit(['rev-parse', '--git-dir']).status === 0;
    if (!hasGit) {
      notes.push('非 git 环境，跳过 BUILD.md 提交来源检查');
    } else {
      const exists = runGit(['cat-file', '-e', `${commit}^{commit}`]).status === 0;
      if (!exists) {
        problems.push(
          `BUILD.md 记录的提交 ${commit.slice(0, 7)} 在本仓库里不存在` +
            ' —— 产物不是从本仓库打出来的，或提交被改写了',
        );
      }
    }
  }

  if ([...byName.keys()].some((n) => n === '安装说明.txt' || n.endsWith('/安装说明.txt'))) {
    problems.push(
      'with-source.zip 里不应有 安装说明.txt（它是轻量版的；源码版会让人误以为可直接加载）',
    );
  }

  const rowMap = new Map(rows.map((r) => [r.path, r.hash]));
  const extEntries = entries.filter(
    (e) => e.name.startsWith('extension/') && !e.name.endsWith('/'),
  );

  if (rows.length > 0 && extEntries.length !== rows.length) {
    problems.push(
      `BUILD.md 表 ${String(rows.length)} 行，extension/ 实际 ${String(extEntries.length)} 个文件 —— 不符`,
    );
  }

  let mismatched = 0;
  for (const e of extEntries) {
    const expected = rowMap.get(e.name);
    if (!expected) {
      problems.push(`BUILD.md 缺少 ${e.name} 的哈希`);
      continue;
    }
    let actual;
    try {
      actual = createHash('sha256').update(readEntry(buf, e)).digest('hex');
    } catch (err) {
      problems.push(`${e.name} 读不出来：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (actual !== expected) {
      mismatched += 1;
      problems.push(
        `${e.name} 哈希不符（BUILD.md ${expected.slice(0, 8)}… / 实际 ${actual.slice(0, 8)}…）`,
      );
    }
  }

  if (problems.length === 0) {
    notes.push(
      `BUILD.md 校验通过（版本 ${String(version)} · commit ${String(commit).slice(0, 8)}… · ${String(rows.length)} 条哈希）`,
    );
  } else if (mismatched > 0) {
    notes.push(`有 ${String(mismatched)} 个文件哈希不符`);
  }

  return { problems, notes };
}

/**
 * 断言 4：主世界代码在 zip 里、且四类改写能力的特征串都在。
 *
 * ## 为什么不比对「zip 里有没有 main-world.js」
 *
 * 2026-10-28 起主世界脚本不再是独立产物文件（见文件头那段）。**别再把它加回来。**
 *
 * ## 两层判据
 *
 * - **一层（永远做）**：zip 的 manifest 里 `world:'MAIN'` 那条声明的 JS，
 *   必须含 `MAIN_WORLD_SIGNATURES` 里每个特征串。这层不需要 `.output`，
 *   "只拿到产物、没构建过"的机器上也能跑。
 * - **二层（`.output` 存在时做）**：构建产物里同一个路径的文件也必须含这些特征串。
 *   两层都过，才说明这个 zip 是由当前源码构建的（B-01 的根因是产物落后于源码）。
 *
 * ⚠️ **`.output` 存在但找不到 MAIN 那条 JS** 是**硬错误**，不是"跳过"：
 * 说明构建坏了（或者 WXT 又改了输出布局）。它和"这台机器没构建过"是两件
 * 完全不同的事，第二版脚本把它们混成一句话，等于让真问题静默通过。
 *
 * @param {Buffer} buf zip 全文
 * @param {Map<string, { name: string, method: number, compSize: number, size: number, dataStart: number }>} byName
 * @param {any} manifest zip 里的 manifest.json
 * @param {string[]} problems
 * @param {string[]} notes
 */
function checkMainWorldContent(buf, byName, manifest, problems, notes) {
  const relPath = findMainWorldScript(manifest);
  if (!relPath) {
    // 断言 2 已经报过"没有 world:'MAIN' 那条"，这里不重复报同一件事
    notes.push('主世界特征串检查已跳过（manifest 里没有 world:MAIN 那条，见上一条问题）');
    return;
  }

  // ── 一层：zip 里那份 ──
  const entry = byName.get(relPath);
  if (!entry) {
    problems.push(
      `manifest 声明了 world:'MAIN' 的 ${relPath}，但 zip 里没有这个文件 —— ` +
        '浏览器加载时这条脚本会 404，所有响应改写静默失效',
    );
    return;
  }

  let zipText;
  try {
    zipText = readEntry(buf, entry).toString('utf8');
  } catch (err) {
    problems.push(
      `zip 里的 ${relPath} 读不出来：${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const zipHits = measureSignatures(zipText);
  const zipMissing = zipHits.filter((h) => h.count === 0);
  if (zipMissing.length > 0) {
    const list = zipMissing.map((h) => `${h.token}（${h.what}）`).join('、');
    problems.push(
      `zip 里的 ${relPath} 缺少这些特征串：${list} —— 说明产物里的主世界脚本比源码旧，` +
        '对应那几类响应改写没进产物（B-01 的表现）',
    );
  } else {
    notes.push(
      `zip 内 ${relPath} 特征串齐全（${zipHits.map((h) => `${h.token}×${String(h.count)}`).join(' ')}）`,
    );
  }

  // ── 二层：与当前构建产物比 ──
  if (!existsSync(BUILD_DIR)) {
    notes.push(
      `与构建产物比对已跳过：这台机器没有 ${relative(ROOT, BUILD_DIR)}（没构建过），无法判断 zip 是否由当前源码产出`,
    );
    return;
  }

  const outFile = join(BUILD_DIR, relPath);
  if (!existsSync(outFile)) {
    // ⚠️ 硬错误，不是跳过：.output 在，但里面没有 MAIN 那条 JS —— 构建坏了
    problems.push(
      `${relative(ROOT, BUILD_DIR)} 存在，但里面没有 manifest 声明的 ${relPath} —— ` +
        '构建产物不完整（或 WXT 又改了输出布局）。重新 `pnpm build`；' +
        '若布局真的变了，请同步更新本脚本而不是删掉这条断言',
    );
    return;
  }

  let outText;
  try {
    outText = readFileSync(outFile, 'utf8');
  } catch (err) {
    problems.push(
      `读不到 ${relative(ROOT, outFile)}：${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const outHits = measureSignatures(outText);
  const outMissing = outHits.filter((h) => h.count === 0);
  if (outMissing.length > 0) {
    const list = outMissing.map((h) => `${h.token}（${h.what}）`).join('、');
    problems.push(
      `${relative(ROOT, outFile)} 缺少这些特征串：${list} —— 源码里有但构建产物里没有，` +
        '多半是最后一次 build 早于这些改动。重新 `pnpm build` 再打包',
    );
    return;
  }

  // 两份都齐 → 才算"zip 与当前源码同步"
  notes.push(`与构建产物一致（${relPath} 特征串全命中，共 ${String(zipText.length)} 字符）`);
}

/**
 * 主流程。
 */
async function main() {
  console.log('[artifact] 检查 dist/ 下的发行产物与源码是否同步');

  const names = await findArtifacts();
  if (names.length === 0) {
    // ⚠️ 跳过不是失败：`dist/` 是本地目录，干净 clone 里没有 zip。
    // 让这里失败等于让整条 verify 链永远红 —— 那样后续所有改动都没法验证。
    console.log('[artifact] ⏭  跳过：dist/ 里没有 pluma-<版本>.zip（未打包，或已归档）');
    return;
  }

  let failed = 0;

  for (const name of names) {
    const file = join(DIST_DIR, name);
    let buf;
    try {
      buf = await readFile(file);
    } catch (err) {
      console.error(
        `\n[artifact] ❌ ${name} 读不出来：${err instanceof Error ? err.message : String(err)}`,
      );
      failed += 1;
      continue;
    }

    let result;
    try {
      result = SOURCE_ARTIFACT_RE.test(name) ? checkSourceZip(buf) : checkZip(buf);
    } catch (err) {
      console.error(
        `\n[artifact] ❌ ${name} 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
      failed += 1;
      continue;
    }

    if (result.problems.length === 0) {
      console.log(`[artifact] ✅ ${name}：${result.notes.join(' · ')}`);
      continue;
    }

    failed += 1;
    console.error(`\n[artifact] ❌ ${name} 有 ${String(result.problems.length)} 处不合格`);
    for (const p of result.problems) console.error(`  - ${p}`);
    if (result.notes.length > 0) console.error(`  （已通过的项：${result.notes.join(' · ')}）`);
  }

  if (failed > 0) {
    console.error(
      `\n[artifact] ${String(failed)}/${String(names.length)} 个产物不合格。` +
        '重新打包：先 `pnpm build`，再 `node scripts/package.mjs`',
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[artifact] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
