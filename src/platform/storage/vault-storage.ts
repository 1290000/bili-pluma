/**
 * Vault 的物理存储 —— `chrome.storage.local`。
 *
 * 分两个 key：
 *   - `pluma:vault:blob` —— 密文（v / iv / data）
 *   - `pluma:vault:key`  —— 随机密钥（base64）
 *
 * ⚠️ 诚实的安全边界（README 原文照抄）：
 * 密钥与密文同存于本地。此加密**只防其他网页脚本 / 其他扩展直接读取**，
 * **不防本机程序**——任何能读本机文件的程序都能解出凭据。
 * 且 B站登录态本身就保存在浏览器 cookie 中，本加密不改变这一点。
 *
 * 不加"自动锁定"之类看起来安全但没有实际防护的机制，理由见
 * docs/decisions/0008-drop-passphrase-mode.md。
 */

import type { EncryptedBlob } from '@core/vault/crypto';
import type { VaultStorage } from '@core/vault/vault';

const BLOB_KEY = 'pluma:vault:blob';
const KEY_KEY = 'pluma:vault:key';

export function createVaultStorage(): VaultStorage {
  return {
    async readBlob() {
      const bag = await chrome.storage.local.get(BLOB_KEY);
      const blob = bag[BLOB_KEY] as EncryptedBlob | undefined;
      return blob ?? null;
    },

    async writeBlob(blob) {
      await chrome.storage.local.set({ [BLOB_KEY]: blob });
    },

    async clearBlob() {
      await chrome.storage.local.remove(BLOB_KEY);
    },

    async readKeyMaterial() {
      const bag = await chrome.storage.local.get(KEY_KEY);
      const material = bag[KEY_KEY] as string | undefined;
      return typeof material === 'string' && material.length > 0 ? material : null;
    },

    async writeKeyMaterial(base64) {
      await chrome.storage.local.set({ [KEY_KEY]: base64 });
    },

    async clearKeyMaterial() {
      await chrome.storage.local.remove(KEY_KEY);
    },
  };
}
