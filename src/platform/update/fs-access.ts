/**
 * 往**扩展自己的安装目录**写文件 —— 唯一需要 File System Access 的地方。
 *
 * ## 为什么必须在这里而不是更上层
 *
 * 句柄的获取（`showDirectoryPicker`）、权限申请、递归建目录、逐文件写入，
 * 全都只能在**有 DOM 的扩展页面**里做。Service Worker 里没有 `showDirectoryPicker`，
 * content script 里句柄落在页面 origin（见方案 §1.3）——所以这段只属于更新窗口。
 *
 * ## 权限的真相（Step 0 实测）
 *
 * **句柄持久，权限不保证持久**。同一份句柄上 `queryPermission` 会在 `granted`
 * 与 `prompt` 之间摆动。所以这里**任何函数都不假定已授权**：
 * `ensureWritable()` 每次都查，必要时申请，而且必须由**用户手势**触发。
 */

const DB_NAME = 'pluma-update';
const STORE = 'handles';
const KEY = 'install-dir';

/**
 * Chromium 的权限方法不在 `lib.dom` 里，只声明用到的部分。
 * 不引入 `any` —— 仓库 lint 禁止。
 */
export interface PermDirHandle extends FileSystemDirectoryHandle {
  queryPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
}

interface PickerCapableWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandle>;
}

function hasPermissionMethods(handle: FileSystemDirectoryHandle): handle is PermDirHandle {
  const candidate = handle as Partial<PermDirHandle>;
  return (
    typeof candidate.queryPermission === 'function' &&
    typeof candidate.requestPermission === 'function'
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('indexedDB.open 失败'));
    };
  });
}

/** 读回上次选的目录句柄。**不校验权限**（那是 `ensureWritable` 的事）。 */
export async function readStoredDir(): Promise<PermDirHandle | null> {
  const db = await openDb();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error('get 失败'));
      };
    });
    if (!(value instanceof FileSystemDirectoryHandle)) return null;
    return hasPermissionMethods(value) ? value : null;
  } finally {
    db.close();
  }
}

export async function storeDir(dir: PermDirHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(dir, KEY);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('put 失败'));
      };
    });
  } finally {
    db.close();
  }
}

/** 弹系统目录选择框。**必须在用户手势里调用**。 */
export async function pickInstallDir(): Promise<PermDirHandle> {
  const picker = (window as unknown as PickerCapableWindow).showDirectoryPicker;
  if (!picker) throw new Error('本浏览器不支持 File System Access（showDirectoryPicker 不存在）');
  const handle = await picker({ id: 'pluma-install', mode: 'readwrite' });
  if (!hasPermissionMethods(handle)) throw new Error('句柄缺少权限方法，无法读写');
  return handle;
}

/**
 * 确保可写。返回最终的 `PermissionState`。
 *
 * ⚠️ **不许把它当成"已授权就跳过"的捷径**：`prompt` 时必须申请，
 * 而申请需要用户手势 —— 所以调用点必须在一个点击处理器里。
 */
export async function ensureWritable(dir: PermDirHandle): Promise<PermissionState> {
  const current = await dir.queryPermission({ mode: 'readwrite' });
  if (current === 'granted') return current;
  if (current === 'denied') return current;
  return dir.requestPermission({ mode: 'readwrite' });
}

export interface WriteProgress {
  index: number;
  total: number;
  path: string;
}

export interface WriteResult {
  files: number;
  bytes: number;
}

/**
 * 把一批文件写进目录。**递归建子目录**，每个文件写后回读 `size` 复核。
 *
 * ## 为什么回读 size
 *
 * `createWritable().close()` 不报错不代表字节真的落盘了（磁盘满、目录被删、
 * 文件被占用都可能吞掉写入）。回读一次是**唯一的**确认手段，成本是每个文件一次
 * `getFile()` —— 24 个小文件，可忽略。
 *
 * ⚠️ 这里**不删旧文件**。旧版本留下的 `chunks/old-hash.js` 会一直躺在目录里，
 * 不会被加载（manifest 与 html 都不再引用它），但要占用空间。删除需要遍历目录
 * 并判断"哪些是我写的"，风险高于收益，暂不做（见方案 §5 风险 1 的 P2）。
 */
export async function writeFiles(
  dir: PermDirHandle,
  writes: readonly { path: string; data: Uint8Array<ArrayBuffer> }[],
  onProgress?: (progress: WriteProgress) => void,
): Promise<WriteResult> {
  let bytes = 0;

  for (const [index, write] of writes.entries()) {
    const segments = write.path.split('/');
    const fileName = segments.pop();
    // 空段不放过：上游 `planWrites` 已经拦过一遍，但底层写入器**不该依赖调用方**。
    // `chunks//a.js` 这种在浏览器里会被解释成 `chunks/a.js`，静默"修好"比报错危险。
    if (!fileName || segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`非法路径：${write.path}`);
    }

    let parent: FileSystemDirectoryHandle = dir;
    for (const segment of segments) {
      parent = await parent.getDirectoryHandle(segment, { create: true });
    }

    const fileHandle = await parent.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(write.data);
    await writable.close();

    const back = await fileHandle.getFile();
    if (back.size !== write.data.byteLength) {
      throw new Error(
        `写入校验失败：${write.path} 期望 ${String(write.data.byteLength)} 字节，实得 ${String(back.size)}`,
      );
    }

    bytes += back.size;
    onProgress?.({ index: index + 1, total: writes.length, path: write.path });
  }

  return { files: writes.length, bytes };
}

/** 所选目录里 `manifest.json` 的两项关键信息 */
export interface DirManifestInfo {
  /**
   * manifest 里的 `name`；缺失 / 不是非空字符串时为 `null`。
   *
   * ⚠️ **缺失不算错**：能不能更新只看 `version`，名字只用来回答"这是不是 Pluma"。
   */
  name: string | null;
  version: string;
}

/**
 * 读所选目录里 `manifest.json` 的 `name` / `version` —— **浅校验"这是不是 Pluma 的目录"**。
 *
 * ## 为什么把 name 一起读出来（2026-11-17）
 *
 * 更新窗口里用户在选目录这一步最容易选错，而以前选完只在日志里写一句版本号，
 * **真正发现选错要等到"下载完 + 写入"**。要把校验提前到选完那一刻，就得知道
 * 目录里的 `name` 跟运行时是不是同一个（判据见 `update/main.ts` 的 `onPickDir`）。
 *
 * ## 错误一律是**给人看的话**
 *
 * 这些 `message` 会被直接渲染到界面上（`⚠️ {message}`），所以不许出现
 * `Unexpected token } in JSON` 这种引擎原话 —— 对用户来说那等于没说。
 *
 * @throws 目录里没有 manifest.json / 不是合法 JSON / 没有 version
 */
export async function readDirManifest(dir: PermDirHandle): Promise<DirManifestInfo> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await dir.getFileHandle('manifest.json');
  } catch {
    throw new Error('所选目录里没有 manifest.json —— 选到别的地方了');
  }

  const file = await fileHandle.getFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    // 引擎原话（"Unexpected token …"）没法给人看，换成能指导下一步的一句
    throw new Error('manifest.json 不是合法 JSON —— 可能选到别的地方了');
  }

  if (typeof parsed !== 'object' || parsed === null) throw new Error('manifest.json 结构异常');

  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0)
    throw new Error('manifest.json 没有 version');

  const name = (parsed as { name?: unknown }).name;
  return {
    name: typeof name === 'string' && name.length > 0 ? name : null,
    version,
  };
}

/**
 * 读所选目录里的 `manifest.json` 版本号。
 *
 * 只是 `readDirManifest()` 的薄包装 —— **判据与兜错只有那一份实现**，
 * 调用方要"是不是 Pluma"时才用 `readDirManifest()` 拿 `name`。
 */
export async function readDirManifestVersion(dir: PermDirHandle): Promise<string> {
  return (await readDirManifest(dir)).version;
}
