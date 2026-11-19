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
import { readFileSync, writeFileSync } from 'node:fs';

/** 哈希盐。公开无妨 —— 作用是防彩虹表，不是防解密 */
const SALT = 'pluma-secrets-v1';

function hashOf(value) {
  return createHash('sha256')
    .update(SALT + ':' + value)
    .digest('hex')
    .slice(0, 32);
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
 * **取流签名**（`upsig`）—— 2026-11-19 补。这一条迟到了 25 天。
 *
 * ## 为什么它必须单独一类，不能塞进 `CREDENTIAL_PATTERNS`
 *
 * `CREDENTIAL_PATTERNS` 走 `FAKE_MARKER` 判据（含 `fake` / `deadbeef` 就放过）。
 * 签名的"假值"判据**完全不同**：它不是靠标记，是靠**被截断** ——
 * `upsig=7baa0aee…` 是合法示例（只说明格式），`upsig=4a03cb8f25edb2…`（32 位完整）是凭据。
 * 用同一个数组会让下一个改的人以为两者判据一致，然后改错一边。
 *
 * ## 为什么长度门槛是 16
 *
 * 实测 5 个泄漏文件里 **98 处签名，长度全部是 32**（hex）。
 * 而仓库里合法出现的 upsig 值最长 11（`SECRETUPSIG` 测试桩）。
 * 16 是两者之间的空档 —— 卡得住真签名，放过所有示例。
 *
 * `%3D` 那个分支管 URL 编码形态（`?upsig%3D...`），抓包产物里两种都出现过。
 *
 * ## 为什么归到"凭据"而不是"敏感标识"
 *
 * B站 的 `.m4s` 地址带 `upsig` + `uparams`（被签名的参数名）。签名在 `deadline`
 * 到期前**可直接取流，不需要任何 Cookie**。所以它的性质是**一次性授权凭据**，
 * 与 `SESSDATA` 同级，不是"标识信息"。
 */
const SIGNATURE_PATTERNS = [
  {
    pattern: /\bupsig(?:=|%3D)([A-Za-z0-9_-]{16,})/g,
    what: '取流签名 upsig（有效期内可直接取流）',
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
  /^scripts\/check-secrets\.mjs$/,
];

/**
 * ⚠️ **2026-11-19 删掉了两条**：`poc/verify/bg-ssr.json` 与 `poc/verify/bg.html`。
 *
 * 它们原本在名单里，理由是"这两个是已知的抓包产物、已从索引移除"。
 * 但那个理由**自相矛盾** —— 名单的语义是"这个路径不值得检查"，
 * 而这两个文件恰恰是**最该被检查的**（各含 20 处完整签名）。
 *
 * 后果是真实发生过的：2026-11-19 用 `--all` 扫工作区，
 * 这两个文件正在磁盘上、共 40 处签名，检查器打的是 **✅ 未发现**。
 * "已从索引移除"只能保证它不再被提交，**保证不了它不被重新 add** ——
 * 而 pre-commit 钩子正是防"重新 add"的那道门，却被自己豁免掉了。
 *
 * 教训：`SKIP_PATH` 只该放"内容由构造保证安全"的路径（构建产物、本文件本身）。
 * **已知有问题的文件必须留在检查范围内**，否则检查器就成了它的保护伞。
 */

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

  /**
   * 签名检查**不看 `FAKE_MARKER`**，也**不看 `deep`**。
   *
   * 判据是"够不够长"（够长就是完整的签名，就是能用的凭据），
   * 而不是"有没有写 fake"—— 一份真实抓包的 URL 里当然不会有 fake 字样。
   * 放过截断示例靠的是 16 位门槛，不是靠标记。
   *
   * ## ⚠️ 2026-11-19 修：原来这段在 `if (!deep) return hits` 之后
   *
   * 而 `deep = !DOC_EXT.test(file)`，于是 `.md` / `.txt` 走浅路径时
   * **签名检查被整段跳过** —— 实测把 32 位完整 `upsig` 追加进
   * `docs/guides/security-notes.md` 再 `git add`，
   * `--staged` 报"✅ 暂存区未发现…"、退出码 0。
   * 一份审计文档里贴一段抓包原文，正是最容易发生的事。
   *
   * 现状：签名正则只是一次定长回溯，跑在文档上也不会拖慢（实测 --all 无感），
   * 所以提到 `deep` 判断之前，全文件类型都跑。
   */
  for (const { pattern, what } of SIGNATURE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) hits.push(what);
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

/**
 * 工作区**全部**文件，含被 `.gitignore` 忽略的。
 *
 * ## ⚠️ 2026-11-19 修：原来用 `--others --exclude-standard`，等于主动避开雷区
 *
 * 旧实现只列"已跟踪 + 未跟踪且没被忽略"，于是 `poc/probe/` 下 `raw/` 那些
 * **被 gitignore 罩着的抓包产物**永远不在扫描范围里 ——
 * 而它们正是签名最容易躺的地方。
 *
 * 更荒诞的是逻辑本身：`.gitignore` 的职责是"挡住 `git add`"，
 * 不是"这个文件从此不用复查"。一个被忽略的文件如果**正在磁盘上**，
 * 它随时可能被 `git add -f`、被 `--no-verify` 绕过、被复制到别的路径再提交。
 * 忽略规则不等于免疫。
 *
 * 现在用 `--others`（**不带** `--exclude-standard`），把被忽略的也列进来。
 * 真正的构建产物由 `SKIP_PATH` 排掉（`node_modules/` / `.output/` / `dist/` / `.tmp/`），
 * 那是按目录排除，语义清晰；而不是按"有没有被 gitignore"这种间接信号排除。
 *
 * 代价（2026-11-19 实测）：`git ls-files --others` 列 26201 条要用 **3.8s**
 * （其中 14732 条来自 `node_modules/`）。但 `SKIP_PATH` 按目录排掉之后
 * **只剩 1819 个待扫文件**，实际扫描不慢。`--all` 本就是"发布前人工跑一次"的档位，
 * 不是 pre-commit 钩子的热路径（那个走 `--staged`，只读 diff）。
 *
 * 若将来还要更快：**给 `SKIP_PATH` 加具体目录**，不要退回 `--exclude-standard`
 * —— 那等于又把被忽略的抓包目录关到门外，正是这次要修的 bug。
 */
function listWorktreeFiles() {
  const tracked = git(['ls-files']);
  // --others 不带 --exclude-standard：被 gitignore 的也要查（见上面的理由）
  const others = git(['ls-files', '--others']);
  return [...new Set((tracked + others).split('\n').filter(Boolean))];
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
  /**
   * 二进制文件直接跳过。
   *
   * ## 为什么必须判（2026-11-19）
   *
   * `--all` 现在会列到 `poc/probe/.../raw/repro6/p-probe/Default/Login Data`
   * 这类 **Chrome profile 的 SQLite 文件**。它们含 NUL 字节，按 UTF-8 解码后
   * 变成一长串乱码 —— 而乱码里**恰好会凑出 16 位以上的 `upsig=` 形态**，
   * 于是报出一堆假签名（实测 12 处假命中）。
   *
   * 判据：**含 NUL 就当二进制**。这比按扩展名准 —— `Login Data` 没有扩展名。
   *
   * 代价：真有二进制里藏签名的场景会漏。但那类东西本来也不该进仓库，
   * 且 `.gitignore` 与 `SKIP_PATH` 已按目录挡住；本检查不承担查二进制的职责。
   */
  if (text.indexOf('\u0000') >= 0) return;

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

/**
 * ## 历史扫描的起点：增量水印（2026-11-19 加）
 *
 * ### 为什么不再每次全量
 *
 * 全量扫描每次重扫全部 400+ 提交 / 约 5100 个对象，实测 29 秒。
 * 但其中 **91 处是静态的既有基线**：那些文件 2026-10-25 / 11-15 就入库了，
 * 内容一个字都没变。每次发版重扫一遍，除了把这 91 处原样再报一次，
 * 什么新信息都不产生 —— 纯粹的重复劳动。
 *
 * ### 增量为什么够用
 *
 * 只需扫「**上次验证过之后新增的提交**」。关键在于
 * `git rev-list <w>..HEAD --objects` **能捞到「加了又删」的 blob** ——
 * 专门验过，因为那正是本次事故的形态（`bg-ssr.json` 10-25 入库、10-27 移出）：
 * ```
 * $ git rev-list <watermark>..HEAD --objects | grep leak
 * 911bcc9… leak.json        ← 加了又删，照样能捞到
 * ```
 * 实测 265 个对象 / **0.8 秒**（vs 全量 5095 个对象 / 29 秒）。
 *
 * ### 保守降级（宁可白跑，不能漏扫）
 *
 * 两种情况自动退回全量：
 *  - **水印文件不存在**（首次、或 clone 后没扫过）
 *  - **水印不是 HEAD 的祖先**（历史被 rewrite / force-push 过；
 *    此时差集语义不可信）
 *
 * 水印放 `.git/pluma-secrets-watermark` 是**有意的**：本地状态，
 * 不进版本控制、不随 clone 传播。每个 clone 各自打自己的水印，谁也不替别人担保。
 * 想强制全量：加 `--full`。
 */
const WATERMARK_FILE = '.git/pluma-secrets-watermark';

/**
 * 读水印并校验是否仍可用。
 *
 * @returns {{ sha: string | null, reason: string }} sha 为 null 时 reason 说明为何退回全量
 */
function readWatermark() {
  let sha = '';
  try {
    sha = readFileSync(WATERMARK_FILE, 'utf8').trim();
  } catch {
    return { sha: null, reason: '还没有水印（首次扫描或 clone 后未扫过）' };
  }
  if (sha === '') return { sha: null, reason: '水印文件是空的' };

  // 水印必须是真实 commit 且是 HEAD 的祖先；不是祖先说明历史被 rewrite 过
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' });
  } catch {
    return {
      sha: null,
      reason: `水印 ${sha.slice(0, 7)} 不是 HEAD 的祖先（历史可能被 rewrite 过）`,
    };
  }
  return { sha, reason: '' };
}

/** 增量起点。只在 `--history` 模式下读水印，其它模式不白跑 git */
const WM =
  argv.includes('--history') && !argv.includes('--full')
    ? readWatermark()
    : { sha: null, reason: '本次显式要求全量（--full）' };

const MODE = argv.includes('--commit-msg')
  ? 'commit-msg'
  : argv.includes('--staged')
    ? 'staged'
    : argv.includes('--history')
      ? 'history'
      : argv.includes('--all')
        ? 'all'
        : 'tracked';

/** 历史扫描范围：有水印走 `w..HEAD`，否则 `--all` */
const HISTORY_RANGE = MODE === 'history' && WM.sha !== null ? [`${WM.sha}..HEAD`] : ['--all'];

/** 本次是否为增量（供基线判定用） */
const incremental = MODE === 'history' && WM.sha !== null;

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
  /**
   * ## ⚠️ 2026-11-19 重写：从"按提交"改成"按 blob"
   *
   * 旧实现遍历 400+ 个提交，每个提交先 `ls-tree -r` 再对**每个文件** `git show c:path`。
   * 实测在 Windows 上 **跑了 40 分钟没结束**，最后为了发版只能手工用一行 shell 绕过它 ——
   * 也就是说**这个模式实际上是不可用的**，"发布前扫一遍历史"这条防线形同虚设。
   *
   * 根本原因是重复劳动：`poc/.../repro5/console-full-video.json` 这个 blob
   * 在它存在的每一个提交里都会被重新读一遍、重新扫一遍，而**内容完全没变**。
   * 本项目 404 个提交、全部历史合计约 4700 个 (blob, path) 对，
   * 但**唯一 blob 只有 5483 个**（对象库总量），重复率极高。
   *
   * 新实现两步：
   *   1. `rev-list --all --objects` 一次拿到全部 (blob, path)，按 blob 去重
   *   2. `cat-file --batch` 单进程批量喂 —— 不 fork，不重复读
   *
   * 实测 **7.8 秒**扫完全部历史（同样 98 处签名，结论与 40 分钟那版一致）。
   *
   * 代价：报告里只能给**最后一次出现**的提交（blob 被多个提交引用时不知道该算哪个）。
   * 这是有意的取舍 —— 排查时真正要的是"哪个文件、多少处、现在还在不在"，
   * 精确到提交可以用 `git log --all -- <path>` 单独查。
   */
  const lines = git(['rev-list', ...HISTORY_RANGE, '--objects'])
    .split('\n')
    .filter(Boolean);

  /** blob sha → 出现过的路径（同一个 blob 可能有多个路径/多个历史名字） */
  const blobs = new Map();
  const commitShas = [];

  for (const line of lines) {
    const sp = line.indexOf(' ');
    if (sp < 0) {
      // 没有路径 → 这是 commit 本身
      commitShas.push(line);
      continue;
    }
    const sha = line.slice(0, sp);
    const path = line.slice(sp + 1);
    if (!blobs.has(sha)) blobs.set(sha, path);
  }

  process.stderr.write(
    incremental
      ? `[secrets] 历史：**增量**扫 ${WM.sha.slice(0, 7)}..HEAD（${String(commitShas.length)} 个提交 / ${String(blobs.size)} 个对象）…\n`
      : `[secrets] 历史：**全量**扫（${String(commitShas.length)} 个提交 / ${String(blobs.size)} 个对象，原因：${WM.reason || '无可用水印'}）…\n`,
  );

  // ── 1. 提交信息（这个必须逐条，量小） ──
  for (const c of commitShas) {
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
  }

  // ── 2. 文件内容：批量 cat-file，单进程 ──
  const wanted = [...blobs.entries()].filter(([, path]) => !SKIP_PATH.some((re) => re.test(path)));
  process.stderr.write('[secrets] 待扫对象 ' + String(wanted.length) + ' 个…\n');

  if (wanted.length > 0) {
    const batch = execFileSync('git', ['cat-file', '--batch'], {
      input: wanted.map(([sha]) => sha).join('\n') + '\n',
      maxBuffer: 1024 * 1024 * 1024,
    });

    /**
     * 解析 `cat-file --batch` 的输出：
     *   `<sha> <type> <size>\n<内容>\n` 重复
     *
     * 内容里可能含任意字节，所以按**字节偏移**切，不能按行跑 split('\n')。
     */
    let pos = 0;
    let idx = 0;
    while (pos < batch.length && idx < wanted.length) {
      const nl = batch.indexOf(0x0a, pos);
      if (nl < 0) break;
      const header = batch.subarray(pos, nl).toString('utf8');
      pos = nl + 1;

      // 缺失的对象会回 `<sha> missing`（没 size）
      const m = /^\S+ (\S+) (\d+)$/.exec(header);
      if (!m) {
        idx++;
        continue;
      }
      const size = Number(m[2]);
      const raw = batch.subarray(pos, pos + size);
      pos += size + 1; // 跳过内容后的换行

      const [, path] = wanted[idx];
      const text = raw.toString('utf8');
      const before = findings.length;
      scanFileText(path, text, findings);
      for (let i = before; i < findings.length; i++) {
        findings[i].file = '历史: ' + findings[i].file;
        findings[i].what = '历史中：' + findings[i].what;
      }
      idx++;
    }
  }

  /**
   * ## 基线：已确认并接受的历史泄漏
   *
   * 没有基线时，`--history` 会**永久红** —— 因为 2026-11-19 之前那 5 个文件
   * 确实在历史里，而历史重写是一个"有触发条件才做"的决策（见 security-notes.md）。
   *
   * 一个永远红的检查项**等于没有检查项**：它迟早被人 `--no-verify` 或改代码绕过，
   * 那之后就什么也拦不住了。所以必须能区分：
   *
   * - **基线内**的命中 → 打印为 ⚠️（知道、接受、记录在案），不影响退出码
   * - **基线外**的命中 → ❌ 红（**新的**泄漏，必须立刻处理）
   *
   * 基线只在"另一次泄漏真的发生"时才会变长，而每次变长都应该同步更新
   * `security-notes.md` 并重新评估要不要洗历史。
   *
   * ⚠️ 基线**只增不减**（与 `BANNED_HASHES` 同理）：洗了历史之后，
   * 相应的条目才能删 —— 删早了等于把"还没洗"这件事忘了。
   */
  const HISTORY_BASELINE = new Set([
    // 2026-11-19 核实：完整 upsig，签名全部于 2026-11-12 前失效，mid 已脱敏
    'poc/probe/logout-login-round2/raw/repro5/console-full-video.json',
    'poc/probe/logout-login-round2/raw/repro5/console-video-recheck.json',
    'poc/probe/logout-login-round2/raw/repro5/console-full-bili-home.json',
    // 2026-11-19 核实：同上，deadline 2026-10-24 19:47 UTC（入库前 4 小时已失效）
    'poc/verify/bg-ssr.json',
    'poc/verify/bg.html',
  ]);

  let known = 0;
  const unexpected = [];
  for (const f of findings) {
    const path = f.file.replace(/^历史: /, '');
    /**
     * ## 增量模式下**不认基线**（2026-11-19）
     *
     * 基线说的是"2026-11-19 之前那批文件已经入库、我们接受现状"。
     * 增量扫的范围是**水印之后的新提交** —— 水印就是在"历史已知"的前提下打的，
     * 所以这个范围里出现的任何命中**都是新的**。
     *
     * 反例（实测过，不得不防）：`poc/verify/bg-ssr.json` 在基线里。
     * 如果有人在新提交里**又把它加回去**，按路径匹配就被判成"已知"而放过 ——
     * 那恰恰是最该报的一次。
     */
    const inBaseline = HISTORY_BASELINE.has(path) || /^v\d+\.\d+\.\d+$/.test(path);
    if (!incremental && inBaseline) {
      known++;
      continue;
    }
    unexpected.push(f);
  }

  if (unexpected.length === 0) {
    console.log(
      `[secrets] ✅ 历史已扫完（${incremental ? `增量 ${WM.sha.slice(0, 7)}..HEAD` : '全量'}，` +
        `${String(commitShas.length)} 个提交 / ${String(blobs.size)} 个对象，按 blob 去重）：` +
        `${String(known)} 处命中全部落在**已记录的基线**里（见 security-notes.md）`,
    );
    console.log('  基线不是"安全"，是"知道并接受"。要处置请读 docs/guides/security-notes.md');

    // 扫到 HEAD 且无新命中 → 推进水印（全量退化时同样适用，HEAD 已在范围内）
    try {
      const head = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(WATERMARK_FILE, head + '\n');
      console.log(`[secrets] 水印已更新 → ${head.slice(0, 7)}（下次只扫这之后的提交）`);
    } catch {
      /* 打不上水印不影响本次结论 */
    }
    process.exit(0);
  }

  console.error(
    '[secrets] ⚠️  历史里有 ' +
      String(unexpected.length) +
      ' 处命中**不在基线内**（另有 ' +
      String(known) +
      ' 处在基线内）：',
  );
  findings.length = 0;
  findings.push(...unexpected);
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

/**
 * 按文件汇总，只对命中最重的几个文件展开行号。
 *
 * ## 为什么不能像以前那样全量逐条打
 *
 * 2026-11-19 加上签名检查后，`--all` 在单个 `poc/probe/pcdn-diag/pcdn-4k-ab.json`
 * 一个文件里就报了 **270 处**，全部文件合计 **1130 处**。逐条打印等于把终端刷爆，
 * 而**被刷爆的输出等于没输出** —— 真正要看的那 5 个文件会被淹掉。
 *
 * 汇总的另一个好处：判据从"数出现几次"变成"**哪些文件在漏**"。
 * 修的时候是按文件修的（删掉 / 脱敏 / 加 ignore），不是按行修的。
 */
const byFile = new Map();
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}
const ranked = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

/**
 * 把命中分成「已经进了仓库」与「只在本地磁盘」。
 *
 * ## 为什么这个区分是全篇最重要的信息（2026-11-19）
 *
 * 实测 `--all` 报 2208 处，但其中 **2200 处左右都在被 `.gitignore` 忽略的本地目录里**
 * （`poc/probe/pcdn-diag/*.json` 那些抓包原始数据）。它们确实是真签名、真 mid，
 * 但**没有进过仓库**，不存在"已经泄漏"的问题。
 *
 * 而真正要紧的是那几十处**已跟踪文件**里的命中 —— 那是已经推上 GitHub 的东西。
 *
 * 不区分的话，人看到"2208 处"只会去改最容易改的（本地文件），
 * 反而把真正在仓库里的漏掉。**优先级必须由输出本身表达**，不能靠读者自己判断。
 */
const trackedSet = new Set(listTrackedFiles());
const inRepo = ranked.filter(([file]) => trackedSet.has(file));
const localOnly = ranked.filter(([file]) => !trackedSet.has(file));

function printGroup(title, items, detailLimit) {
  if (items.length === 0) return;
  const total = items.reduce((s, [, l]) => s + l.length, 0);
  console.error(
    '  ' + title + '（' + String(total) + ' 处 / ' + String(items.length) + ' 个文件）',
  );
  for (const [file, list] of items) {
    console.error('    ' + String(list.length).padStart(5) + '  ' + file);
  }
  for (const [file, list] of items.slice(0, detailLimit)) {
    const kinds = [...new Set(list.map((x) => x.what))].join(' / ');
    const lines = [...new Set(list.map((x) => x.line))].slice(0, 8);
    console.error('  ⁃ ' + file + '  [' + kinds + ']');
    console.error(
      '      行 ' +
        lines.join(', ') +
        (list.length > lines.length ? ' …（共 ' + String(list.length) + ' 处）' : ''),
    );
    console.error('      例：' + list[0].text.slice(0, 90));
  }
  console.error('');
}

/**
 * 历史模式全是"已入库"（本就是扫仓库历史），文件字段带 `历史:` 前缀，
 * 按 tracked 判定会全部落进"仅本地"，所以单独处理。
 */
if (MODE === 'history') {
  const total = ranked.reduce((s, [, l]) => s + l.length, 0);
  console.error('  历史里 ' + String(total) + ' 处 / ' + String(ranked.length) + ' 个对象：');
  for (const [file, list] of ranked) {
    const kinds = [...new Set(list.map((x) => x.what))].join(' / ');
    console.error('    ' + String(list.length).padStart(5) + '  ' + file + '  [' + kinds + ']');
  }
  console.error('');
} else {
  if (inRepo.length > 0) {
    printGroup('⚠️ 已在版本控制内（会随 push 一起公开）', inRepo, 5);
  }
  if (localOnly.length > 0) {
    printGroup('仅本地磁盘（被 .gitignore 挡住，未入库）', localOnly, 2);
  }
}

console.error('处理方式：');
console.error(
  '  · 已在版本控制内 → **优先处理**。改文件后仍要 `git rm --cached`，历史见 security-notes.md',
);
console.error('  · 仅本地 → 不要 `git add -f` 它；要留证据就截断成 `upsig=7baa0aee…`');
console.error('  · 账号标识 → 换成 {{主账号mid}} 这类占位符（代码里用假数字）');
console.error('  · 确属误报 → 在该行加注释 `secrets-ok: 理由`');
process.exit(1);
