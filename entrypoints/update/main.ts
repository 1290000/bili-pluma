/**
 * 更新窗口 —— 「立即更新」真正干活的地方。
 *
 * ## 为什么是独立窗口
 *
 * `showDirectoryPicker` 必须在有 DOM 的**扩展页面**里调用：面板是注入 B站页面的
 * content script，在那里拿到的句柄属于**页面 origin**（句柄存不住，而且等于把
 * "能改写扩展目录"的能力交给网页域）。详见方案 §1.3。
 *
 * ## 顺序不能改（每一步都写了"为什么"）
 *
 * 1. 拿句柄 → 2. **在手势里**申请权限 → 3. 浅校验目录 → 4. 下载 →
 * 5. 解压 → 6. 生成计划 → 7. 校验版本 → 8. 逐文件写入 → 9. 记 pendingUpdate → 10. 收尾
 *
 * 前 8 步任何一步失败都**不 reload**：宁可这次不更新，也不能留下半新半旧的扩展。
 *
 * ## 渲染：**单点**（2026-11-17 重构）
 *
 * 改版前状态散在三个函数里（`say()` 改一行、`syncButtons()` 改按钮、`appendLog()`
 * 改日志），十几处调用点各自改 DOM —— 于是出现过"目录行说有目录、按钮却是灰的"
 * 这种自相矛盾。现在：
 *
 * ```
 * state.xxx = ...  →  renderWindow()   // 一处决定全部五个区块
 * ```
 *
 * `renderWindow()` 是**唯一**写 DOM 的地方（`appendLog` 只往 `<pre>` 里追加文本，
 * 不改可见性）。这条约束是这一版可读性的来源，别绕开它。
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
  readStoredDir,
  storeDir,
  writeFiles,
  type DirManifestInfo,
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

// ── DOM ─────────────────────────────────────────────────────────────
const versionLine = document.getElementById('version-line');
const stepEl = document.getElementById('step');
const stepN = document.getElementById('step-n');
const stepT1 = document.getElementById('step-t1');
const stepT2 = document.getElementById('step-t2');
const pickBtn = document.getElementById('pick-dir') as HTMLButtonElement | null;
const startBtn = document.getElementById('start') as HTMLButtonElement | null;
const bar = document.getElementById('bar') as HTMLProgressElement | null;
const statusEl = document.getElementById('status');
const logBox = document.getElementById('logbox') as HTMLDetailsElement | null;
const logEl = document.getElementById('log');

/**
 * 窗口的全部状态。
 *
 * ⚠️ 这是**唯一**的状态源：任何 DOM 变化都必须经由 `renderWindow()`，
 * 否则"两处各说一半"的老毛病会立刻回来。
 */
interface WindowState {
  status: UpdateStatusView | null;
  /** 用户选过 / 上次存下的目录句柄 */
  dir: PermDirHandle | null;
  /** 校验通过后的 manifest 信息；`null` = 还没校验过或不合法 */
  dirInfo: DirManifestInfo | null;
  /** 目录本身的问题（不是 Pluma / 没有 manifest.json）。有它就不能更新 */
  dirError: string | null;
  writable: boolean;
  busy: boolean;
  /** `null` = 不显示进度条 */
  progress: number | null;
  /**
   * - `idle`：等用户动手
   * - `working`：从点下按钮到收尾
   * - `failed`：出错，**详情自动展开**
   * - `done`：写完了，窗口马上被 SW 关掉
   */
  phase: 'idle' | 'working' | 'failed' | 'done';
  /** 状态行那一句话；空串 = 不显示（不留空行占位） */
  message: string;
}

const state: WindowState = {
  status: null,
  dir: null,
  dirInfo: null,
  dirError: null,
  writable: false,
  busy: false,
  progress: null,
  phase: 'idle',
  message: '',
};

/** 追加一行日志。**只追加文本**，可见性由 `renderWindow()` 按 phase 决定。 */
function appendLog(text: string): void {
  if (!logEl) return;
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${text}\n${logEl.textContent ?? ''}`;
}

// ── 渲染 ────────────────────────────────────────────────────────────

/**
 * 版本行：**四态，别合并**（2026-11-17 第三轮的口径，这里沿用）。
 *
 * | 情形 | 文案 |
 * | --- | --- |
 * | `status === null`（后台没应答） | `读不到版本信息` |
 * | `latestVersion === null`（没查过） | `当前 vX · 还没检查过` |
 * | 线上更新 | `vX → vY · 362 KB`（体积是"要下载多少"，和版本号是同一个问题） |
 * | 比过了、不新 | `当前 vX · 已是最新` |
 *
 * ⚠️ "没查过"不许写成「已是最新」：那是 §0 铁律的第四态，详见 `docs/02-ui-spec.md` §5.3。
 */
function describeVersion(status: UpdateStatusView | null): string {
  if (status === null) return '读不到版本信息';
  if (status.latestVersion === null) return `当前 v${status.currentVersion} · 还没检查过`;
  if (!isNewerThan(status.latestVersion, status.currentVersion)) {
    return `当前 v${status.currentVersion} · 已是最新`;
  }
  const size =
    status.latestSizeBytes === null
      ? ''
      : ` · ${String(Math.round(status.latestSizeBytes / 1024))} KB`;
  return `v${status.currentVersion} → v${status.latestVersion}${size}`;
}

/** 步骤行的副行：版本 · 可写性（· 已经是目标版本） */
function describeDirSub(
  info: DirManifestInfo,
  writable: boolean,
  status: UpdateStatusView | null,
): string {
  const perm = writable ? '可写入' : '未授予写入权限';
  // 只有在"目标版本已知且相等"时才追加；不相等就什么都不说 ——
  // 用户还没点「立即更新」，写"将升级到 vX"是承诺不是事实
  const target = status?.latestVersion === info.version ? ' · 已经是目标版本' : '';
  return `当前 v${info.version} · ${perm}${target}`;
}

/**
 * **唯一**渲染入口：五个区块一次算完。
 *
 * 顺序与页面自上而下一致（版本行 → 步骤行 → 主按钮 → 进度 → 状态行 → 详情），
 * 这样读这个函数就等于读整个窗口。
 */
function renderWindow(): void {
  const current = state;
  const hasTarget =
    current.status !== null &&
    isNewerThan(current.status.latestVersion, current.status.currentVersion);

  // ① 版本行
  if (versionLine) versionLine.textContent = describeVersion(current.status);

  // ② 步骤行
  const ok = current.dirInfo !== null && current.dirError === null;
  const bad = current.dirError !== null;
  if (stepEl) {
    stepEl.classList.toggle('ok', ok);
    stepEl.classList.toggle('bad', bad);
  }
  if (stepN) stepN.textContent = ok ? '✓' : bad ? '!' : '1';
  if (stepT1 && stepT2) {
    if (ok && current.dirInfo !== null) {
      stepT1.textContent = current.dir?.name ?? '已选择的目录';
      stepT2.textContent = describeDirSub(current.dirInfo, current.writable, current.status);
    } else if (bad) {
      stepT1.textContent = '目录有问题';
      stepT2.textContent = current.dirError ?? '';
    } else {
      stepT1.textContent = '选择扩展目录';
      stepT2.textContent = '这是 Pluma 现在被加载的那个文件夹';
    }
  }
  if (pickBtn) {
    pickBtn.textContent = ok || bad ? '更换' : '选择';
    pickBtn.disabled = current.busy;
  }

  // ③ 主按钮：**唯一判据**。文案永远叫「立即更新」——窗口里只有一个动作，
  //    改文案会让用户以为出现了新动作；状态只通过 enabled/disabled 表达。
  if (startBtn) {
    startBtn.disabled = current.busy || !ok || !current.writable || !hasTarget;
  }

  // ④ 进度
  if (bar) {
    bar.hidden = current.progress === null;
    if (current.progress !== null) bar.value = Math.min(100, Math.max(0, current.progress));
  }

  // ⑤ 状态行（空串就 hidden，不留空行占位）
  if (statusEl) {
    statusEl.textContent = current.message;
    statusEl.hidden = current.message === '';
  }

  // ⑥ 详情：**只有失败时**自动展开，其余收起
  if (logBox) logBox.open = current.phase === 'failed';
}

/** 改状态行那一句话并重画 */
function setMessage(text: string): void {
  state.message = text;
  renderWindow();
}

/** 改进度并重画。`null` = 收起进度条 */
function setProgress(value: number | null): void {
  state.progress = value;
  renderWindow();
}

// ── 读状态 ──────────────────────────────────────────────────────────

/** 有没有可装的更新 —— 全窗口唯一判据（与面板、与后台同一份 `isNewerThan`） */
function hasTarget(): boolean {
  return (
    state.status !== null && isNewerThan(state.status.latestVersion, state.status.currentVersion)
  );
}

async function readStatus(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({ type: 'update/status' }).catch(() => null)) as {
    type?: string;
    status?: UpdateStatusView;
  } | null;
  state.status = reply?.type === 'update/status:ok' ? (reply.status ?? null) : null;

  /**
   * 没有可更新的版本 ⇒ 主按钮必然是灰的，所以必须告诉用户下一步。
   *
   * 这句话来自改版前的 `say('没有可更新的版本 —— 关掉这个窗口，回到面板点「检查更新」再试。')`。
   * **信息不能丢**：新结构里它落在状态行，与失败/进行中的话共用同一行。
   */
  state.message = hasTarget()
    ? ''
    : '没有可更新的版本 —— 关掉这个窗口，回到面板点「检查更新」再试。';
  renderWindow();
}

// ── 目录 ────────────────────────────────────────────────────────────

/**
 * 校验一个目录句柄：能不能写 + 里面是不是 Pluma。
 *
 * 选目录与开窗（上次存过句柄）**都走这一个函数** —— 判据只有一份。
 *
 * ## 判据用运行时自己取的名字
 *
 * `chrome.runtime.getManifest().name`，**不是**硬编码 `'Pluma'`：
 * 硬编码的话改一次 manifest 名字就永久失效，而且不会有人发现。
 *
 * ## 读盘失败要说，但不能吓人
 *
 * 这些失败（没有 manifest.json / 不是合法 JSON / 名字对不上）都要落进 `dirError`，
 * 它会显示在步骤行里，并且**禁用主按钮** —— 用户必须换一个目录才能继续。
 */
async function validateDir(handle: PermDirHandle): Promise<void> {
  state.dir = handle;
  state.dirInfo = null;
  state.dirError = null;
  state.writable = false;

  const permission = await ensureWritable(handle).catch(() => 'denied' as PermissionState);
  state.writable = permission === 'granted';

  try {
    const info = await readDirManifest(handle);
    const expectedName = chrome.runtime.getManifest().name;
    if (info.name !== expectedName) {
      // 把它读到的名字摆出来，用户能自己对照是哪个目录
      state.dirError = `这个目录不是 Pluma（里面的名字是「${info.name ?? '空'}」）`;
      appendLog(`目录校验失败：${state.dirError}`);
    } else {
      state.dirInfo = info;
      appendLog(`目录校验通过：${info.name ?? '（无 name）'} v${info.version}`);
    }
  } catch (error) {
    state.dirError = error instanceof Error ? error.message : String(error);
    appendLog(`目录校验失败：${state.dirError}`);
  }

  renderWindow();
}

/** 「选择 / 更换目录」 */
async function onPickDir(): Promise<void> {
  if (state.busy) return;

  let handle: PermDirHandle;
  try {
    handle = await pickInstallDir();
    await storeDir(handle);
    appendLog(`已选择目录：${handle.name}`);
  } catch (error) {
    // 用户取消选择也会走到这里 —— 不是错误，只记日志，界面保持原样
    appendLog(`选择目录未完成：${errorText(error)}`);
    return;
  }

  await validateDir(handle);
}

// ── 更新流程 ────────────────────────────────────────────────────────

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
  if (state.busy) return;
  state.busy = true;
  state.phase = 'working';
  state.progress = null;
  setMessage('正在准备…');

  try {
    if (!state.status?.latestVersion) throw new Error('没有可更新的版本');
    /**
     * **纵深防御**（2026-11-17）。当前 UI 路径不可达：`renderWindow()` 已经用同一个
     * `isNewerThan` 把按钮禁掉了（本地比线上新时点不动）。但它是"如果哪天别处
     * 调用 `onStart()`"的唯一防线 —— 而写错这一处的代价是**降级安装**：
     * 用户本地装着 1.2.0，被退回线上的 1.1.0，且没有任何提示说这是降级。
     */
    if (!isNewerThan(state.status.latestVersion, state.status.currentVersion)) {
      throw new Error('没有可安装的新版本');
    }

    // 1) 句柄
    state.dir ??= await readStoredDir();
    const dir = state.dir;
    if (!dir) throw new Error('还没有指定扩展目录，先点上面的「选择」');

    // 2) 权限（在点击手势里，允许弹确认框）
    const permission = await ensureWritable(dir);
    if (permission !== 'granted') throw new Error('没有目录写入权限，无法覆盖文件');
    state.writable = true;
    await storeDir(dir);

    // 3) 浅校验：这个目录至少得像个扩展
    const dirVersion = await readDirManifestVersion(dir);
    appendLog(`目标目录版本：${dirVersion}`);

    // 4) 下载
    setMessage('正在下载…');
    if (!state.status.latestZipUrl) throw new Error('没有下载地址 —— 回到面板重新检查一次更新');
    const zipBuffer = await fetchZip(state.status.latestZipUrl);
    appendLog(`下载完成：${String(zipBuffer.byteLength)} 字节`);
    setProgress(null);

    // 5) 解压
    setMessage('正在解压…');
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
    if (zipVersion !== state.status.latestVersion) {
      throw new Error(`版本不符：包里是 ${zipVersion}，期望 ${state.status.latestVersion}`);
    }

    // 8) 逐文件写入（每个文件回读 size）
    setMessage('正在写入扩展目录…');
    setProgress(0);
    const wrote = await writeFiles(dir, plan.writes, (progress) => {
      setProgress((progress.index / progress.total) * 100);
      setMessage(`正在写入 ${String(progress.index)} / ${String(progress.total)}`);
      if (progress.index === progress.total) {
        appendLog(`写入完成：${String(progress.total)} 个文件`);
      }
    });
    appendLog(`共写入 ${String(wrote.files)} 个文件 / ${String(wrote.bytes)} 字节`);

    // 9) 记下"这次要生效的版本"，由 SW 启动时核对（方案 Step 6）
    const stored = await readUpdateState();
    await writeUpdateState(
      withPendingUpdate(stored, {
        from: state.status.currentVersion,
        to: zipVersion,
        at: Date.now(),
      }),
    );

    /**
     * 10) 收尾：**先让人看到结果，再交给 SW 关窗 + 重载**。
     *
     * ⚠️ 这里**不能**自己调 `chrome.runtime.reload()`（2026-11-17 真机 bug）：
     *
     * | 写法 | 用户看到什么 |
     * | --- | --- |
     * | 页面直接 reload | 上面那句话**一帧都没画出来**（reload 立刻销毁页面），而且没人关窗 ⇒ 440×600 的 popup 被 Chrome 填成**空白新标签页** |
     * | 先 `window.close()` 再 reload | 页面上下文已销毁，reload **根本不执行** |
     * | **本写法** | 停留 800ms 让人读到「已写入 N 个文件，正在重新加载扩展…」，然后由 SW 关窗、150ms 后 reload |
     *
     * 关窗与重载必须成对且有序，只有 SW 能两者都做（它在 reload 生效前还活着）。
     */
    state.phase = 'done';
    state.progress = null;
    setMessage(`已写入 ${String(wrote.files)} 个文件，正在重新加载扩展…`);
    appendLog('完成后 B站 页面会提示刷新，刷新后才生效');
    // 让上面那句话真的画出来（不留这一拍，用户永远看不到"写完了"）
    await new Promise((resolve) => setTimeout(resolve, UPDATE_SETTLE_MS));
    // fire-and-forget：窗口马上就没了，等应答没有意义
    void requestReload();
  } catch (error) {
    state.busy = false;
    state.phase = 'failed';
    state.progress = null;
    setMessage(`更新失败：${errorText(error)}`);
    appendLog(`失败：${errorText(error)}`);
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

  /**
   * 上次选过目录就直接校验它。
   *
   * ## 为什么开窗也要校验（而不是"等用户点更新再说"）
   *
   * 主按钮的判据里有 `dirInfo`（校验通过才有）。若开窗不校验，老用户每次
   * 打开窗口都得重新点一次「选择」才能更新 —— 那是把"记住的选择"变成摆设。
   *
   * 校验失败也不会冤枉谁：`dirError` 会写在步骤行里（"这个目录不是 Pluma" /
   * "没有 manifest.json"），用户看一眼就知道该换目录，而不是等到下载完才炸。
   */
  const stored = await readStoredDir().catch(() => null);
  if (stored) await validateDir(stored);

  appendLog('窗口就绪');
}

void boot();
