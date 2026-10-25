/**
 * 凭据仓库 —— 加密、解密都在这层，但**不知道密钥和密文存在哪**
 * （存储通过 `VaultStorage` 注入，所以 `core/` 里不会出现 `chrome.storage`）。
 *
 * 设计取舍（见 docs/decisions/0008-drop-passphrase-mode.md）：
 *
 * 只有一个模式：随机密钥 + AES-GCM，密钥与密文同存本地。
 *
 * **不做的事，以及为什么不做**：
 *   - 不做口令模式：防不住"本机程序"这个威胁（能读本机文件的程序同样能读浏览器
 *     cookie 数据库里的 SESSDATA），只会增加操作负担
 *   - 不做自动锁定：`lock()` 只清内存缓存，下次 `loadCredential` 会从磁盘重新
 *     import，攻击者执行一次就能拿到明文。**没有实际防护效果的机制一律不加。**
 *
 * 所以内存里的 `cachedKey` 只是**性能缓存**，不是安全机制。它存在的时间窗口
 * 不影响真实安全强度——因为密钥本来就在磁盘上。
 */

import type { Credential } from '@shared/types/account';

import {
  decryptJson,
  encryptJson,
  exportKey,
  generateRandomKey,
  importKey,
  type EncryptedBlob,
} from './crypto';

/** platform 层实现这个接口，core 只依赖接口 */
export interface VaultStorage {
  readBlob(): Promise<EncryptedBlob | null>;
  writeBlob(blob: EncryptedBlob): Promise<void>;
  clearBlob(): Promise<void>;
  readKeyMaterial(): Promise<string | null>;
  writeKeyMaterial(base64: string): Promise<void>;
  clearKeyMaterial(): Promise<void>;
}

/**
 * 密钥缓存。
 *
 * 纯性能优化：避免每次读凭据都重新 import。**不是安全边界**，不要给它附加语义。
 * 同时记录 `cachedMaterial`，用于判断"磁盘上的密钥是否被换过/删过"。
 */
let cachedKey: CryptoKey | null = null;
let cachedMaterial: string | null = null;

function dropKeyCache(): void {
  cachedKey = null;
  cachedMaterial = null;
}

/**
 * 保存凭据。若已有密钥则复用，否则生成新的。
 *
 * 复用而不是每次换：换密钥要重新加密已存数据，而现在只有一个 blob，
 * 复用更简单，也避免"密钥换了旧密文解不开"。
 */
export async function saveCredential(storage: VaultStorage, credential: Credential): Promise<void> {
  let material = await storage.readKeyMaterial();

  if (!material) {
    const fresh = await generateRandomKey();
    material = await exportKey(fresh);
    await storage.writeKeyMaterial(material);
  }

  const key = await importKey(material);
  const blob = await encryptJson(key, credential);
  await storage.writeBlob(blob);

  cachedKey = key;
  cachedMaterial = material;
}

/**
 * 读取凭据。未配置或密钥丢失时返回 null。
 *
 * 返回的明文只在调用方栈上存活——**不要把它放进模块级变量**，
 * 用完就让它可回收（这是 JS 里唯一能做的"内存清理"）。
 *
 * ⚠️ 这里**不用 `cachedKey` 做短路**。曾经写成 `if (!cachedKey) { 读密钥 }`，
 * 结果缓存会掩盖"磁盘上的密钥已被删除"这个事实——用户清了 storage 后
 * 扩展仍能读出凭据，表现为"清不干净"。
 * 现在每次都校验磁盘上的密钥是否存在，缓存只用于省掉 `importKey` 的开销。
 */
export async function loadCredential(storage: VaultStorage): Promise<Credential | null> {
  const blob = await storage.readBlob();
  if (!blob) return null;

  const material = await storage.readKeyMaterial();
  if (!material) return null; // 密钥丢了，密文无意义

  // 只有密钥与缓存的是同一份时才复用缓存，否则重新 import
  if (!cachedKey || cachedMaterial !== material) {
    cachedKey = await importKey(material);
    cachedMaterial = material;
  }

  return decryptJson<Credential>(cachedKey, blob);
}

/** 是否已保存过凭据（不做解密，不依赖内存状态） */
export async function hasCredential(storage: VaultStorage): Promise<boolean> {
  return (await storage.readBlob()) !== null;
}

/**
 * 清除凭据（退出播放账号）：密文、密钥、内存缓存一起清。
 *
 * 这是 `cachedKey` 唯一需要被主动清掉的场景——退出后不该在内存里留着可用的密钥。
 */
export async function clearVault(storage: VaultStorage): Promise<void> {
  await storage.clearBlob();
  await storage.clearKeyMaterial();
  dropKeyCache();
}
