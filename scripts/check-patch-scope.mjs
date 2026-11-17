#!/usr/bin/env node
/**
 * 响应体改写范围检查 —— 防"静默越权"。
 *
 * ## 为什么需要这个脚本
 *
 * `src/content/main-world.js` 会**改写 B 站接口响应**（把会员字段改成"已开通"），
 * 好让播放器不弹充值页。这是 [ADR 0013] 明确授权的唯一例外 —— 而
 * `AGENTS.md` §3 决策 5 写的是「**不做伪装的会员标识，连开关都不放**」，
 * 例外范围必须精确。
 *
 * 风险在于：谁往 `PATCH_PATHS` 里**加一条路径**，都不会报任何错。
 * `tsc` 看不见（这是裸 JS），单测也测不到（要真实响应）。
 * 而这个动作的性质是**扩大越权范围**，属于本项目最敏感的一类改动。
 *
 * ## 检查什么
 *
 * 1. 代码里的 `PATCH_PATHS` 必须与 ADR 0013 授权集**完全一致**（会员字段伪装）
 * 2. 代码里的 `PROGRESS_PATCH_PATHS` 必须与 ADR 0017 授权集**完全一致**（观看进度还原）
 * 3. `PATCH_HOSTS` 必须是 `api.bilibili.com` + `api.biliapi.net`（ADR 0027）
 * 4. 两份 ADR 里的授权路径文本必须能被找到（ADR 被改坏了要能发现）
 * 5. `pgcSwapPlayviewBody()` 的**写集**必须落在 ADR 0023 的授权字段集内（2026-11-17 补）
 * 6. `pgcPatchPlayinfo()` 只能替换 `result.video_info`，不许碰同级键（2026-11-17 补）
 *
 * ## ⚠️ 还没被守住的第五类：候选过滤（ADR 0038）
 *
 * `AGENTS.md` §5.5 现在列了**七行**改写，本脚本覆盖其中**六行**。唯一漏的是
 * ADR 0038 授权的「在取流数据上过滤 PCDN 候选」—— **因为实现常量还没落地**
 * （计划里是两个独立常量 + 独立函数，代码里一行都还没有）。
 *
 * **落地时必须同时补这条判据**，否则那道闸门对第五类不成立：本脚本会把一个
 * "看起来全绿"的仓库交出去，而第五类是**唯一**会动 `dash[].base_url` 的那一类
 * （前六类一个字节都不许碰 URL）。将来该断言什么，见文件末尾
 * 「候选过滤（ADR 0038）落地时要补什么」一节。
 *
 * ## 为什么是两份清单而不是一份
 *
 * 响应体改写有**六类**，性质各不相同，**合并检查就失去意义**：
 *   - 会员字段（ADR 0013）：改的是"权益外观"，边界要卡死在 vip.*
 *   - 观看进度（ADR 0017）：改的是"用户本来就有的数据"，边界是 last_play_*
 *   - PGC 试看标记（ADR 0021）/ 提示条（ADR 0022）：改的是"试看这件事看起来怎样"
 *   - PGC 整页注入（ADR 0020）/ 切集换流（ADR 0023）：换的是**整条流**，
 *     字段边界是"播放器能不能正常吃下这条流"，与上面四类的性质都不同
 * 合成一个清单，"这条路径是为了什么被授权"就查不出来了。
 *
 * 比对方式刻意选成"**两份清单在代码里对比**"，不做跨文件的模糊正则匹配：
 * 代码清单代表"实际在改什么"，ADR 清单代表"被授权改什么"，
 * 两者相等才算合规。加接口时**必须同时改 ADR**，否则这里会红。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-patch-scope.mjs
 * ```
 *
 * 有违规时退出码 1。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 实际执行改写的文件（裸 JS，main world） */
const MAIN_WORLD = 'src/content/main-world.js';

/**
 * 主机白名单的**真相源**（TS 常量）。
 *
 * ## 为什么需要跨文件比对（B-06，2026-10-29）
 *
 * `main-world.js` 是裸 JS，**没法 import TS 常量**，所以 `PATCH_HOSTS` 必然要手写一份。
 * 两份清单手工同步 = 必然漂移，而漂移的后果是静默的：
 *
 *   ADR 0027 加 `api.biliapi.net` 时，只靠 `main-world.js` 里的一行注释提醒
 *   「必须与 routes.ts 的 `BILI_API_HOSTS` 保持一致」。谁下次只改一边：
 *     - 只改 `routes.ts` → DNR 会换 Cookie，但 `main-world.js` 不改响应体
 *       → 会员字段没伪装 → 播放器判「无权限」→ 「点了 4K 菜单变了画面没变」
 *     - 只改 `main-world.js` → 改写一个 DNR 没代理的主机，请求仍是主账号身份，白写
 *   两种都不会报错，只会在真机上表现为「画质上不去」。
 *
 * 所以这里把「两边必须一致」变成机器断言。
 */
const ROUTES_TS = 'src/shared/constants/routes.ts';

/** 授权的唯一来源（会员字段伪装） */
const ADR_0013 = 'docs/decisions/0013-patch-player-info-response.md';

/** 授权的唯一来源（观看进度还原） */
const ADR_0017 = 'docs/decisions/0017-restore-primary-progress-in-playurl.md';

/**
 * ADR 0013 授权的路径，**硬编码在此并在注释里标明出处**。
 *
 * ⚠️ 为什么硬编码而不是从 ADR 文本里解析：
 *  - ADR 是给人读的散文，正则解析必然脆弱（列表格式一变就漏，且漏了不报错）
 *  - 硬编码后，ADR 改了但这里没改 → 检查会红 → 强迫人去核对
 *  - **改这个数组之前必须先改 ADR 0013**，否则就是绕过决策流程
 *
 * 出处：ADR 0013 「允许改写的接口」一行 + 「补充授权」一节（nav 于 2026-10-26 追加）。
 */
const AUTHORIZED_PATHS = ['/x/web-interface/nav', '/x/player/wbi/v2', '/x/player/v2'];

/**
 * ADR 0017 授权可改写**观看进度字段**的路径，同样硬编码。
 *
 * ⚠️ 这两份清单**不许合并**。它们授权的是两类完全不同的改写：
 *   - AUTHORIZED_PATHS        → 把会员字段伪装成已开通（扩大的是"权益外观"）
 *   - AUTHORIZED_PROGRESS_PATHS → 把 `last_play_time` / `last_play_cid` 还原成主账号的
 *                                （改的是"用户本来就有的数据"）
 * 合并成一个清单，将来就分不清哪条路径是为了什么被授权的。
 *
 * 出处：ADR 0017 「决策」一节的代码块。
 */
const AUTHORIZED_PROGRESS_PATHS = ['/x/player/wbi/playurl', '/x/player/playurl'];

/** 授权的唯一来源（PGC 试看标记，2026-10-28 新增） */
const ADR_0021 = 'docs/decisions/0021-patch-pgc-preview-flags.md';

/**
 * ADR 0021 授权可改写的**字段**（不是路径），同样硬编码。
 *
 * ⚠️ 这一份和上面两份**必须分开**：前两份按**路径**授权（哪些接口的响应能碰），
 * 这一份按**字段**授权（PGC 的播放数据里哪几个标记能改）。
 * 合并成一个结构，将来就分不清"这条是为了什么被授权的"。
 *
 * 边界：只改"这份数据是不是试看"，不碰 `user_status.has_paid` / `vip_info` / `supplement`。
 *
 * 出处：ADR 0021「决策」一节的表格。
 */
const AUTHORIZED_PGC_FLAGS = ['play_video_type', 'play_check.play_detail', 'video_info.is_preview'];

/** 授权的唯一来源（PGC 试看提示条，2026-10-28 新增） */
const ADR_0022 = 'docs/decisions/0022-hide-pgc-preview-toast.md';

/**
 * 授权的唯一来源（PGC 切集换流，2026-11-17 补登进本脚本）。
 *
 * ⚠️ 这一份 ADR 2026-10-28 就落地了，**但本脚本一直没管它** —— 于是
 * `pgcSwapPlayviewBody()` 里往 `data` 上多写一个键，机器一句话都不说。
 * 那一类改写的性质是**换掉整条流**，比前四类都重。
 */
const ADR_0023 = 'docs/decisions/0023-intercept-playview-durl-swap.md';

/**
 * ADR 0023 授权 `pgcSwapPlayviewBody()` 在 **`data.video_info` 上**写的字段。
 *
 * 出处：ADR 0023「决定」第 1 条原话 ——
 * 「同步 `dash` / `type` / `format` / `quality` / `timelength` / `accept_quality` /
 * `accept_description` / `support_formats`，同时 `delete durl / durls`」；
 * 加上「边界」表最后一行（`durls` 必须删）与降级分支（无 dash 时写 `durl`、`delete dash`）。
 *
 * ⚠️ 为什么 `quality` / `support_formats` 能出现在这里，而 ADR 0038 又不许动它们：
 * 两件事的主语不同 —— **这里换的是整条流**（`playview` 的试看流 → 播放账号自己的
 * 完整流），那批字段必须是**新流自己的真值**，不同步就会灰屏/锁 720P（ADR 0023 实测）；
 * 而 ADR 0038 的候选过滤**不改流**，只从当次响应的候选里做减法，所以那里一个字都不许动。
 */
const AUTHORIZED_PLAYVIEW_WRITES = [
  'dash',
  'type',
  'format',
  'quality',
  'timelength',
  'accept_quality',
  'accept_description',
  'support_formats',
  /** 降级分支：响应里没有 dash 时换 durl（ADR 0023「边界」表的说明） */
  'durl',
];

/**
 * **必须出现**的同步字段 —— 少一个就红。
 *
 * 这不是"风格偏好"：ADR 0023 实测过 `type` 在两种响应里**连类型都不同**
 * （`"DASH"` 字符串 vs `3` 数字），不同步等于把 dash 管道整条关掉；
 * 不同步 `quality` / `support_formats` 则播放器菜单与实际轨对不上。
 *
 * 故意**不含** `durl`：它只属于降级分支，主路径本来就不该写。
 */
const REQUIRED_PLAYVIEW_WRITES = [
  'dash',
  'type',
  'format',
  'quality',
  'timelength',
  'accept_quality',
  'accept_description',
  'support_formats',
];

/**
 * ADR 0023 授权 `pgcSwapPlayviewBody()` **delete** 的字段。
 *
 * - `durl` / `durls`：有它们时播放器优先走 durl，会回到 720P（ADR 0023 实测）
 * - `dash`：降级分支里换 durl 时必须把 dash 清掉，否则播放器仍按 dash 准备管道
 */
const AUTHORIZED_PLAYVIEW_DELETES = ['durl', 'durls', 'dash'];

/**
 * **必须**出现的 delete —— 少一个就红。
 *
 * 故意**不含** `dash`：它只属于降级分支（无 dash 时换 durl）。
 * 把 `dash` 列成必删等于把"必须有降级分支"这条也钉死了，而那是实现选择，
 * 不是 ADR 的字段边界。
 */
const REQUIRED_PLAYVIEW_DELETES = ['durl', 'durls'];

/**
 * `pgcPatchPlayinfo()` 在 `result`（函数里的 `r`）上**只许写这一个键**。
 *
 * 出处：ADR 0020 / `AGENTS.md` §5.5 第 5 行 ——「把 `result.video_info` 换成缓存里的
 * 完整流」。`arc` / `play_check` / `user_status` 这些同级键**一个都不许碰**：
 * 碰 `arc` 等于改集号，碰 `user_status` 等于伪造权益（决策 5 的立法目的）。
 *
 * ⚠️ 试看标记（`r.play_video_type` / `r.play_check.play_detail`）不在这里写 ——
 * 它们由 `pgcPatchPreviewFlags(r)` 负责，那三个字段由 ADR 0021 的
 * `PGC_PREVIEW_FLAGS` 单独守着。所以这里的写集应当**恰好**只有 `video_info`。
 */
const AUTHORIZED_PLAYINFO_RESULT_WRITES = ['video_info'];

/**
 * ADR 0022 授权可隐藏的 DOM 选择器。
 *
 * ⚠️ 这一份授权的是**渲染层**（藏掉一条本地提示），不是数据层。
 * 前三份都是"改数据"，这一份是"不改数据、只是不显示已经过时的那句话"。
 * 合并进任何一份都会让"这条是为了什么被授权的"查不出来。
 *
 * 边界：只允许 `.bpx-player-toast-text` 这一个容器；
 * 扩大到 `.bpx-player-*` 会连带吃掉网络/解码等真实错误提示。
 */
const AUTHORIZED_PGC_TOAST = ['.bpx-player-toast-item'];

/**
 * 判定"这条 item 是试看提示"的标记。**与上面那行必须同源**。
 *
 * ⚠️ 两个常量不能合并成一个：
 *   - `AUTHORIZED_PGC_TOAST`：**在哪个容器上动手**（`.bpx-player-toast-item`）
 *   - 这个：**怎么认出是试看那条**（内部含 `PromptBar`）
 * 合并就查不出"藏了容器的哪些内容"这件事。
 */
const AUTHORIZED_PGC_TOAST_MARK = '[class*="PromptBar"]';

/** 授权的主机。扩展只改 B 站主站 API，别的域一律不许。 */
const AUTHORIZED_HOSTS = ['api.bilibili.com', 'api.biliapi.net'];

/**
 * 从源码里抽出一个 `var NAME = [...]` 形式的字符串数组字面量。
 *
 * @param {string} src
 * @param {string} name
 * @returns {string[] | null} null 表示没找到
 */
function extractStringArray(src, name) {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(src);
  if (!m) return null;

  const out = [];
  for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) out.push(s[1]);
  return out;
}

/**
 * 从源码里抽出一个 `var NAME = ['...']` 的选择器数组。
 *
 * ⚠️ **不能用 `extractStringArray`**（2026-10-28 踩到）：那个正则
 * `/\[([^\]]*)\]/` 会在选择器内部的 `]` 上提前收尾 ——
 * `['[class*="PromptBar_container"]']` 会被截成 `[class*="`，
 * 于是检查器对着一个错误的值做比对，**永远报不一致**（假红），
 * 而人一旦习惯了假红，真问题就漏了。
 *
 * 这里直接按整行取值，只认 `var NAME = [` 开头到行尾 `]` 之间的内容。
 */
function extractSelectorArray(src, name) {
  const line = src.split('\n').find((l) => l.trim().startsWith(`var ${name} = [`));
  if (!line) return null;
  const out = [];
  for (const m of line.matchAll(/'([^']*)'|"([^"]*)"/g)) out.push(m[1] ?? m[2]);
  return out;
}

/** 从源码里抽出一个 `var NAME = '...';` 的字符串字面量 */
function extractStringValue(src, name) {
  const line = src.split('\n').find((l) => l.trim().startsWith(`var ${name} = `));
  if (!line) return null;
  const m = /=\s*(?:'([^']*)'|"([^"]*)")/.exec(line);
  return m ? (m[1] ?? m[2]) : null;
}

function sameSet(a, b) {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/**
 * 把**注释与字符串字面量**的内容替换成空格（长度与偏移不变）。
 *
 * ## 为什么必须先遮蔽再做括号配对
 *
 * 要从源码里取下 `pgcSwapPlayviewBody()` 的函数体，就得数大括号。而
 * `main-world.js` 的注释里到处是 `{`：`{cls, flavor}`、`{ __ns, … }`、
 * `{ kind: 'absent' }`…… 直接数会在**注释里的那个 `}`** 上提前收尾，
 * 于是"函数体"被截断成前半段 —— 检查器**看不见后半段的越权写入**，
 * 而那正是最需要被看见的位置（换流写字段在 `.then()` 回调里，靠后）。
 *
 * 字符串同理（`'='`、`'{'` 都会骗过朴素正则）。所以先整体遮蔽，
 * 保留换行（行号可读）与所有结构字符。
 *
 * @param {string} src
 * @returns {string} 与入参**等长**的遮蔽文本
 */
function maskCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += quote;
      i += 1;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          // 转义：两字符一起吞掉（`\'` 不许当成收尾引号）
          out += '  ';
          i += 2;
          continue;
        }
        if (ch === quote) {
          out += quote;
          i += 1;
          break;
        }
        out += ch === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

/**
 * 取一个 `function NAME(...) { … }` 的**函数体**（大括号配对，返回遮蔽文本）。
 *
 * 返回遮蔽文本而不是原文：下面抽写集只需要标识符，注释/字符串已被抹掉，
 * 就不会把 `'vi.dash'` 这种**字符串里**的内容当成真的写入。
 *
 * @param {string} src
 * @param {string} name
 * @returns {string | null} null = 找不到这个函数（改名/删了 → 检查应当红）
 */
function extractFunctionBody(src, name) {
  const masked = maskCommentsAndStrings(src);
  const head = new RegExp(`function\\s+${name}\\s*\\(`).exec(masked);
  if (!head) return null;

  const parenOpen = masked.indexOf('(', head.index);
  const parenClose = masked.indexOf(')', parenOpen);
  if (parenOpen < 0 || parenClose < 0) return null;

  const open = masked.indexOf('{', parenClose);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) return masked.slice(open + 1, i);
    }
  }
  // 大括号不平衡 → 源码被改坏了，判失败（不猜）
  return null;
}

/**
 * 函数体里对某个对象**赋值**的键（支持 `a.b.c` 这种多级键）。
 *
 * 只认 `=` / `+=` / `-=`（`===` / `>=` 不会被误认）。
 *
 * @param {string} body `extractFunctionBody()` 的返回（**遮蔽过的**）
 * @param {string} obj 变量名（`vi` / `data` / `r`）
 * @returns {string[]} 去重后的键
 */
function extractWrittenKeys(body, obj) {
  const re = new RegExp(
    `\\b${obj}\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*(?:=(?!=)|\\+=|-=)`,
    'g',
  );
  const keys = [];
  for (const m of body.matchAll(re)) keys.push(m[1]);
  return [...new Set(keys)];
}

/**
 * 函数体里 `delete obj.key` 的键。
 *
 * @param {string} body 遮蔽过的函数体
 * @param {string} obj 变量名
 * @returns {string[]} 去重后的键
 */
function extractDeletedKeys(body, obj) {
  const re = new RegExp(`\\bdelete\\s+${obj}\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`, 'g');
  const keys = [];
  for (const m of body.matchAll(re)) keys.push(m[1]);
  return [...new Set(keys)];
}

/**
 * 从 `routes.ts` 里抽出 `BILI_API_HOSTS` 的成员。
 *
 * 它的写法是 `export const BILI_API_HOSTS = [BILI_API_HOST, 'api.biliapi.net'] as const;` ——
 * **第一个元素是个标识符**（`BILI_API_HOST`），不是一个字面量。
 * 所以不能套用 `extractStringArray()`（它只抓引号里的内容，会漏掉那一个）。
 *
 * 这里的做法：先取出 `BILI_API_HOST` 那个字符串常量，再把数组里的
 * 引号字面量也收进来，最后把标识符替换成它的值。
 * 数组结构变了（比如改成函数调用）就返回 null，让检查红 ——
 * 静默返回空数组会让断言变成"两边都空"的假绿。
 *
 * @param {string} src routes.ts 全文
 * @returns {string[] | null} null 表示解析失败
 */
function extractRoutesHosts(src) {
  const constMatch = /export\s+const\s+BILI_API_HOST\s*=\s*['"]([^'"]+)['"]/.exec(src);
  if (!constMatch) return null;
  const hostConst = constMatch[1] ?? '';

  const arrMatch = /export\s+const\s+BILI_API_HOSTS\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!arrMatch) return null;

  /** @type {string[]} */
  const out = [];
  for (const token of (arrMatch[1] ?? '').split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    const quoted = /^['"]([^'"]+)['"]$/.exec(trimmed);
    if (quoted) {
      out.push(quoted[1] ?? '');
    } else if (trimmed === 'BILI_API_HOST') {
      out.push(hostConst);
    } else {
      // 认不出的形态（函数调用 / 展开运算符）→ 判失败，不要猜
      return null;
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * 从源码里抽出一个 `var NAME = { ... }` 形式的**对象键**列表。
 *
 * 只认一级键（`a: v` 或 `'a.b': v`），不递归 —— 常量本身是扁平结构。
 *
 * @param {string} src
 * @param {string} name
 * @returns {string[] | null} null 表示没找到
 */
function extractObjectKeys(src, name) {
  const start = src.indexOf(`var ${name} = {`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;

  const body = src.slice(open + 1, end);
  const keys = [];
  // 匹配 `key:` 或 `'key':` 或 `"key":`
  for (const m of body.matchAll(/(?:^|[,{\n])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)) {
    keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return keys;
}

async function main() {
  const src = await readFile(join(ROOT, MAIN_WORLD), 'utf8');

  const actualPaths = extractStringArray(src, 'PATCH_PATHS');
  const actualHosts = extractStringArray(src, 'PATCH_HOSTS');

  const problems = [];

  if (actualPaths === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PATCH_PATHS = [...]\``,
      why: '脚本的比对基准丢失了。要么变量被改名，要么改写逻辑被整体移除 —— 两种情况都要人工确认。',
    });
  } else if (!sameSet(actualPaths, AUTHORIZED_PATHS)) {
    const extra = actualPaths.filter((p) => !AUTHORIZED_PATHS.includes(p));
    const missing = AUTHORIZED_PATHS.filter((p) => !actualPaths.includes(p));
    problems.push({
      what: `${MAIN_WORLD} 的 PATCH_PATHS 与 ADR 0013 授权集不一致`,
      why: [
        extra.length > 0
          ? `多出未授权路径：${extra.join(', ')} —— 这是**扩大越权范围**，必须先在 ADR 0013 里授权`
          : '',
        missing.length > 0
          ? `缺少已授权路径：${missing.join(', ')} —— 可能是有意收紧，请同步改 ADR`
          : '',
        `实际：${JSON.stringify(actualPaths)}`,
        `授权：${JSON.stringify(AUTHORIZED_PATHS)}`,
      ]
        .filter(Boolean)
        .join('\n    '),
    });
  }

  if (actualHosts === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PATCH_HOSTS = [...]\``,
      why: '主机白名单缺失，改写范围就无法界定。',
    });
  } else if (!sameSet(actualHosts, AUTHORIZED_HOSTS)) {
    problems.push({
      what: `${MAIN_WORLD} 的 PATCH_HOSTS 与授权主机不一致`,
      why: `实际：${JSON.stringify(actualHosts)}｜授权：${JSON.stringify(AUTHORIZED_HOSTS)}\n    → 加新主机等于扩大改写范围，必须先改 ADR 0013`,
    });
  }

  // ── B-06：PATCH_HOSTS 必须与 routes.ts 的 BILI_API_HOSTS **集合完全一致** ──
  //
  // 上面那条比对的是 `AUTHORIZED_HOSTS`（脚本里的硬编码）；这一条比对的是
  // `routes.ts`（代码里的真相源）。两者都要有：
  //   - `AUTHORIZED_HOSTS` 防"扩大越权"（多一个主机）
  //   - `BILI_API_HOSTS`   防"两处漂移"（DNR 代理的主机与响应体改写的主机不同步）
  // 只留前一条的话，谁会同时改 routes.ts 与这里的 AUTHORIZED_HOSTS，
  // 而 `main-world.js` 没改，检查仍然全绿 —— 正是 ADR 0027 加域名时的实际情形。
  let actualDnrHosts = null;
  try {
    const routesSrc = await readFile(join(ROOT, ROUTES_TS), 'utf8');
    actualDnrHosts = extractRoutesHosts(routesSrc);
    if (actualDnrHosts === null) {
      problems.push({
        what: `在 ${ROUTES_TS} 里解析不出 \`export const BILI_API_HOSTS = [...]\``,
        why:
          '主机白名单的真相源丢失或换了形态（比如变成函数调用）。检查器不能猜，' +
          "请改用 `export const BILI_API_HOSTS = [BILI_API_HOST, '…']` 的形态，或同步更新本脚本。",
      });
    }
  } catch {
    problems.push({
      what: `找不到 ${ROUTES_TS}`,
      why: '主机白名单的真相源缺失。`PATCH_HOSTS` 就没有可比对的基准了。',
    });
  }

  if (actualHosts !== null && actualDnrHosts !== null && !sameSet(actualHosts, actualDnrHosts)) {
    const extraInJs = actualHosts.filter((h) => !actualDnrHosts.includes(h));
    const missingInJs = actualDnrHosts.filter((h) => !actualHosts.includes(h));
    problems.push({
      what: `${MAIN_WORLD} 的 PATCH_HOSTS 与 ${ROUTES_TS} 的 BILI_API_HOSTS 不一致（B-06）`,
      why: [
        extraInJs.length > 0
          ? `PATCH_HOSTS 多出：${extraInJs.join(', ')} —— 这些主机 DNR 不会代理，改写等于白写`
          : '',
        missingInJs.length > 0
          ? `PATCH_HOSTS 缺少：${missingInJs.join(', ')} —— DNR 换了 Cookie 但响应体没改写，` +
            '会员字段仍是"未开通"，播放器判无权限（ADR 0027 踩过：点了 4K 菜单变了画面没变）'
          : '',
        `PATCH_HOSTS：${JSON.stringify(actualHosts)}`,
        `BILI_API_HOSTS：${JSON.stringify(actualDnrHosts)}`,
        '→ 主世界是裸 JS 无法 import TS 常量，两份必须手工同步；加主机时改完 routes.ts 记得改这里',
      ]
        .filter(Boolean)
        .join('\n    '),
    });
  }

  // ── 第二类：观看进度还原（ADR 0017） ──
  //
  // 这条路径**不在** ADR 0013 的授权集里，却同样在改响应体。
  // 只看 PATCH_PATHS 的话，往 playurl 上加改写不会报任何错 —— 正是这个脚本要防的事。
  const actualProgressPaths = extractStringArray(src, 'PROGRESS_PATCH_PATHS');

  if (actualProgressPaths === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PROGRESS_PATCH_PATHS = [...]\``,
      why: '续播修复的路径清单丢失了。要么被改名，要么修复被整体移除 —— 两种情况都要人工确认（用户会重新报"不记住进度"）。',
    });
  } else if (!sameSet(actualProgressPaths, AUTHORIZED_PROGRESS_PATHS)) {
    const extra = actualProgressPaths.filter((p) => !AUTHORIZED_PROGRESS_PATHS.includes(p));
    const missing = AUTHORIZED_PROGRESS_PATHS.filter((p) => !actualProgressPaths.includes(p));
    problems.push({
      what: `${MAIN_WORLD} 的 PROGRESS_PATCH_PATHS 与 ADR 0017 授权集不一致`,
      why: [
        extra.length > 0
          ? `多出未授权路径：${extra.join(', ')} —— 这是**扩大响应体改写范围**，必须先在 ADR 0017 里授权`
          : '',
        missing.length > 0
          ? `缺少已授权路径：${missing.join(', ')} —— 续播会失效，请同步改 ADR`
          : '',
        `实际：${JSON.stringify(actualProgressPaths)}`,
        `授权：${JSON.stringify(AUTHORIZED_PROGRESS_PATHS)}`,
      ]
        .filter(Boolean)
        .join('\n    '),
    });
  }

  let adr0017Text = '';
  try {
    adr0017Text = await readFile(join(ROOT, ADR_0017), 'utf8');
  } catch {
    problems.push({
      what: `找不到 ${ADR_0017}`,
      why: '授权来源缺失。改写 playurl 响应体这件事必须有 ADR 兜着，不能只剩代码。',
    });
  }
  if (adr0017Text) {
    const missingInAdr = AUTHORIZED_PROGRESS_PATHS.filter((p) => !adr0017Text.includes(p));
    if (missingInAdr.length > 0) {
      problems.push({
        what: `ADR 0017 里没有提到这些被授权的路径：${missingInAdr.join(', ')}`,
        why: 'ADR 被改动过。若是有意收紧授权，请同步本脚本的 AUTHORIZED_PROGRESS_PATHS；否则请恢复 ADR。',
      });
    }
  }

  // ── 第三类：PGC 试看标记（ADR 0021） ──
  //
  // 这一类改的是 `__playinfo__` 里的字段（不是网络响应），但性质与上面两类相同：
  // **改的是播放器看到的"权益外观"**。只看上面两份清单的话，
  // 往 `PGC_PREVIEW_FLAGS` 里加一个 `user_status.has_paid` 不会报任何错 —— 而那是最严重的一种越权。
  const actualPgcFlags = extractObjectKeys(src, 'PGC_PREVIEW_FLAGS');

  if (actualPgcFlags === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PGC_PREVIEW_FLAGS = {...}\``,
      why: 'PGC 试看标记清单丢失了。要么被改名，要么注入逻辑被整体移除 —— 两种情况都要人工确认（用户会重新报"播到 6 分钟就停"）。',
    });
  } else if (!sameSet(actualPgcFlags, AUTHORIZED_PGC_FLAGS)) {
    const extra = actualPgcFlags.filter((f) => !AUTHORIZED_PGC_FLAGS.includes(f));
    const missing = AUTHORIZED_PGC_FLAGS.filter((f) => !actualPgcFlags.includes(f));
    problems.push({
      what: `${MAIN_WORLD} 的 PGC_PREVIEW_FLAGS 与 ADR 0021 授权集不一致`,
      why: [
        extra.length > 0
          ? `多出未授权字段：${extra.join(', ')} —— 这是**扩大越权范围**，必须先在 ADR 0021 里授权`
          : '',
        missing.length > 0
          ? `缺少已授权字段：${missing.join(', ')} —— 播放会在试看结束点被拦，请同步改 ADR`
          : '',
        `实际：${JSON.stringify(actualPgcFlags)}`,
        `授权：${JSON.stringify(AUTHORIZED_PGC_FLAGS)}`,
      ]
        .filter(Boolean)
        .join('\n    '),
    });
  }

  let adr0021Text = '';
  try {
    adr0021Text = await readFile(join(ROOT, ADR_0021), 'utf8');
  } catch {
    problems.push({
      what: `找不到 ${ADR_0021}`,
      why: '授权来源缺失。改写 PGC 试看标记这件事必须有 ADR 兜着，不能只剩代码。',
    });
  }
  if (adr0021Text) {
    const missingInAdr = AUTHORIZED_PGC_FLAGS.filter((f) => !adr0021Text.includes(f));
    if (missingInAdr.length > 0) {
      problems.push({
        what: `ADR 0021 里没有提到这些被授权的字段：${missingInAdr.join(', ')}`,
        why: 'ADR 被改动过。若是有意收紧授权，请同步本脚本的 AUTHORIZED_PGC_FLAGS；否则请恢复 ADR。',
      });
    }
  }

  // ── 第四类：PGC 试看提示条（ADR 0022） ──
  //
  // 这一类改的是**页面渲染**（藏掉播放器左下角那条「试看中」），
  // 前三类改的是数据。同样属于"让界面看起来有权益"，必须卡死范围。
  const actualToast = extractSelectorArray(src, 'PGC_TOAST_ITEM');
  const actualToastMark = extractStringValue(src, 'PGC_TOAST_MARK');

  /**
   * 校验"筛选标记"本身。
   *
   * ⚠️ 这个必须单独查：只查容器（`.bpx-player-toast-item`）是不够的 ——
   * 那个容器里同时装着"跳过片头""续播""从头播放"等消息。
   * 真正保证不误伤的是**这条 `PromptBar` 筛选条件**，
   * 把它删掉就等于"藏掉整个 toast 层"，而那正是我们踩过的坑。
   */
  if (actualToastMark === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PGC_TOAST_MARK = '...'\``,
      why: '筛选标记缺失。没有它就无法区分"试看提示"和其它 toast 消息（跳过片头/续播/从头播放）。',
    });
  } else if (actualToastMark !== AUTHORIZED_PGC_TOAST_MARK) {
    problems.push({
      what: `${MAIN_WORLD} 的 PGC_TOAST_MARK 与 ADR 0022 授权集不一致`,
      why: [
        `实际：${JSON.stringify(actualToastMark)}`,
        `授权：${JSON.stringify(AUTHORIZED_PGC_TOAST_MARK)}`,
        '→ 改这个标记等于改"哪些消息会被藏"，必须先改 ADR 0022',
      ].join('\n    '),
    });
  }

  if (actualToast === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`var PGC_TOAST_ITEM = [...]\``,
      why: 'PGC 试看提示条选择器丢失了。要么被改名，要么隐藏逻辑被移除 —— 都要人工确认（用户会重新报"角标挡画面"）。',
    });
  } else if (!sameSet(actualToast, AUTHORIZED_PGC_TOAST)) {
    const extra = actualToast.filter((x) => !AUTHORIZED_PGC_TOAST.includes(x));
    const missing = AUTHORIZED_PGC_TOAST.filter((x) => !actualToast.includes(x));
    problems.push({
      what: `${MAIN_WORLD} 的 PGC_TOAST_ITEM 与 ADR 0022 授权集不一致`,
      why: [
        extra.length > 0
          ? `多出未授权选择器：${extra.join(', ')} —— 隐藏范围扩大，必须先在 ADR 0022 里授权`
          : '',
        missing.length > 0
          ? `缺少已授权选择器：${missing.join(', ')} —— 提示条会重新出现，请同步改 ADR`
          : '',
        `实际：${JSON.stringify(actualToast)}`,
        `授权：${JSON.stringify(AUTHORIZED_PGC_TOAST)}`,
      ]
        .filter(Boolean)
        .join('\n    '),
    });
  }

  let adr0022Text = '';
  try {
    adr0022Text = await readFile(join(ROOT, ADR_0022), 'utf8');
  } catch {
    problems.push({
      what: `找不到 ${ADR_0022}`,
      why: '授权来源缺失。隐藏播放器提示条这件事必须有 ADR 兜着，不能只剩代码。',
    });
  }
  if (adr0022Text) {
    const missingInAdr = AUTHORIZED_PGC_TOAST.filter((x) => !adr0022Text.includes(x));
    if (missingInAdr.length > 0) {
      problems.push({
        what: `ADR 0022 里没有提到这些被授权的选择器：${missingInAdr.join(', ')}`,
        why: 'ADR 被改动过。若是有意收紧授权，请同步本脚本的 AUTHORIZED_PGC_TOAST；否则请恢复 ADR。',
      });
    }
  }

  // ── 第五类（补登）：PGC 切集换流（ADR 0023，2026-11-17） ──
  //
  // `pgcSwapPlayviewBody()` 换的是**整条流**（试看 durl → 播放账号的完整 dash），
  // 比前四类都重：它会把 `data.video_info` 里一大片字段换成新流的值。
  //
  // 以前这里没有任何判据，所以"往 `data` 上多写一个键"机器一句话都不说 ——
  // 而那句话本该是"你在扩大越权范围"。
  //
  // 判据三条：**越权即红**（写了授权集外的键）、**同步缺项即红**（ADR 0023 点名的
  // 字段少一个就会灰屏/锁 720P）、**delete 也要在集合内**（删别的键同样改变播放器行为）。
  //
  // ⚠️ `is_preview` 与 `data.play_video_type` / `data.play_check.play_detail` 由
  // **ADR 0021** 授权（`PGC_PREVIEW_FLAGS`）。这里从那份清单**派生**，不手抄第二份 ——
  // 抄一份的后果是改 ADR 0021 时两处会漂移，而漂移只在真机上表现为"试看照样 6 分钟就停"。
  const playviewFlagWrites = AUTHORIZED_PGC_FLAGS.filter((f) => f.startsWith('video_info.')).map(
    (f) => f.slice('video_info.'.length),
  );
  const playviewDataWrites = AUTHORIZED_PGC_FLAGS.filter((f) => !f.startsWith('video_info.'));

  const playviewBody = extractFunctionBody(src, 'pgcSwapPlayviewBody');

  if (playviewBody === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`function pgcSwapPlayviewBody(...)\` 或它的大括号不平衡`,
      why:
        'PGC 切集换流的写集就查不出来了。要么函数被改名/合并，要么源码被改坏 —— ' +
        '两种情况都要人工确认（用户会重新报"切集后画质锁 720P / 灰屏"）。',
    });
  } else {
    const viWrites = extractWrittenKeys(playviewBody, 'vi');
    const viDeletes = extractDeletedKeys(playviewBody, 'vi');
    const dataWrites = extractWrittenKeys(playviewBody, 'data');

    const allowedViWrites = [...AUTHORIZED_PLAYVIEW_WRITES, ...playviewFlagWrites];
    const extraViWrites = viWrites.filter((k) => !allowedViWrites.includes(k));
    const missingViWrites = REQUIRED_PLAYVIEW_WRITES.filter((k) => !viWrites.includes(k));
    const extraViDeletes = viDeletes.filter((k) => !AUTHORIZED_PLAYVIEW_DELETES.includes(k));
    const missingViDeletes = REQUIRED_PLAYVIEW_DELETES.filter((k) => !viDeletes.includes(k));
    const extraDataWrites = dataWrites.filter((k) => !playviewDataWrites.includes(k));
    const missingDataWrites = playviewDataWrites.filter((k) => !dataWrites.includes(k));

    if (extraViWrites.length > 0 || extraDataWrites.length > 0 || extraViDeletes.length > 0) {
      problems.push({
        what: `${MAIN_WORLD} 的 pgcSwapPlayviewBody() 写了 ADR 0023 未授权的字段`,
        why: [
          extraViWrites.length > 0
            ? `多写 data.video_info 上的：${extraViWrites.join(', ')} —— 这是**扩大越权范围**，必须先在 ADR 0023 里授权`
            : '',
          extraDataWrites.length > 0
            ? `多写 data 上的：${extraDataWrites.join(', ')} —— data 上除了 video_info 与 ADR 0021 的三个试看标记，别的键一个都不许碰`
            : '',
          extraViDeletes.length > 0
            ? `多删 data.video_info 上的：${extraViDeletes.join(', ')} —— 删除同样改变播放器行为，也要授权`
            : '',
          `实际写：${JSON.stringify(viWrites)}｜delete：${JSON.stringify(viDeletes)}`,
          `授权写：${JSON.stringify(allowedViWrites)}｜data 上：${JSON.stringify(playviewDataWrites)}`,
          `授权 delete：${JSON.stringify(AUTHORIZED_PLAYVIEW_DELETES)}`,
        ]
          .filter(Boolean)
          .join('\n    '),
      });
    }

    if (missingViWrites.length > 0 || missingViDeletes.length > 0 || missingDataWrites.length > 0) {
      problems.push({
        what: `${MAIN_WORLD} 的 pgcSwapPlayviewBody() 少同步了 ADR 0023 / ADR 0021 点名的字段`,
        why: [
          missingViWrites.length > 0
            ? `少写 data.video_info 上的：${missingViWrites.join(', ')} —— 不同步它们会灰屏或把画质锁死（ADR 0023 实测：type 在两种响应里连类型都不同）`
            : '',
          missingViDeletes.length > 0
            ? `少删：${missingViDeletes.join(', ')} —— 留着 durl/durls 时播放器优先走 durl，回到 720P`
            : '',
          missingDataWrites.length > 0
            ? `少写 data 上的试看标记：${missingDataWrites.join(', ')} —— 播放器会在试看结束点主动停（ADR 0021）`
            : '',
          '→ 若是有意收紧，请同步改 ADR 0023 / 0021，不要只改代码',
        ]
          .filter(Boolean)
          .join('\n    '),
      });
    }
  }

  // ── 第六类（补登）：PGC 整页注入 `__playinfo__`（ADR 0020，2026-11-17） ──
  //
  // `pgcPatchPlayinfo()` 把 `result.video_info` 换成缓存里的完整流。
  // 判据只有一条，但它是最要紧的一条：**只许动 `video_info` 这一个同级键**。
  // 碰 `arc` = 改集号；碰 `user_status` / `play_check` = 伪造权益（决策 5 的立法目的）。
  //
  // ⚠️ 试看标记不在这里写（由 `pgcPatchPreviewFlags(r)` 负责，那三个字段由
  // `PGC_PREVIEW_FLAGS` 单独守着），所以这里的写集应当**恰好**是 `['video_info']`。
  const playinfoBody = extractFunctionBody(src, 'pgcPatchPlayinfo');

  if (playinfoBody === null) {
    problems.push({
      what: `在 ${MAIN_WORLD} 里找不到 \`function pgcPatchPlayinfo(...)\` 或它的大括号不平衡`,
      why:
        'PGC 整页注入的写集就查不出来了。要么函数被改名/合并，要么源码被改坏 —— ' +
        '两种情况都要人工确认（用户会重新报"番剧整页加载只有试看"）。',
    });
  } else {
    const resultWrites = extractWrittenKeys(playinfoBody, 'r');
    const extraResultWrites = resultWrites.filter(
      (k) => !AUTHORIZED_PLAYINFO_RESULT_WRITES.includes(k),
    );
    const missingResultWrites = AUTHORIZED_PLAYINFO_RESULT_WRITES.filter(
      (k) => !resultWrites.includes(k),
    );

    if (extraResultWrites.length > 0 || missingResultWrites.length > 0) {
      problems.push({
        what: `${MAIN_WORLD} 的 pgcPatchPlayinfo() 写的 result 键与 ADR 0020 授权不一致`,
        why: [
          extraResultWrites.length > 0
            ? `多写同级键：${extraResultWrites.join(', ')} —— 碰 arc 等于改集号，碰 user_status / play_check 等于伪造权益（决策 5）`
            : '',
          missingResultWrites.length > 0
            ? `缺少：${missingResultWrites.join(', ')} —— 注入没发生，整页加载会退回试看`
            : '',
          `实际：${JSON.stringify(resultWrites)}｜授权：${JSON.stringify(AUTHORIZED_PLAYINFO_RESULT_WRITES)}`,
          '→ 试看标记由 pgcPatchPreviewFlags(r) 单独写，不在这个函数的写集里',
        ]
          .filter(Boolean)
          .join('\n    '),
      });
    }
  }

  // ADR 0023 本身必须还在，且仍在讨论那些字段（防止 ADR 被误删/大改）
  let adr0023Text = '';
  try {
    adr0023Text = await readFile(join(ROOT, ADR_0023), 'utf8');
  } catch {
    problems.push({
      what: `找不到 ${ADR_0023}`,
      why: '授权来源缺失。PGC 切集换流这件事必须有 ADR 兜着，不能只剩代码。',
    });
  }
  if (adr0023Text) {
    const missingInAdr = REQUIRED_PLAYVIEW_WRITES.filter((f) => !adr0023Text.includes(f));
    if (missingInAdr.length > 0) {
      problems.push({
        what: `ADR 0023 里没有提到这些必须同步的字段：${missingInAdr.join(', ')}`,
        why: 'ADR 被改动过。若是有意收紧授权，请同步本脚本的 AUTHORIZED_PLAYVIEW_WRITES；否则请恢复 ADR。',
      });
    }
  }

  // ADR 本身必须还在，且仍在讨论这几个路径（防止 ADR 被误删/大改）
  let adrText = '';
  try {
    adrText = await readFile(join(ROOT, ADR_0013), 'utf8');
  } catch {
    problems.push({
      what: `找不到 ${ADR_0013}`,
      why: '授权来源缺失。改写响应体这件事必须有 ADR 兜着，不能只剩代码。',
    });
  }
  if (adrText) {
    const missingInAdr = AUTHORIZED_PATHS.filter((p) => !adrText.includes(p));
    if (missingInAdr.length > 0) {
      problems.push({
        what: `ADR 0013 里没有提到这些被授权的路径：${missingInAdr.join(', ')}`,
        why: 'ADR 被改动过。若是有意收紧授权，请同步本脚本的 AUTHORIZED_PATHS；否则请恢复 ADR。',
      });
    }
  }

  console.log(`[patch] 检查 ${MAIN_WORLD} 的响应体改写范围`);
  console.log(`[patch] 授权来源：${ADR_0013}（会员字段）`);
  console.log(`[patch] 授权来源：${ADR_0017}（观看进度）`);
  console.log(`[patch] 授权来源：${ADR_0021}（PGC 试看标记）`);
  console.log(`[patch] 授权来源：${ADR_0022}（PGC 试看提示条）`);
  console.log(`[patch] 授权来源：${ADR_0023}（PGC 切集换流）`);
  console.log(`[patch] 授权来源：ADR 0020 / AGENTS.md §5.5 第 5 行（PGC 整页注入）`);

  if (problems.length === 0) {
    console.log(
      `[patch] ✅ 会员字段 ${AUTHORIZED_PATHS.length} 条路径 · 观看进度 ${AUTHORIZED_PROGRESS_PATHS.length} 条路径 · PGC 试看标记 ${AUTHORIZED_PGC_FLAGS.length} 个字段 · PGC 提示条 ${AUTHORIZED_PGC_TOAST.length} 个选择器 · ${AUTHORIZED_HOSTS.length} 个主机（与 ${ROUTES_TS} 一致）`,
    );
    /**
     * 这两行是 2026-11-17 补的：以前只有一行长输出，读的人看不出
     * "换流与注入到底有没有被守" —— 而那正是这一轮补上的洞。
     */
    console.log(
      `[patch] ✅ PGC 切集换流：pgcSwapPlayviewBody 写集 ⊆ ADR 0023 授权（同步字段 ${AUTHORIZED_PLAYVIEW_WRITES.length} 个 + 试看标记 ${playviewFlagWrites.length} 个，delete ${REQUIRED_PLAYVIEW_DELETES.length} 个）`,
    );
    console.log(
      `[patch] ✅ PGC 整页注入：pgcPatchPlayinfo 只写 result.${AUTHORIZED_PLAYINFO_RESULT_WRITES.join(' / result.')}`,
    );
    console.log(
      '[patch] ⚠️  候选过滤（ADR 0038）**尚未纳入校验** —— 实现常量未落地；落地时必须补，见文件末尾',
    );
    return;
  }

  console.error(`\n[patch] ❌ 发现 ${problems.length} 处问题\n`);
  for (const p of problems) {
    console.error(`  ${p.what}`);
    console.error(`    ${p.why}\n`);
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[patch] 检查脚本自身出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});

/**
 * 候选过滤（ADR 0038）落地时要补什么 —— 这一节是**留给实现者的单子**，
 * 现在一条判据都还没有，因为代码里一个常量都还没有。
 *
 * ## 为什么它必须单独补，不能并进上面任何一条
 *
 * 前六类**一个字节都不许碰 URL**；第五类恰恰**只**动 URL（`dash[].base_url` /
 * `backup_url` 的删除与重排）。两者的写集在结构上相反，并进任何一条都会让
 * "这条是为了什么被授权"查不出来。
 *
 * ## 到时候该断言什么（建议，按 ADR 0038 的五条硬边界逐条落地）
 *
 * | # | 断言 | 反例 |
 * | --- | --- | --- |
 * | 1 | 候选过滤**只在** `dash.video[]` / `dash.audio[]` 的 `base_url`、`baseUrl`、`backup_url`、`backupUrl` 上写 | 有人顺手把 `write` 扩到 `dash.duration` |
 * | 2 | 那个函数里**不许出现字符串拼接 URL** 的痕迹（`+ '://'`、`'http'`、`location` 之类） | 凭空造一条签名不对的 URL |
 * | 3 | 写集里**不许出现** `quality` / `support_formats` / `accept_quality` / `height` / `codecid` / `bandwidth` / `accept_description` | 顺手改了画质档位（ADR 0038 边界 3） |
 * | 4 | 过滤函数**不许**调用 `pgcPatchPreviewFlags` / 碰 `is_preview` / `play_check` / `user_status` | 借过滤之名伪造权益（边界 4） |
 * | 5 | 常量的**字符串字面量清单**（授权字段名）必须与本脚本里的 `AUTHORIZED_CANDIDATE_WRITES` 集合相等 | 悄悄把 `dash.duration` 加进白名单 |
 * | 6 | 三处调用点**都必须**走到同一个函数：`playurl`（XHR + fetch 兜底）、`__playinfo__` 注入点、`playview` 换流点 | 只在 playurl 上过滤 → 番剧切集那条路漏过去（ADR 0038 背景 §二 的核心事实） |
 *
 * 第 6 条是这一整类里最容易漏的：ADR 0038 明确写了"候选过滤必须覆盖三处"，
 * 而三处调用点里有两处在上面已经守着的函数里 —— 所以落地时**还要回头改**
 * `pgcSwapPlayviewBody` / `pgcPatchPlayinfo` 的写集断言（过滤函数会多写
 * `dash.video[].base_url`，那是**新的**授权键，不是越权）。
 */
