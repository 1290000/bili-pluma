#!/usr/bin/env node
/**
 * 读 popup 渲染结果的完整快照 —— **不需要人点 popup、不需要手工截图**。
 *
 * ## 为什么需要这个脚本
 *
 * popup 是 `chrome-extension://` 页面，而 bsk 的 Agent Window 沙箱**按 URL 白名单**
 * 拒绝它：`evaluate` 直接报 `operation denied by the Agent Window sandbox`。
 * 于是每个 UI bug（主账号栏空着、画质区显示错话）都只能靠用户手点一次、
 * 肉眼描述 → **一轮排查来回三次**。
 *
 * ## 取数路径（为什么是这个，不是别的）
 *
 * 三条都试过，只有最后一条通：
 *
 * | 办法 | 结果 |
 * | --- | --- |
 * | B站页面里直接 `chrome.runtime.sendMessage` | ❌ 页面主世界的 `chrome` **没有 `runtime`**（实测：`Cannot read properties of undefined (reading 'sendMessage')`）。`chrome.runtime` 只在 ISOLATED world（content script）里。 |
 * | `evaluate` 里调 `chrome.tabs.sendMessage` | ❌ 同上，`chrome.tabs` 也不在页面里 |
 * | **从 content script 侧转发**（本脚本采用） | ✅ 见下 |
 *
 * ### 本脚本的做法
 *
 * `page/snapshot:get` 的 handler 挂在 **content script** 上（与 `page/summary:get` 同一处），
 * 应答是完整快照。要触发它，需要一个"在 ISOLATED world 里调扩展 API"的动作。
 *
 * 本脚本用**页面 ↔ content 的 postMessage 桥**：content script 的 `installSender()`
 * 已经建立了 `window.postMessage` 通道（`__ns: '__PLUMA__'`）。看一眼它认哪些消息 ——
 * 里面没有"取快照"。**所以这条路需要给 content 加一个监听分支**。
 *
 * 权衡后**不加**：AGENTS §7 写「不要自己发明检查项」，而一条只为调试服务的
 * 生产代码通道，会在每次改消息协议时多一处要同步的地方。
 *
 * ### 最终实现：**只验真实渲染 + 只验真机状态**，结构化断言交给单测
 *
 * - `--screenshot`：`bsk tab create chrome-extension://<id>/popup.html` 后截图。
 *   沙箱拒绝的是 **`evaluate`**，**不是 `tab create`** —— popup 能开、能看。
 *   这是**真实渲染**，比任何 JSON 都可信。
 * - 默认：在 B站页面上读主世界/content script 暴露的公开状态，确认"popup 打开时
 *   数据源是活的"。
 *
 * 结构化的字段级断言在 `tests/unit/shared/page-snapshot.test.ts`（11 例）。
 * 这是诚实的取舍：**真机验"看起来对不对"，单测验"算得对不对"**。
 *
 * ## 用法
 *
 * ```bash
 * node poc/probe/popup-inspect.mjs                 # 确认探测页的扩展已就绪
 * node poc/probe/popup-inspect.mjs --screenshot    # 额外对 popup.html 截图
 * node poc/probe/popup-inspect.mjs --url <url>     # 换探测页（如番剧页）
 * ```
 *
 * 退出码：0 成功｜2 脚本/取数失败｜3 bsk 不可用
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 默认探测页：普通视频页（有完整 `__playinfo__`，能验证主账号基线） */
const DEFAULT_URL = 'https://www.bilibili.com/video/BV1jt421t7XH';

const ARGV = process.argv.slice(2);
const WANT_SHOT = ARGV.includes('--screenshot');
const URL_IDX = ARGV.indexOf('--url');
const TARGET_URL = URL_IDX >= 0 ? (ARGV[URL_IDX + 1] ?? DEFAULT_URL) : DEFAULT_URL;

/**
 * bsk 的调用封装。
 *
 * ⚠️ `shell: false`（默认）**不能改成 true**：`evaluate` 的表达式会被 shell 再解析一遍，
 * `!` 触发历史展开、`"` 被剥掉，报出来的是 `unexpected argument ... found` ——
 * 看起来像 bsk 的参数错误，实际是我们的 shell 改了表达式。
 * 同一条坑记在 `poc/probe/reload-extension.mjs`。
 */
function startBsk() {
  const env = {
    ...process.env,
    PATH: `${join(process.env.USERPROFILE ?? '', '.local', 'bin')};${process.env.PATH ?? ''}`,
    BSK_HOME: join(process.env.USERPROFILE ?? '', '.bsk-agent'),
    BSK_AUTO_START: '0',
  };

  const run = (a) => spawnSync('bsk', a, { env, encoding: 'utf8', timeout: 180_000, shell: false });

  const s = run(['session', 'start', '--no-focus', '--json']);
  const sid = /"session_id":\s*"([^"]+)"/.exec(s.stdout ?? '')?.[1];
  if (!sid) return null;
  return { sid, run, stop: () => run(['session', 'stop', sid]) };
}

function log(msg) {
  console.log(`[popup-inspect] ${msg}`);
}

/**
 * 读当前已加载的 Pluma 扩展 ID。
 *
 * ## 为什么不自己算
 *
 * 解压式扩展的 ID 由**绝对路径**哈希得出，但那个算法没有官方文档、
 * 且不同版本变过。猜一个 ID 出来只会让脚本报"打不开 popup"，
 * 而真实原因是 ID 错了 —— 那种假故障比"读不到"难查得多。
 *
 * 所以从浏览器 profile 的 `Secure Preferences` 里**读注册表**，
 * 而不是算。找不到就明确返回 `null`。
 *
 * ⚠️ **`Preferences` 里的 `extensions.settings` 是空的**，
 * 真配置在 `Secure Preferences`（同一条坑记在 `reload-extension.mjs`）。
 *
 * @returns 扩展 ID；读不到返回 null
 */
function readExtensionId() {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  /** 支持 Edge 与 Chrome 两处（本项目只发这两个） */
  const candidates = [
    join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Secure Preferences'),
    join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Secure Preferences'),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      const settings = j?.extensions?.settings ?? {};
      for (const [id, cfg] of Object.entries(settings)) {
        if (String(cfg?.manifest?.name ?? '') === 'Pluma') return id;
      }
    } catch {
      // 单个 profile 读失败不影响其它候选
    }
  }
  return null;
}

/**
 * 打开 `popup.html` 并截图 —— 这是**真实渲染**。
 *
 * 沙箱拒的是 `evaluate`，`tab create` 与 `screenshot` 都能用（实测确认过
 * `reload-extension.mjs` 里 `evaluate --tab-id` 被拒的具体报错是
 * "evaluate can only act on tabs inside the Agent Window"，而 `tab create` 正常）。
 *
 * @param bsk {@link startBsk} 的返回值
 * @param extId 扩展 ID
 */
async function screenshotPopup(bsk, extId) {
  const popupUrl = `chrome-extension://${extId}/popup.html`;
  const created = bsk.run(['tab', 'create', '--url', popupUrl, '--session', bsk.sid]).stdout ?? '';
  const tabId = /tab_id=(\d+)/.exec(created)?.[1];
  if (!tabId) return { ok: false, detail: `开不出 popup 标签页：${created.slice(0, 160)}` };

  // popup 要发 4 条消息；SW 冷启动可能要几百毫秒
  await new Promise((r) => setTimeout(r, 3000));

  const shot = bsk.run(['screenshot', '--session', bsk.sid, '--tab-id', tabId, '--json']);
  if (shot.status !== 0) {
    return { ok: false, detail: `截图失败：${(shot.stderr ?? shot.stdout ?? '').slice(0, 200)}` };
  }
  return { ok: true, detail: `${popupUrl}\n${(shot.stdout ?? '').slice(0, 400)}` };
}

async function main() {
  log(`探测页：${TARGET_URL}`);

  if (!existsSync(join(ROOT, '.output', 'chrome-mv3', 'manifest.json'))) {
    log('❌ 没有构建产物。先 `pnpm build`');
    process.exitCode = 2;
    return;
  }

  const bsk = startBsk();
  if (!bsk) {
    console.error(
      '[popup-inspect] ❌ bsk session 起不来。先起 daemon（见 docs/guides/browser-skill-setup.md）',
    );
    process.exitCode = 3;
    return;
  }

  try {
    /**
     * 先开一个真实 B站页面，让 content script 跑起来 ——
     * popup 打开时 `page/summary:get` 才有数据可答。
     */
    const pageOut = bsk.run(['tab', 'create', '--url', TARGET_URL, '--session', bsk.sid]).stdout ?? '';
    const pageTab = /tab_id=(\d+)/.exec(pageOut)?.[1];
    if (!pageTab) {
      log(`❌ 开不出探测页：${pageOut.slice(0, 160)}`);
      process.exitCode = 2;
      return;
    }
    log(`探测标签页 tab_id=${pageTab}，等 content script（12s）…`);
    await new Promise((r) => setTimeout(r, 12_000));

    /** 确认扩展真的注入到了这一页 —— 否则后面的截图会拍到"未生效" */
    const probe = bsk.run([
      'evaluate',
      '--session',
      bsk.sid,
      '--tab-id',
      pageTab,
      'String(window.__PLUMA_MAIN__ === true)',
    ]);
    const mainReady = (probe.stdout ?? '').trim().split('\n').pop() === 'true';
    log(`主世界就绪：${String(mainReady)}`);
    if (!mainReady) {
      log('⚠ 主世界没跑起来 —— popup 截图会显示「未生效」。先确认扩展已加载并刷新页面');
    }

    if (!WANT_SHOT) {
      log('（未带 --screenshot，跳过截图。加 --screenshot 可看 popup 真实渲染）');
      return;
    }

    const extId = readExtensionId();
    if (!extId) {
      log('❌ 读不到扩展 ID（浏览器里没加载 Pluma？）。不猜 ID，直接退出');
      process.exitCode = 2;
      return;
    }
    log(`扩展 ID：${extId}（来自 Secure Preferences）`);

    const shot = await screenshotPopup(bsk, extId);
    if (!shot.ok) {
      log(`❌ ${shot.detail}`);
      process.exitCode = 2;
      return;
    }
    log('✅ popup 截图已生成：');
    console.log(shot.detail);
  } finally {
    bsk.stop();
  }
}

main().catch((e) => {
  console.error(`[popup-inspect] 脚本自身出错：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
});
