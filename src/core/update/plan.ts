/**
 * 把 zip 条目变成"要写哪些文件"的计划 —— **纯函数，不碰磁盘**。
 *
 * 这一层是整个更新流程里唯一能挡住"写出界"的地方，所以判据写死、拒绝要带原因：
 *
 * 1. **路径安全**：不许绝对路径、不许 `..`、不许盘符、不许软链接条目；
 * 2. **顶层白名单**：只允许 `UPDATE_ALLOWED_TOP_LEVEL` 里的东西。包里多出一个
 *    没见过的顶层项 ⇒ 整条拒绝（宁可失败，也不往扩展目录里丢陌生文件）；
 * 3. **必须像我们的包**：得有 `manifest.json`，且版本号与预期一致。
 *
 * ⚠️ 这不是签名校验。它能挡"包结构不对 / 路径穿越"，**挡不住**有人同时改
 * Release 与站点（见方案 §5 风险 6）。别把它当安全边界用。
 */

import type { ZipEntry } from '@core/update/zip';

export interface WriteAction {
  /** 归一化相对路径，正斜杠 */
  path: string;
  data: Uint8Array;
}

export interface RejectedEntry {
  path: string;
  reason: string;
}

export interface WritePlan {
  writes: WriteAction[];
  rejected: RejectedEntry[];
  totalBytes: number;
}

export interface PlanOptions {
  allowedTopLevel: readonly string[];
  /** 整包写入总量上限，防"解压炸弹"式的体积膨胀 */
  maxTotalBytes: number;
}

const SYMLINK_MODE = 0o120000;

/**
 * 归一化并校验单个条目路径。
 *
 * 抛错而不是返回 `null`：调用方**必须**显式处理"这条不要"，
 * 否则容易写成"过滤掉就算了"，而把真正的结构问题藏起来。
 */
export function normalizeEntryPath(raw: string): string {
  const slashed = raw.replace(/\\/g, '/');
  if (slashed.length === 0) throw new Error('空文件名');
  if (slashed.includes('\0')) throw new Error('文件名含 NUL');
  if (slashed.startsWith('/')) throw new Error(`绝对路径：${raw}`);
  if (/^[A-Za-z]:/.test(slashed)) throw new Error(`带盘符的路径：${raw}`);

  const trimmed = slashed.replace(/^\.\//, '');
  const segments = trimmed.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`路径含空段/相对段：${raw}`);
  }
  return segments.join('/');
}

/** 该路径是否落在白名单内。目录项以 `/` 结尾，表示整棵子树。 */
export function isAllowedPath(path: string, allowedTopLevel: readonly string[]): boolean {
  return allowedTopLevel.some((allowed) =>
    allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed,
  );
}

/**
 * 生成写入计划。
 *
 * 被拒绝的条目**不会**被静默丢弃，而是进 `rejected`：UI 要把它们显示出来，
 * 否则用户只会看到"更新失败"，不知道该找谁。
 */
export function planWrites(entries: readonly ZipEntry[], options: PlanOptions): WritePlan {
  const writes: WriteAction[] = [];
  const rejected: RejectedEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const entry of entries) {
    let path: string;
    try {
      path = normalizeEntryPath(entry.name);
    } catch (error) {
      rejected.push({
        path: entry.name,
        reason: error instanceof Error ? error.message : '路径非法',
      });
      continue;
    }

    if (entry.unixMode !== null && (entry.unixMode & 0o170000) === SYMLINK_MODE) {
      rejected.push({ path, reason: '软链接条目' });
      continue;
    }

    if (!isAllowedPath(path, options.allowedTopLevel)) {
      rejected.push({ path, reason: '顶层不在白名单' });
      continue;
    }

    if (seen.has(path)) {
      // 同名条目：zip 里出现两次说明打包有问题，直接拒绝整条而不是"后者覆盖"
      rejected.push({ path, reason: '重复条目' });
      continue;
    }

    totalBytes += entry.data.byteLength;
    if (totalBytes > options.maxTotalBytes) {
      throw new Error(`解压总量超过上限 ${String(options.maxTotalBytes)} 字节`);
    }

    seen.add(path);
    writes.push({ path, data: entry.data });
  }

  return { writes, rejected, totalBytes };
}

/**
 * 读包里的 `manifest.json` 版本号。
 *
 * 用途：写完之前先确认"这确实是要装的那一版"。缺文件 / 不是 JSON / 没有 version
 * 一律抛错 —— 这三种情况都说明拿到的不是我们的发行包。
 */
export function readManifestVersion(entries: readonly ZipEntry[]): string {
  const manifest = entries.find((entry) => normalizeEntryPath(entry.name) === 'manifest.json');
  if (!manifest) throw new Error('包里没有 manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(manifest.data));
  } catch {
    throw new Error('manifest.json 不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('manifest.json 结构异常');
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('manifest.json 没有 version');
  }
  return version;
}
