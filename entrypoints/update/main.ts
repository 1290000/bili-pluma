/**
 * 更新窗口 —— 「立即更新」真正干活的地方。
 *
 * ## 为什么是独立窗口
 *
 * `showDirectoryPicker` 必须在有 DOM 的**扩展页面**里调用：面板是注入 B站页面的
 * content script，在那里拿到的句柄属于**页面 origin**（句柄存不住，而且等于把
 * "能改写扩展目录"的能力交给网页域）。详见方案 §1.3。
 *
 * ## 顺序不能改（每一步都写了"为什么）
 *
 * 1. 拿句柄 → 2. **在手势里**申请权限 → 3. 浅校验目录 → 4. 下载 →
 * 5. 解压 → 6. 生成计划 → 7. 校验版本 → 8. 逐文件写入 → 9. 记 pendingUpdate → 10. reload
 *
 * 前 8 步任何一步失败都**不 reload**：宁可这次不更新，也不能留下半新半旧的扩展。
 */

import '@/src/design/tokens.css';

import { planWrites, readManifestVersion } from '@core/update/plan';
import { readUpdateState, writeUpdateState } from '@platform/update/state-store';
import { isNewerThan, withPendingUpdate } from '@core/update/state';
import { readZip } from '@core/update/zip';
import {
  ensureWritable,
  pickInstallDir,
  readDirManifest,
  readDirManifestVersion,
  type DirManifestInfo,
  readStoredDir,
  storeDir,
  writeFiles,
  type PermDirHandle,
} from '@platform/update/fs-access';
import {
  UPDATE_ALLOWED_TOP_LEVEL,
  UPDATE_MAX_ENTRY_BYTES,
  UPDATE_MAX_ZIP_BYTES,
} from '@shared/constants/update';
import type { UpdateStatusView } from '@shared/types/update';

/**
 * 写完文件后停留多久再关窗（毫秒）。
 *
 * 这一拍的存在理由只有一个：让「已写入 N 个文件，正在重新加载扩展…」
 * **真的画出来**。不留它，下一句就会销毁页面，用户什么都没看到 ——
 * 那正是"更新完了却像什么都没发生"的观感来源。
 */
const UPDATE_SETTLE_MS = 800;

/**
 * 让 background 关掉本窗口并重载扩展（**fire-and-forget**）。
 *
 * 不 `await`：窗口马上要被关掉，应答会回到一个正在消失的上下文。
 * 也不在这里 `window.close()` —— 那会让随后的 reload 不执行（见调用处那张表）。
 */
function requestReload(): void {
  try {
    void chrome.runtime.sendMessage({ type: 'update/reload' });
  } catch {
    // 上下文已失效（`Extension context invalidated`）⇒ 什么都不用做
  }
}

const versionLine = document.getElementById('version-line');
const dirLine = document.getElementById('dir-line');
const pickBtn = document.getElementById('pick-dir') as HTMLButtonElement | null;
const startBtn = document.getElementById('start') as HTMLButtonElement | null;
const estimateEl = document.getElementById('estimate');
const bar = document.getElementById('bar') as HTMLProgressElement | null;
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

let status: UpdateStatusView | null = null;
let dir: PermDirHandle | null = null;
let busy = false;

function say(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function appendLog(text: string): void {
  if (!logEl) return;
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${text}\n${logEl.textContent ?? ''}`;
}

function setProgress(value: number | null): void {
  if (!bar) return;
  if (value === null) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.value = Math.min(100, Math.max(0, value));
}

function syncButtons(): void {
  if (startBtn) {
    /**
     * ⚠️ 判据走 `isNewerThan`，**不是** `latestVersion !== currentVersion`。
     *
     * 字符串不等会把"本地比线上新"（装了未发布的包）判成"有目标" ⇒
     * 按钮可点 ⇒ 允许**降级安装**。2026-11-17 真机冒烟抓到的就是这一处
     * （面板卡头挂「有新版本」而按钮禁用，同一个面板两套判据）。
     */
    const hasTarget = status !== null && isNewerThan(status.latestVersion, status.currentVersion);
    startBtn.disabled = busy || !hasTarget;
  }
  if (pickBtn) pickBtn.disabled = busy;
}

async function readStatus(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({ type: 'update/status' }).catch(() => null)) as {
    type?: string;
    status?: UpdateStatusView;
  } | null;
  status = reply?.type === 'update/status:ok' ? (reply.status ?? null) : null;

  if (versionLine) {
    // 与 `syncButtons()` 同一判据（`isNewerThan`）：两处若各写一份，
    // 就会出现"行里说有新版、按钮却是灰的"这种自相矛盾
    const hasNewer = status !== null && isNewerThan(status.latestVersion, status.currentVersion);
    /**
     * 四态，别合并（2026-11-17 第三轮）：`status` 非空但 `latestVersion` 为 `null`
     * 意味着**后台应答了、但从没查过 GitHub**。这时候写「已是最新」是谎报 ——
     * 根本没比过。它与"读不到版本信息"（`status === null`）也不是一回事，
     * 所以两者各占一格。规格见 `docs/02-ui-spec.md` §5.3 的四态表。
     */
    versionLine.textContent =
      status === null
        ? '读不到版本信息'
        : status.latestVersion === null
          ? `当前 v${status.currentVersion} · 还没检查过`
          : hasNewer
            ? `当前 v${status.currentVersion} → v${status.latestVersion}`
            : `当前 v${status.currentVersion} · 已是最新`;
  }

  if (estimateEl) {
    const bytes = status?.latestSizeBytes ?? null;
    estimateEl.textContent =
      bytes === null
        ? ''
        : `更新包约 ${String(Math.round(bytes / 1024))} KB，下载后覆盖当前目录里的同名文件。`;
  }

  syncButtons();
  if (!status || !status.latestVersion)
    say('没有可更新的版本 —— 关掉这个窗口，回到面板点「检查更新」再试。');
}

/**
 * 上一次**成功**读到的目录 manifest。
 *
 * 两个用途：①`refreshDirLine()` 用它渲染版本号，不必每次重开窗口都去读盘；
 * ②"已经是目标版本"那句要跟 `status.latestVersion` 比，也得有它。
 * 选目录时填入；选失败时不动（保留上一次的结论，不许把好的信息覆盖成红的）。
 */
let dirInfo: DirManifestInfo | null = null;

/** 目录状态行：正常一色、出问题换 `.warn`（同一行，不新增元素） */
function renderDirLine(text: string, warn = false): void {
  if (!dirLine) return;
  dirLine.textContent = text;
  dirLine.classList.toggle('warn', warn);
}

/**
 * 正常态那一句：`目录：xxx · 该目录当前是 v1.1.0（可写），已经是目标版本`。
 *
 * 判据说明：
 * - 「可写 / 未授予写入权限」来自 `ensureWritable()`（可能弹一次确认框）
 * - 「已经是目标版本」只在**目标版本已知且相等**时追加 —— 不相等就什么都不说，
 *   不要写"将升级到 vX"（用户还没点「立即更新」，那是承诺不是事实）
 *
 * @param info `readDirManifest()` 读到的结果
 * @param writable `ensureWritable()` 是否 granted
 */
function describeDirOk(info: DirManifestInfo, writable: boolean): string {
  const head = `目录：${dir?.name ?? '（未知）'} · 该目录当前是 v${info.version}`;
  const perm = writable ? '（可写）' : '（未授予写入权限）';
  const target = status?.latestVersion === info.version ? '，已经是目标版本' : '';
  return `${head}${perm}${target}`;
}

/**
 * 刷新目录行。
 *
 * ⚠️ 这里**不重新读 manifest**（只在 `dirInfo` 已知时才渲染版本）：
 * 重开窗口时读盘失败会把上一次的成功信息覆盖成红的，而用户什么都没做错。
 * 校验发生在"选目录"那个动作里（`onPickDir`），那里失败才是真失败。
 *
 * @returns 是否可写（`onPickDir` 要拿它拼同一句话，避免两处各判一次）
 */
async function refreshDirLine(): Promise<boolean> {
  if (!dirLine) return false;
  if (!dir) {
    renderDirLine('还没有指定扩展目录');
    return false;
  }
  const permission = await ensureWritable(dir).catch(() => 'denied' as PermissionState);
  const writable = permission === 'granted';
  renderDirLine(
    dirInfo
      ? describeDirOk(dirInfo, writable)
      : `目录：${dir.name}${writable ? '（可写）' : '（未授予写入权限）'}`,
  );
  return writable;
}

/** 「选择扩展目录」—— 只需要做一次。 */
async function onPickDir(): Promise<void> {
  try {
    dir = await pickInstallDir();
    await storeDir(dir);
    appendLog(`已选择目录：${dir.name}`);
  } catch (error) {
    appendLog(`选择目录失败：${errorText(error)}`);
    return;
  }

  /**
   * 刚选的目录还**没校验过** ⇒ 先把上一次的结论清掉。
   * 否则 `refreshDirLine()` 会拿旧版本的号去描述新目录（错一帧也是错的）。
   */
  dirInfo = null;
  const writable = await refreshDirLine();

  /**
   * ## 选完**立刻**校验，别等下载完才发现选错（2026-11-17）
   *
   * 以前这里只把版本号写进日志：用户选错目录时，要等到"下载完 + 写入"才失败，
   * 而那一步的报错完全看不出是"目录选错了"。现在把校验提到这一步，
   * 并且把结论写在**用户正在看的那一行**（`#dir-line`）上。
   *
   * 判据用 `chrome.runtime.getManifest().name`（**运行时**的名字），不硬编码
   * `'Pluma'` —— 硬编码的话改一次 manifest 名字就永久失效，而且不会有人发现。
   */
  try {
    const info = await readDirManifest(dir);
    appendLog(`该目录的 manifest：${info.name ?? '（无 name）'} v${info.version}`);

    const expectedName = chrome.runtime.getManifest().name;
    if (info.name !== expectedName) {
      // 名字对不上 ⇒ 明确说"不是 Pluma"，并把它读到的名字摆出来（用户能自己对照）
      // `dirInfo` 保持 null：这个目录的版本号不该被后续的 `refreshDirLine()` 拿去用
      renderDirLine(`⚠️ 这个目录不是 Pluma（里面的名字是「${info.name ?? '空'}」）`, true);
      return;
    }
    dirInfo = info;
    renderDirLine(describeDirOk(info, writable));
  } catch (error) {
    // 这些 message 都是写给人看的一句话（见 `readDirManifest` 的注释）
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`⚠️ 读 manifest 失败：${message}`);
    renderDirLine(`⚠️ ${message}`, true);
  }
}

async function fetchZip(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`下载失败：HTTP ${String(response.status)}`);

  const total = Number(response.headers.get('content-length') ?? '0');
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > UPDATE_MAX_ZIP_BYTES) throw new Error('更新包超过体积上限');
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (received > UPDATE_MAX_ZIP_BYTES) throw new Error('更新包超过体积上限');
    if (total > 0) setProgress((received / total) * 100);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function onStart(): Promise<void> {
  if (busy) return;
  busy = true;
  syncButtons();
  setProgress(null);

  try {
    if (!status?.latestVersion) throw new Error('没有可更新的版本');
    /**
     * **纵深防御**（2026-11-17）。当前 UI 路径不可达：`syncButtons()` 已经用同一个
     * `isNewerThan` 把按钮禁掉了（本地比线上新时点不动）。但它是"如果哪天别处
     * 调用 `onStart()`"的唯一防线 —— 而写错这一处的代价是**降级安装**：
     * 用户本地装着 1.2.0，被退回线上的 1.1.0，且没有任何提示说这是降级。
     */
    if (!isNewerThan(status.latestVersion, status.currentVersion)) {
      throw new Error('没有可安装的新版本');
    }

    // 1) 句柄
    dir ??= await readStoredDir();
    if (!dir) throw new Error('还没有指定扩展目录，先点上面的「选择扩展目录」');

    // 2) 权限（在点击手势里，允许弹确认框）
    const permission = await ensureWritable(dir);
    if (permission !== 'granted') throw new Error('没有目录写入权限，无法覆盖文件');
    await storeDir(dir);

    // 3) 浅校验：这个目录至少得像个扩展
    const dirVersion = await readDirManifestVersion(dir);
    appendLog(`目标目录版本：${dirVersion}`);

    // 4) 下载
    say('正在下载…');
    if (!status.latestZipUrl) throw new Error('没有下载地址 —— 回到面板重新检查一次更新');
    const zipBuffer = await fetchZip(status.latestZipUrl);
    appendLog(`下载完成：${String(zipBuffer.byteLength)} 字节`);
    setProgress(null);

    // 5) 解压
    say('正在解压…');
    const entries = await readZip(zipBuffer, { maxEntryBytes: UPDATE_MAX_ENTRY_BYTES });
    appendLog(`解压出 ${String(entries.length)} 个条目`);

    // 6) 写入计划（路径安全 + 顶层白名单）
    const plan = planWrites(entries, {
      allowedTopLevel: UPDATE_ALLOWED_TOP_LEVEL,
      maxTotalBytes: UPDATE_MAX_ZIP_BYTES,
    });
    if (plan.rejected.length > 0) {
      throw new Error(`更新包里有不允许的条目：${plan.rejected.map((r) => r.path).join(', ')}`);
    }

    // 7) 版本必须对得上，否则说明下载到的不是目标版本
    const zipVersion = readManifestVersion(entries);
    if (zipVersion !== status.latestVersion) {
      throw new Error(`版本不符：包里是 ${zipVersion}，期望 ${status.latestVersion}`);
    }

    // 8) 逐文件写入（每个文件回读 size）
    say('正在写入扩展目录…');
    setProgress(0);
    const result = await writeFiles(dir, plan.writes, (progress) => {
      setProgress((progress.index / progress.total) * 100);
      if (progress.index === progress.total)
        appendLog(`写入完成：${String(progress.total)} 个文件`);
    });
    appendLog(`共写入 ${String(result.files)} 个文件 / ${String(result.bytes)} 字节`);

    // 9) 记下"这次要生效的版本"，由 SW 启动时核对（方案 Step 6）
    const state = await readUpdateState();
    await writeUpdateState(
      withPendingUpdate(state, { from: status.currentVersion, to: zipVersion, at: Date.now() }),
    );

    /**
     * 10) 收尾：**先让人看到结果，再交给 SW 关窗 + 重载**。
     *
     * ⚠️ 这里**不能**自己调 `chrome.runtime.reload()`（2026-11-17 真机 bug）：
     *
     * | 写法 | 用户看到什么 |
     * | --- | --- |
     * | 页面直接 reload | 上面那两行 `say` **一帧都没画出来**（reload 立刻销毁页面），而且没人关窗 ⇒ 440×600 的 popup 被 Chrome 填成**空白新标签页** |
     * | 先 `window.close()` 再 reload | 页面上下文已销毁，reload **根本不执行** |
     * | **本写法** | 停留 800ms 让人读到「已写入 N 个文件 / 正在重新加载扩展…」，然后由 SW 关窗、150ms 后 reload |
     *
     * 关窗与重载必须成对且有序，只有 SW 能两者都做（它在 reload 生效前还活着）。
     */
    say(`已写入 ${String(result.files)} 个文件，正在重新加载扩展…`);
    appendLog('完成后 B站 页面会提示刷新，刷新后才生效');
    // 让上面两行真的画出来（不留这一拍，用户永远看不到"写完了"）
    await new Promise((resolve) => setTimeout(resolve, UPDATE_SETTLE_MS));
    // fire-and-forget：窗口马上就没了，等应答没有意义
    void requestReload();
  } catch (error) {
    say(`更新失败：${errorText(error)}`);
    appendLog(`失败：${errorText(error)}`);
    busy = false;
    syncButtons();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

pickBtn?.addEventListener('click', () => {
  void onPickDir();
});
startBtn?.addEventListener('click', () => {
  void onStart();
});

async function boot(): Promise<void> {
  await readStatus();
  dir = await readStoredDir();
  await refreshDirLine();
  appendLog('窗口就绪');
}

void boot();
