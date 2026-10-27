#!/usr/bin/env node
/**
 * 敏感信息检查 —— 防止测试账号标识、真实凭据、本机路径混进仓库。
 *
 * ## 为什么需要它
 *
 * 2026-10-27 准备发布 0.9.0 时才发现：测试用的**主账号 mid、播放账号 mid、
 * 两个昵称、SESSDATA 样例、开发机用户名、会员到期时间戳**散落在文件与
 * 提交信息里，而且**已经推到了公开仓库**。
 *
 * ## ⚠️⚠️ 本文件绝不能自己成为泄露源
 *
 * 第一版把真实 mid 写成明文正则 —— **检查器自己泄露**（用户当场指出）。
 *
 * 第二版改成 base64 拆成两段 —— 拼起来就能还原，**等于没改**。
 *
 * <!-- 这里原本贴了两种错误写法的代码示例，但示例里含真实 mid，已删除。
 *     教训：连"反例"都不能写真实值，用 `<某个 mid>` 占位。 -->
 * 用户原话：「不要闹出来检查用的代码反而露出了敏感数据这种笑话」。
 *
 * **最终方案：只存 SHA-256 哈希，源码里没有任何可还原的信息。**
 *
 * 怎么还能查？—— 对**候选值算哈希**再比对：
 *
 *   - 文件里任何长度 6-20 的纯数字串 → 算哈希 → 比 mid 表
 *   - 任何 `[A-Za-z0-9_]{6,20}` 的 token → 算哈希 → 比昵称表
 *
 * 这比正则慢一点，但**换取"本文件绝对不含明文"**。值本身足够短
 * （mid ≤ 16 位、昵称 ≤ 32 字符），候选提取无遗漏。
 *
 * 加盐：`pluma-secrets-v1`。盐是公开的、不敏感，作用是防止
 * 有人拿现成的 mid 彩虹表反查哈希 —— 短数字本身熵低，不加盐几乎等于明文。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-secrets.mjs            # 已跟踪文件（verify.mjs 用）
 * node scripts/check-secrets.mjs --staged   # 只查暂存区改动行（pre-commit 用）
 * node scripts/check-secrets.mjs --all      # 工作区全部（含未跟踪）
 * node scripts/check-secrets.mjs --history  # 全部提交历史（发布前用，慢）
 * node scripts/check-secrets.mjs --commit-msg [file]  # 提交信息（commit-msg 钩子用）
 * ```
 *
 * ## 不检查什么
 *
 * - 测试夹具里的**假 mid**（`1000001`）—— 那是正常测试数据
 * - 变量名、注释里的 `SESSDATA` 字段名 —— 那是协议的一部分
 * - 公开视频的 BV 号 / cid / aid —— 公开信息
 *
 * 判据：**这段信息能不能把真实的人和账号对应起来？** 能，就是敏感。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** 哈希盐。公开无妨 —— 作用是防彩虹表，不是防解密 */
const SALT = 'pluma-secrets-v1';

function hashOf(value) {
  return createHash('sha256').update(SALT + ':' + value).digest('hex').slice(0, 32);
}

/**
 * 敏感值的**哈希表**。
 *
 * ⚠️ **只增不减。** 泄露过的值必须永远留在这里 ——
 * 否则哪天有人从旧分支/旧备份把它们带回来，检查形同虚设。
 *
 * ⚠️ 加新值：
 *     node -e "const c=require('crypto');
 *              console.log(c.createHash('sha256').update('pluma-secrets-v1:<值>').digest('hex').slice(0,32))"
 * 然后把 32 位哈希填进来。**永远不要把明文写进这个文件。**
 */
const BANNED_HASHES = new Map([
  ['62a3818ebf47b9d5826347cd1b08a89e', '主账号 mid'],
  ['cbebed5faf252edbed52ed0ec98c44fb', '主账号昵称'],
  ['363bc078855dfd20c6d96a4d1986dcd0', '播放账号 mid'],
  ['446845ae9d83a0ba1c6a027f36938068', '播放账号昵称'],
  ['7db1e128c599e9e57f553953a9c58d75', '会员到期时间戳'],
]);

/**
 * 候选提取：从一行里挖出所有可能命中哈希表的 token。
 *
 * - 纯数字 6-20 位 → 可能是 mid / uid / 时间戳
 * - 字母数字下划线 6-40 位 → 可能是昵称 / token 前缀
 *
 * 长于 20 位的纯数字不可能是 mid（B站 mid 是 int64 以内的十进制），
 * 但**毫秒时间戳是 13 位**，仍在这个范围内。
 */
const CANDIDATE_PATTERNS = [/\b\d{6,20}\b/g, /\b[A-Za-z][A-Za-z0-9_]{5,39}\b/g];

/**
 * 凭据形态。**只匹配"赋值"**，不匹配字段名 ——
 * `qrcode_key?: string` 这样的类型声明是协议的一部分，不该报。
 *
 * 这些不需要哈希：模式本身就是"长随机串"，不含具体的人的信息。
 */
const CREDENTIAL_PATTERNS = [
  {
    pattern: /\bsessdata\s*[=:]\s*['"]?[A-Za-z0-9%_,]{20,}/i,
    what: 'SESSDATA 真实值',
  },
  {
    pattern: /\bbili_jct\s*[=:]\s*['"]?[0-9a-f]{32}/i,
    what: 'bili_jct 真实值',
  },
  {
    pattern: /\baccess_key\s*[=:]\s*['"]?[0-9a-f]{32}/i,
    what: 'access_key 真实值',
  },
  {
    pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    what: '私钥',
  },
];

/**
 * 假值判定：样例值里带这些标记的，视为构造值。
 *
 * 测试夹具需要真结构（SESSDATA 含逗号、三段式），
 * 完全随机化的假值反而测不出分割逻辑。
 */
const FAKE_MARKER = /fake|deadbeef|example|placeholder|dummy|xxx/i;

/** 本机绝对路径里带真实用户名的 */
const LOCAL_PATH_PATTERNS = [
  {
    pattern: /[A-Za-z]:\\Users\\(?!<)[^\\\s"'`]+\\/,
    what: '本机绝对路径（含 Windows 用户名）',
    allow: /<你的用户名>|<username>|<user>|<USER>/,
  },
];

/** 不检查这些（构建产物、依赖、被忽略的抓包数据、本文件） */
const SKIP_PATH = [
  /^node_modules\//,
  /^\.output\//,
  /^dist\//,
  /^\.tmp\//,
  /^\.workbuddy-ai\//,
  /^poc\/verify\/bg-ssr\.json$/,
  /^poc\/verify\/bg\.html$/,
  /^scripts\/check-secrets\.mjs$/,
];

/** 行内豁免标记：`secrets-ok: 说明理由` */
const ALLOW_MARKER = /secrets-ok/;

/** 文档类只跑哈希比对 + 字面量，跳过凭据/路径正则（性能） */
const DOC_EXT = /\.(md|txt)$/;

/**
 * 检查一行，返回命中描述列表。
 *
 * @param line 单行文本
 * @param deep 是否跑"重"的正则（凭据 / 路径）
 */
function scanLine(line, deep) {
  if (ALLOW_MARKER.test(line)) return [];

  const hits = [];

  // ── 哈希比对（所有文件都跑）──
  for (const re of CANDIDATE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const what = BANNED_HASHES.get(hashOf(m[0]));
      if (what) hits.push(what);
    }
  }

  if (!deep) return hits;

  for (const { pattern, what } of CREDENTIAL_PATTERNS) {
    if (pattern.test(line) && !FAKE_MARKER.test(line)) hits.push(what);
  }

  for (const { pattern, what, allow } of LOCAL_PATH_PATTERNS) {
    if (pattern.test(line) && !(allow && allow.test(line))) hits.push(what);
  }

  return hits;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function listTrackedFiles() {
  return git(['ls-files']).split('\n').filter(Boolean);
}

function listWorktreeFiles() {
  const tracked = git(['ls-files']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set((tracked + untracked).split('\n').filter(Boolean))];
}

/**
 * 只取**暂存区里新增或修改的行**。
 *
 * 改 1 行 → 只查 1 行；改 50 个文件 → 只查那 50 个文件的 diff。
 * 这是 pre-commit 钩子能跑得快（~250ms）的关键。
 *
 * @returns `{ file, line, text }[]`；无 HEAD 时返回 null
 */
function listStagedLines() {
  let diff;
  try {
    diff = git(['diff', '--cached', '--unified=0', '--no-color', '--diff-filter=ACMR']);
  } catch {
    return null;
  }

  const out = [];
  let current = null;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      current = raw.slice(6);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ file: current, line: newLine, text: raw.slice(1) });
      newLine++;
    }
  }

  return out;
}

function scanFileText(file, text, findings) {
  const deep = !DOC_EXT.test(file);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const what of scanLine(lines[i], deep)) {
      findings.push({ file, line: i + 1, what, text: lines[i].trim().slice(0, 100) });
    }
  }
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────

const argv = process.argv.slice(2);
const MODE = argv.includes('--commit-msg')
  ? 'commit-msg'
  : argv.includes('--staged')
    ? 'staged'
    : argv.includes('--history')
      ? 'history'
      : argv.includes('--all')
        ? 'all'
        : 'tracked';

const findings = [];

if (MODE === 'commit-msg') {
  /**
   * 检查**提交信息**。
   *
   * ## 为什么单独一个模式（2026-10-27 第二次踩坑）
   *
   * 我把「脱敏了哪些值」写进了 commit message 的表格里 ——
   * 于是这个「修复泄露」的提交本身又泄露了一遍。
   *
   * 早期还有两个提交用真实会员到期日举例说明 bug。
   *
   * 教训：**提交信息是公开内容，和文件内容同等对待。**
   * 描述"改了什么"用类别，不要用具体值。
   */
  const msgFile = argv.find((a) => !a.startsWith('--'));
  let msg = '';
  if (msgFile) {
    try {
      msg = readFileSync(msgFile, 'utf8');
    } catch {
      console.error('[secrets] 读不到提交信息文件：' + msgFile);
      process.exit(1);
    }
  } else {
    msg = git(['log', '-1', '--format=%B']);
  }

  msg.split('\n').forEach((line, i) => {
    const hits = scanLine(line, true);

    for (const what of hits) {
      findings.push({ file: 'commit message', line: i + 1, what, text: line.trim().slice(0, 120) });
    }

    /**
     * 通用规则：提交信息里出现 **9 位以上连续数字** 就警告。
     *
     * 文件里的长数字大多是合法的（版本号、时间戳常量、测试数据），
     * 但**提交信息里几乎没有合理理由出现 9 位以上数字** ——
     * mid / uid / 毫秒时间戳 / 会员到期日全在这个区间。
     *
     * 已命中具体规则的不重复报，否则一行两报、输出糊成一团。
     * 误报豁免：行内写 `secrets-ok: 理由`。
     */
    if (hits.length === 0 && !ALLOW_MARKER.test(line) && /\b\d{9,}\b/.test(line)) {
      findings.push({
        file: 'commit message',
        line: i + 1,
        what: '提交信息含 9 位以上数字（疑似 mid / 时间戳）',
        text: line.trim().slice(0, 120),
      });
    }
  });
} else if (MODE === 'staged') {
  const staged = listStagedLines();

  if (staged === null) {
    for (const file of listTrackedFiles()) {
      if (SKIP_PATH.some((re) => re.test(file))) continue;
      try {
        scanFileText(file, readFileSync(file, 'utf8'), findings);
      } catch {
        continue;
      }
    }
  } else {
    for (const { file, line, text } of staged) {
      if (SKIP_PATH.some((re) => re.test(file))) continue;
      const deep = !DOC_EXT.test(file);
      for (const what of scanLine(text, deep)) {
        findings.push({ file, line, what, text: text.trim().slice(0, 100) });
      }
    }
  }
} else if (MODE === 'history') {
  const commits = git(['rev-list', '--all']).split('\n').filter(Boolean);
  process.stderr.write('[secrets] 扫描 ' + String(commits.length) + ' 个提交的历史…\n');

  for (const c of commits) {
    // 1. 提交信息
    const msg = git(['log', '-1', '--format=%B', c]);
    msg.split('\n').forEach((line, i) => {
      for (const what of scanLine(line, true)) {
        findings.push({
          file: 'commit message @ ' + c.slice(0, 7),
          line: i + 1,
          what,
          text: line.trim().slice(0, 120),
        });
      }
    });

    // 2. 文件内容
    let files;
    try {
      files = git(['ls-tree', '-r', '--name-only', c]).split('\n').filter(Boolean);
    } catch {
      continue;
    }
    for (const file of files) {
      if (SKIP_PATH.some((re) => re.test(file))) continue;
      let text;
      try {
        text = git(['show', c + ':' + file]);
      } catch {
        continue;
      }
      const before = findings.length;
      scanFileText(file, text, findings);
      for (let i = before; i < findings.length; i++) {
        findings[i].file = findings[i].file + ' @ ' + c.slice(0, 7);
        findings[i].what = '历史中：' + findings[i].what;
      }
    }
  }
} else {
  const files = MODE === 'all' ? listWorktreeFiles() : listTrackedFiles();
  for (const file of files) {
    if (SKIP_PATH.some((re) => re.test(file))) continue;
    try {
      scanFileText(file, readFileSync(file, 'utf8'), findings);
    } catch {
      continue;
    }
  }
}

if (findings.length === 0) {
  const label =
    MODE === 'commit-msg'
      ? '提交信息'
      : MODE === 'staged'
        ? '暂存区'
        : MODE === 'history'
          ? '全部历史'
          : MODE === 'all'
            ? '工作区'
            : '已跟踪文件';
  console.log('[secrets] ✅ ' + label + '未发现测试账号标识或凭据');
  process.exit(0);
}

console.error('[secrets] ❌ 模式 ' + MODE + ' 下发现 ' + String(findings.length) + ' 处敏感信息\n');
for (const f of findings) {
  console.error('  ' + f.file + ':' + String(f.line) + '  [' + f.what + ']');
  console.error('    ' + f.text + '\n');
}
console.error('处理方式：');
console.error('  · 账号标识 → 换成 {{主账号mid}} 这类占位符（代码里用假数字）');
console.error('  · 确属误报 → 在该行加注释 `secrets-ok: 理由`');
console.error('  · 已提交过的 → 仅改文件不够，历史里仍能搜到，需重写历史');
process.exit(1);
