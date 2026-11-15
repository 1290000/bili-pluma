/**
 * GitHub Release JSON → `LatestRelease` —— **纯函数，不联网**。
 *
 * 把解析单独拆出来（而不是塞进 `platform/update/github.ts`）有两个理由：
 * 1. 真实的 GitHub 响应结构很松散（字段可能缺、资产可能多个、可能混进预发布），
 *    这些分支必须能在单测里穷举，而不是靠"打一次真实接口看看"；
 * 2. `platform/` 那层只该关心"发请求、拿 JSON、分类结果"，判断留给 core。
 */

import type { LatestRelease } from '@core/update/state';
import { parseVersion } from '@core/update/version';
import { UPDATE_ASSET_PREFIX, UPDATE_MAX_ZIP_BYTES } from '@shared/constants/update';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `v1.1.0` → `1.1.0`。前缀只剥一个，`vv1.0.0` 应当报错而不是被"修好"。 */
function stripTagPrefix(tag: string): string {
  return tag.startsWith('v') || tag.startsWith('V') ? tag.slice(1) : tag;
}

/**
 * 从资产列表里挑出**精简包**。
 *
 * 优先精确匹配 `pluma-<version>.zip`；匹配不到时退化到"前缀对、后缀对、且不是
 * `-with-source`"。绝不接受 `-with-source` —— 那个包 3.2 MB 且结构是
 * `extension/manifest.json`，写进去会把扩展目录搞成两层。
 */
function pickAsset(assets: readonly unknown[], version: string): Record<string, unknown> {
  const records = assets.filter(isRecord);
  const exact = `pluma-${version}.zip`;
  const found =
    records.find((a) => a.name === exact) ??
    records.find(
      (a) =>
        typeof a.name === 'string' &&
        a.name.startsWith(UPDATE_ASSET_PREFIX) &&
        a.name.endsWith('.zip') &&
        !a.name.includes('-with-source'),
    );
  if (!found) throw new Error(`Release 里没有 ${exact}`);
  return found;
}

/**
 * 解析 `/releases/latest` 的响应体。
 *
 * 任何一种"不像我们的发行包"的情况都抛错并**说明原因** —— 上层据此决定
 * 是"静默重试"还是"在诊断里显示出来"。
 */
export function parseLatestRelease(json: unknown): LatestRelease {
  if (!isRecord(json)) throw new Error('Release 响应不是对象');

  if (json.draft === true) throw new Error('拿到的是 draft release');
  if (json.prerelease === true) throw new Error('拿到的是预发布版本');

  if (typeof json.tag_name !== 'string' || json.tag_name.length === 0) {
    throw new Error('Release 缺 tag_name');
  }
  const version = stripTagPrefix(json.tag_name);
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`tag_name 不是合法版本号：${json.tag_name}`);
  if (parsed.prerelease !== null) throw new Error(`tag_name 是预发布：${json.tag_name}`);

  if (!Array.isArray(json.assets)) throw new Error('Release 缺 assets');
  const asset = pickAsset(json.assets, version);

  const zipUrl = asset.browser_download_url;
  if (typeof zipUrl !== 'string' || !zipUrl.startsWith('https://')) {
    throw new Error('资产下载地址不是 https');
  }

  const sizeBytes = asset.size;
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error('资产 size 不可信');
  }
  if (sizeBytes > UPDATE_MAX_ZIP_BYTES) {
    throw new Error(`资产过大：${String(sizeBytes)} 字节`);
  }

  return {
    version,
    zipUrl,
    sizeBytes,
    publishedAt: typeof json.published_at === 'string' ? json.published_at : '',
  };
}
