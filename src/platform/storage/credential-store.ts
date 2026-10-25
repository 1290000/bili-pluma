/**
 * 凭据门面 —— background 只通过这里读写凭据。
 *
 * 把 `core/vault` 与 `platform/storage` 接起来。
 * **不把凭据暴露给 UI**（UI 走 `account/summary` 拿不含凭据的摘要）。
 */

import { clearVault, hasCredential, loadCredential, saveCredential } from '@core/vault/vault';
import type { Credential } from '@shared/types/account';

import { createVaultStorage } from './vault-storage';

const storage = () => createVaultStorage();

/** 登录成功后落库（AES-GCM 加密后写 storage.local） */
export async function persistCredential(credential: Credential): Promise<void> {
  await saveCredential(storage(), credential);
}

/** 读取凭据。未配置时返回 null。调用方用完即弃，不要存进全局变量 */
export async function readPersistedCredential(): Promise<Credential | null> {
  return loadCredential(storage());
}

/** 是否已配置播放账号（不解密） */
export async function hasPersistedCredential(): Promise<boolean> {
  return hasCredential(storage());
}

/** 退出播放账号：清掉密文和密钥 */
export async function removeCredential(): Promise<void> {
  await clearVault(storage());
}
