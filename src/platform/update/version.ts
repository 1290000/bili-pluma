/**
 * 当前安装的扩展版本 —— **唯一实现**。
 *
 * ## 为什么单独一个文件
 *
 * 原先 SW（`background/handlers/update.handler.ts`）与 content script
 * （`entrypoints/content-panel.content.ts`）各写了一份**逐字相同**的 try/catch，
 * 靠两处注释互相指认。这种"两处都写了同一件事"迟早漂移（AGENTS.md §6.1），
 * 而且版本号的取法一旦改（比如改用 `runtime.getManifest()` 之外的来源），
 * 只改一处就会让两边的 `phase` 判据对不上 —— 用户看到"有新版"或"已是最新"取决于
 * 他是在面板里看还是在 SW 里算。
 *
 * ## 为什么在 `platform` 而不是 `core`
 *
 * 它碰 `chrome.runtime`。`core` 不许出现 `chrome`（两道闸：ESLint +
 * `scripts/check-boundaries.ts`）。所以"取版本号"这件事只能在 platform，
 * core 里的 `toStatusView(state, version)` 收**已经取好的**字符串。
 */

/**
 * `chrome.runtime.getManifest().version`，读不到时返回 `'0.0.0'`。
 *
 * ⚠️ **不许让它抛**：一个附属信息读不到，不该把更新功能整个弄崩。
 * 退成 `'0.0.0'` 的后果只是"任何版本都比它新"，界面上会显示有新版本 ——
 * 这比"面板白屏 / 更新窗口炸掉"好得多。
 */
export function currentVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}
