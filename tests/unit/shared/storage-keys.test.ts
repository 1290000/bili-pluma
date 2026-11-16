/**
 * 存储键共享常量 —— 重点是 `isVaultChange()` 这个判据。
 *
 * 为什么值得单独测：它决定"扫码成功后面板要不要重新取数"。
 * 判错的两种后果都很难发现 ——
 *   - 漏判（返回 false）：面板停在旧状态，用户以为没登录成功
 *   - 误判（别的键也返回 true）：每次改净化开关都重新取一次账号，白跑网络
 */

import { describe, expect, it } from 'vitest';

import {
  isVaultChange,
  VAULT_BLOB_KEY,
  VAULT_KEY_KEY,
} from '../../../src/shared/constants/storage-keys';

describe('isVaultChange', () => {
  it('密文变了 → true（登录成功的正常路径）', () => {
    expect(isVaultChange([VAULT_BLOB_KEY])).toBe(true);
  });

  it('密钥变了 → true（写入顺序是先密钥后密文，只判密文会漏时序边缘）', () => {
    expect(isVaultChange([VAULT_KEY_KEY])).toBe(true);
  });

  it('两个一起变 → true（首次登录就是这种）', () => {
    expect(isVaultChange([VAULT_KEY_KEY, VAULT_BLOB_KEY])).toBe(true);
  });

  it('退出账号（删除）也是变化 → true', () => {
    // storage.onChanged 的 remove 同样是"这个键出现"，新旧值都可能是 undefined
    expect(isVaultChange([VAULT_BLOB_KEY])).toBe(true);
  });

  it('无关的键 → false（不能每次改开关都重取账号）', () => {
    expect(isVaultChange(['pluma:panel-entry-enabled', 'pluma:update-state'])).toBe(false);
  });

  it('空变化集 → false', () => {
    expect(isVaultChange([])).toBe(false);
  });
});

describe('键字面量', () => {
  it('与 vault-storage 实际写入的键一致', () => {
    /**
     * ⚠️ 这两条断言看着像"测常量等于常量"，但它守的是一件真事：
     * 已装好的浏览器里，`storage.local` 里躺着的就是这两个字符串。
     * 改名 = 存量用户的密文再也读不到（表现为"登录状态莫名丢了"）。
     * 真要改名，必须同时写迁移，并把这里一起改。
     */
    expect(VAULT_BLOB_KEY).toBe('pluma:vault:blob');
    expect(VAULT_KEY_KEY).toBe('pluma:vault:key');
  });
});
