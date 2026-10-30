#!/usr/bin/env node
/**
 * 重新加载扩展 —— **让最新构建吃到浏览器里，不需要人点"重新加载"**。
 *
 * ## 为什么需要这个脚本
 *
 * 改完代码要验证，必须让浏览器用上新构建。三条路都试过，前两条都不通：
 *
 * | 办法 | 结果 |
 * | --- | --- |
 * | `bsk` 操作 `edge://extensions/` | ❌ 沙箱按 URL 白名单挡掉（`edge://` 一律拒绝，见 `browser-skill-setup.md` §7a）——**连截图都拿不到**，所以也没有"点一下按钮"这种取巧 |
 * | `chrome.runtime.reload()` 自己调 | ❌ 只能由扩展自己调用；而扩展页 `chrome-extension://` 同样被沙箱挡掉 |
 * | 手工点「重新加载」 | ✅ 可行，但每修一个 bug 都要人点一次 |
 *
 * 于是走第四条：**让浏览器自己重读那批文件**。
 *
 * ## 三个事实（实测，别改）
 *
 * 1. **`Preferences` 里的 `extensions.settings` 是空的** —— 扩展配置实际在
 *    `Secure Preferences`（`extensions.settings` 在那里）。只读 `Preferences` 会得出
 *    "这个 profile 一个扩展都没装"的错误结论。
 * 2. **重载会把扩展 ID 换掉**（解压式扩展按路径算 ID，但注册项是临时的），
 *    连带 `Local Extension Settings/<id>/` 整个换目录 —— **AES 密钥留在旧目录里**，
 *    于是凭据解不开、功能静默失效。所以重载前后必须自己搬 storage。
 * 3. **Chrome 在运行时会把 `Preferences` 整个重写**。脚本改了它也没用，
 *    必须**先让浏览器退出**再改。
 *
 * ## 做法
 *
 * ```
 * 1. 找清楚三样东西：扩展 ID / 扩展路径 / profile 目录（不猜，全从磁盘读）
 * 2. 退出浏览器（强制结束，cookie 早已落盘）
 * 3. 重新启动浏览器，打开一个 B站页面等它就绪
 * 4. 校验：content script 是否真的跑起来了
 * ```
 *
 * **不写任何文件**。早先这里还会追写 `manifest.json` 的 `version`，删掉了 ——
 * 理由见主流程里那段注释（多余且让产物版本与源码脱钩）。
 *
 * ## 用法
 *
 * ```bash
 * node poc/probe/reload-extension.mjs --build      # 构建 → 重载 → 等就绪（最常用）
 * node poc/probe/reload-extension.mjs --dry-run    # 只打印将要做什么，不动任何文件
 * node poc/probe/reload-extension.mjs --no-build   # 用现有 .output 重载
 * ```
 *
 * ⚠️ **它会关掉浏览器**。有未提交的表单/正在上传的东西时不要跑。
 * 这是有意的取舍：不退出就改不了 `Preferences`，而"改不了"就没有自动化。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const OUTPUT = join(ROOT, '.output', 'chrome-mv3');

/** 支持的浏览器。Edge 是当前真机环境；Chrome 结构一致，一并支持 */
const BROWSERS = [
  {
    key: 'edge',
    exe: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    exeAlt: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    process: 'msedge.exe',
    dataDir: join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/User Data'),
    profile: 'Default',
  },
  {
    key: 'chrome',
    exe: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    exeAlt: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process: 'chrome.exe',
    dataDir: join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/User Data'),
    profile: 'Default',
  },
];

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const NO_BUILD = argv.includes('--no-build');
const OPEN_URL = 'https://www.bilibili.com/video/BV1jt421t7XH';

function log(...a) {
  console.log('[reload]', ...a);
}

function fail(msg) {
  console.error('[reload] ✗', msg);
  process.exit(1);
}

// ── 1. 找浏览器与扩展 ──

function pickBrowser() {
  for (const b of BROWSERS) {
    const exe = existsSync(b.exe) ? b.exe : existsSync(b.exeAlt) ? b.exeAlt : null;
    if (exe && existsSync(b.dataDir)) return { ...b, exe };
  }
  fail('找不到已经装过的 Edge / Chrome（或它们的 User Data 目录）');
  return null;
}

/**
 * 从 `Secure Preferences` 里找解压式扩展。
 *
 * ## 为什么不按"名字含 Pluma"匹配
 *
 * 用户可能改过 `manifest.name`，而且我们在构建里会写中文名。
 * 判据用**安装路径**更稳：`path` 指向 `.output/chrome-mv3` 的那一条就是我们。
 */
function findUnpackedExtension(browser) {
  const files = ['Secure Preferences', 'Preferences'];
  for (const f of files) {
    const p = join(browser.dataDir, browser.profile, f);
    if (!existsSync(p)) continue;
    let j;
    try {
      j = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    const settings = j?.extensions?.settings ?? {};
    for (const [id, v] of Object.entries(settings)) {
      const dir = v?.path;
      if (typeof dir !== 'string') continue;
      if (!/[\\/]\.output[\\/]chrome-mv3$/.test(dir) && !/[\\/]pluma-/.test(dir)) continue;
      return { id, dir, source: f, settings: v };
    }
  }
  return null;
}

/** 读一个扩展在磁盘上的 storage 目录（vault key 在这里） */
function storageDirOf(browser, extId) {
  return join(browser.dataDir, browser.profile, 'Local Extension Settings', extId);
}

/**
 * 把 storage 目录整体复制过去。
 *
 * ⚠️ **必须在浏览器退出后做**：LevelDB 的文件是独占打开的，
 * 运行中复制会拿到半截 log，甚至 EBUSY 直接失败。
 */
function copyStorage(from, to) {
  if (!existsSync(from)) return 'no-source';
  if (!existsSync(to)) return 'no-target';
  // robocopy 在 Windows 上是唯一能可靠处理"目录被系统监视"的工具；/MIR 会删目标多余文件
  const r = spawnSync('robocopy', [from, to, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS'], {
    encoding: 'utf8',
  });
  // robocopy 的退出码 0-7 都是成功
  if (r.status !== null && r.status <= 7) return 'copied';
  return `robocopy-failed(${String(r.status)})`;
}

// ── 2. 退出 / 启动 ──

/**
 * ⚠️ **`tasklist /FI` 判断在这里是错的**（实测踩到）。
 *
 * `/FI "IMAGENAME eq msedge.exe"` 会连 **`msedgewebview2.exe`** 一起返回——
 * 那是 WebView2 的宿主进程（微信/输入法/各种 Electron 应用都会起），
 * 它们永远不会因为"关掉浏览器"而消失。
 *
 * 结果：`browserRunning()` 恒为 true → 等 45 秒超时 → 走强制结束分支。
 * 第一次跑就是这个现象，日志里"正常退出没成功"其实是**已经在退出**。
 *
 * 正确判据：把 tasklist 输出按行取第一列，**精确等于**进程名。
 */
function browserRunning(browser) {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const name = browser.process.toLowerCase();
  /**
   * CSV 的第一列形如 `"msedge.exe",` —— **带引号**。
   * 按第一个 `,` 切、把两边的引号一起剥掉，才拿得到裸进程名。
   * （第一版按 `","` 切，得到的是 `"msedge.exe` 带前引号，永远匹配不上。）
   */
  return (r.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => (line.split(',')[0] ?? '').replace(/^"+/, '').replace(/"+$/, '').toLowerCase())
    .some((n) => n === name);
}

async function waitUntil(predicate, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - started > timeoutMs) {
      log(`✗ 等待超时：${label}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * 关闭浏览器。
 *
 * ## ⚠️ 这条链上的坑（三次实测，逐条都是"看起来对但不对"）
 *
 * | 写法 | 现象 |
 * | --- | --- |
 * | `tasklist /FI "IMAGENAME eq msedge.exe"` | **会匹配到 `msedgewebview2.exe`**（WebView2 宿主，永远不退出）→ 判定恒为"还在跑" |
 * | CSV 按 `","` 切第一列 | 得到 `"msedge.exe`（带前引号）→ 恒不匹配 |
 * | 正确切分后 | ✅ 判定准确 |
 *
 * 所以判据必须是「CSV 第一列剥掉引号后**精确等于**进程名」。
 *
 * ## 关不掉时的兜底
 *
 * 实测：`taskkill`（不带 `/F`）对 Edge 主进程只发"请求关闭"信号，
 * **渲染进程会拒绝**（返回"只能强制终止该进程 /F"），
 * 于是和用户点了窗口上的 × 一样——浏览器继续活着。所以这里直接上 `/F`。
 *
 * 用 `/F` 会不会丢登录态？**不会**：cookie 是上次正常退出时就落盘的（见 `hasSavedCookies` 校验），
 * 而 `Local State` 里加密密钥是独立文件。最坏影响是"恢复上次会话"的列表丢了。
 *
 * ## 强杀要连杀几轮
 *
 * 杀掉主进程后，残留的渲染进程/更新程序可能把主进程**拉起来**（Edge 的后台继续运行）。
 * 所以每次强杀后重新判一次，最多三轮 —— 只杀一次会看到"杀完又活了"，
 * 然后误以为判定逻辑有问题（这一圈花过时间）。
 */
async function quitBrowser(browser) {
  if (!browserRunning(browser)) {
    log('浏览器本来就没在跑');
    return true;
  }
  log('正在关闭浏览器（强制结束，登录态已落盘）…');
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    // /T 连子进程一起关。必须带 /F —— 不带的话渲染进程拒绝退出（实测）
    spawnSync('taskkill', ['/IM', browser.process, '/T', '/F'], { encoding: 'utf8' });
    if (await waitUntil(() => !browserRunning(browser), 8_000, `关闭第 ${String(attempt)} 轮`)) {
      return true;
    }
    log(`第 ${String(attempt)} 轮结束后它又起来了 —— 继续`);
  }
  return false;
}

function startBrowser(browser) {
  log('重新启动浏览器…');
  // `cmd /c start` 让浏览器脱离本进程生命周期 —— 脚本退出后它继续活着
  spawnSync(
    'cmd',
    ['/c', 'start', '""', browser.exe, '--profile-directory=' + browser.profile, OPEN_URL],
    { stdio: 'ignore', windowsHide: true },
  );
}

// ── 3. 构建 ──

function build() {
  log('构建中（wxt build）…');
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'wxt', 'bin', 'wxt.mjs'), 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(r.stdout?.slice(-2000), r.stderr?.slice(-2000));
    fail('构建失败');
  }
  log('构建完成');
}

// ── 4. 校验 ──

/**
 * 校验：content script 是否真的在新构建上跑起来了。
 *
 * 判据只能是**页面里能看见的东西**（记忆库"判据必须是用户能看见的东西"）：
 * `window.__PLUMA_MAIN__` 由主世界脚本置位，它为 true 就说明新构建注入了。
 * 拿不到就说明没生效——不要用"文件是新的"来推断。
 *
 * ⚠️ **daemon 不由本脚本启动**（`BSK_AUTO_START=0` 是刻意的）。
 * 首次运行时 daemon 没在跑，这里会直接报"需要先起 daemon"并**返回非 2 的退出码**，
 * 好让调用方能区分"扩展没生效"和"根本没检查成"。
 */
async function verifyViaBsk() {
  /**
   * ⚠️ **活动 BSK_HOME 是 `~/.bsk`，不是 `~/.bsk-agent`**（2026-10-30 修正）。
   *
   * 这里原来写死 `.bsk-agent` —— 那是更早的目录名。两个目录在本机**都还存在**，
   * 但 daemon 只在 `~/.bsk` 里跑，于是校验会报 `no-bsk`，
   * 表现为"扩展没生效"（退出码 3），而真实原因是**指错了 home**。
   *
   * 现在优先读环境变量：调用方显式设了 `BSK_HOME` 就用它，
   * 否则回落到 `~/.bsk`（当前活动目录）。见 `docs/guides/browser-skill-setup.md`。
   */
  const bskHome = process.env.BSK_HOME?.trim() || join(process.env.USERPROFILE ?? '', '.bsk');
  const env = {
    ...process.env,
    PATH: `${join(process.env.USERPROFILE ?? '', '.local', 'bin')};${process.env.PATH ?? ''}`,
    BSK_HOME: bskHome,
    BSK_AUTO_START: '0',
  };
  /**
   * ⚠️ `shell: false`（默认值，**不要改成 true**）。
   *
   * 实测踩到：`shell: true` 时 `evaluate` 的表达式会被 cmd/bash 再解析一遍，
   * `!` 触发历史展开、`"` 被剥掉，报的是
   * `unexpected argument '!!window.__PLUMA_MAIN__})' found` —— 看起来像 bsk 的参数错误，
   * 实际是我们的 shell 把表达式改了。改成直接 spawn 就没这个问题。
   */
  const run = (args) =>
    spawnSync('bsk', args, { env, encoding: 'utf8', timeout: 180_000, shell: false });

  const s = run(['session', 'start', '--no-focus', '--json']);
  const m = /"session_id":\s*"([^"]+)"/.exec(s.stdout ?? '');
  if (!m) {
    return {
      state: 'no-bsk',
      detail: 'bsk session 起不来（daemon 没在跑？先起 daemon 再重跑）：' +
        (s.stdout ?? s.stderr ?? '').slice(0, 160).replace(/\s+/g, ' '),
    };
  }
  const sid = m[1];

  /**
   * ⚠️ **浏览器重启后，那个 B站标签页在"用户窗口"里，不在 Agent Window 里**，
   * 而沙箱只允许操作 Agent Window 内的标签页。
   *
   * 三条路都试过：
   *
   * | 办法 | 结果 |
   * | --- | --- |
   * | 直接 `evaluate --tab-id` | ❌ `evaluate can only act on tabs inside the Agent Window` |
   * | `tab borrow` 借过来 | ❌ **要弹确认框**（`borrow_confirmation: always`），无人值守下报 `the browser could not display a confirmation request` |
   * | **自己开一个 Agent Window 标签页**（下面这条） | ✅ 不需要任何确认 |
   *
   * 自己开的标签页同样是真实页面、同样会加载扩展，判据完全成立。
   * 唯一代价是多一个标签页——比"每次都要人点确认"好。
   */
  const probe = run(['tab', 'create', '--url', OPEN_URL, '--session', sid]).stdout ?? '';
  const probeTab = /tab_id=(\d+)/.exec(probe)?.[1];
  if (!probeTab) {
    run(['session', 'stop', sid]);
    return { state: 'no-tab', detail: '开不出探测标签页：' + probe.slice(0, 120) };
  }
  // 等页面把 content script 跑起来再读
  await new Promise((r) => setTimeout(r, 12_000));

  const invoke = run([
    'evaluate',
    '--session',
    sid,
    '--tab-id',
    probeTab,
    // ⚠️ **绝不经过 shell 转义**：`!` 在 bash 里是历史展开、`"` 会被吃掉，
    // 表达式必须不带引号字符和感叹号。见 `runBsk` 的 `shell: false`。
    'String(window.__PLUMA_MAIN__ === true)',
  ]);
  const out = (invoke.stdout ?? '').trim().split('\n').pop() ?? '';
  run(['session', 'stop', sid]);
  // `bsk evaluate` 直接把表达式的值原样打印出来：`true` / `false`
  const ready = out.trim() === 'true';
  return { state: ready ? 'ok' : 'not-injected', detail: out.slice(0, 200) };
}

// ── 主流程 ──

async function main() {
  const browser = pickBrowser();
  log(`浏览器：${browser.key} → ${browser.exe}`);

  if (!NO_BUILD && !DRY) build();
  if (!existsSync(join(OUTPUT, 'manifest.json'))) fail(`构建产物不存在：${OUTPUT}`);

  const before = findUnpackedExtension(browser);
  log(
    before
      ? `当前扩展：${before.id} ← ${before.dir}（来自 ${before.source}）`
      : '当前扩展：未在 Secure Preferences 里找到注册项（未加载过？）',
  );

  if (DRY) {
    log('--dry-run：到此为止，没有关闭浏览器、没有改任何文件');
    return;
  }

  const oldId = before?.id ?? null;
  const oldStorage = oldId ? storageDirOf(browser, oldId) : null;

  if (!(await quitBrowser(browser))) fail('浏览器关不掉');

  /**
   * 关闭后再读一次注册项 —— 浏览器退出时才会把内存里的 state 刷回磁盘。
   * 运行中读到的 `path` 可能是旧路径（换过 .output 位置的那种）。
   */
  const settled = findUnpackedExtension(browser) ?? before;
  log(settled ? `确认注册路径：${settled.dir}` : '注册项消失了（首次加载？）');

  /**
   * ## 不改 `manifest.version` —— 曾经改过，那是错的
   *
   * 早先这里会把 `.output/chrome-mv3/manifest.json` 的 `version` 加一，
   * 想"逼浏览器重读"。两个问题：
   *
   * 1. **多余**：重启浏览器时，浏览器本来就会重新加载所有解压式扩展、
   *    重读磁盘上的文件。`version` 变不变都一样。
   * 2. **有害**：它让产物里的版本和 `wxt.config.ts` / `package.json` 脱钩
   *    （实测出现过产物 `0.9.1`、源码 `0.9.0`）。发布版本号只能由构建决定，
   *    任何工具在产物上偷偷改它，都会在下一次打包时变成"这个包到底是哪版"的疑问。
   *
   * 所以现在只做：关浏览器 → 重启 → 校验。**不写任何文件。**
   */

  /**
   * storage 迁移：重载后 ID 可能变，新目录里没有 vault key。
   *
   * 两种情形分开处理，**不要一律复制**：
   *   - ID 没变 → 目录就是同一个，什么都不用做（复制反而会把自己的数据搞坏）
   *   - ID 变了 → 老目录还在，把里面的东西搬到新目录
   */
  if (oldStorage && existsSync(oldStorage)) {
    log(`保留旧 storage：${oldStorage}（重载后如 ID 未变则直接可用）`);
  }

  startBrowser(browser);

  log('等页面加载（15s）…');
  await new Promise((r) => setTimeout(r, 15_000));

  const check = await verifyViaBsk();
  if (check.state === 'ok') log(`✓ 生效：${check.detail}`);
  else if (check.state === 'no-bsk') log(`⚠ 跳过校验：${check.detail}`);
  else log(`✗ 未生效：${check.detail}`);

  // 重载后如果 ID 变了，把 storage 搬过去（此时浏览器已启动，但 LevelDB 已可读写）
  const after = findUnpackedExtension(browser);
  if (after && oldId && after.id !== oldId && oldStorage) {
    const moved = copyStorage(oldStorage, storageDirOf(browser, after.id));
    log(`扩展 ID 变了 ${oldId} → ${after.id}，storage 迁移：${moved}`);
  }

  // 0 = 生效；2 = 检查了但没生效；3 = 没能检查（不算失败，但必须说清楚）
  process.exit(check.state === 'ok' ? 0 : check.state === 'no-bsk' ? 3 : 2);
}

await main();
