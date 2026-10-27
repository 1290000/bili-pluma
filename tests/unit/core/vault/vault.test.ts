import { describe, expect, it } from 'vitest';

import type { EncryptedBlob } from '@core/vault/crypto';
import {
  clearVault,
  hasCredential,
  loadCredential,
  saveCredential,
  type VaultStorage,
} from '@core/vault/vault';
import type { Credential } from '@shared/types/account';

/** 内存版存储，模拟 chrome.storage.local */
function memoryStorage(): VaultStorage & { dump(): Record<string, unknown> } {
  let blob: EncryptedBlob | null = null;
  let material: string | null = null;

  return {
    readBlob: async () => blob,
    writeBlob: async (b) => {
      blob = b;
    },
    clearBlob: async () => {
      blob = null;
    },
    readKeyMaterial: async () => material,
    writeKeyMaterial: async (m) => {
      material = m;
    },
    clearKeyMaterial: async () => {
      material = null;
    },
    dump: () => ({ blob, material }),
  };
}

const credential: Credential = {
  sessdata: 'deadbeef,1700000000,1*FAKEsessdata',
  biliJct: '8bf1e88c2633143a485be4ad40e29c7e',
  dedeUserId: '1000002',
};

describe('saveCredential / loadCredential', () => {
  it('存入后能读回', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    expect(await loadCredential(s)).toEqual(credential);
  });

  it('落库内容里没有任何明文凭据', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    const raw = JSON.stringify(s.dump());
    expect(raw).not.toContain('deadbeef');
    expect(raw).not.toContain('8bf1e88c');
    expect(raw).not.toContain('1000002');
    expect(raw).not.toContain('sessdata');
    expect(raw).not.toContain('biliJct');
  });

  it('blob 只有 v / iv / data 三个字段（不夹带多余信息）', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    const blob = s.dump().blob as EncryptedBlob;
    expect(Object.keys(blob).sort()).toEqual(['data', 'iv', 'v']);
  });

  it('没存过时返回 null', async () => {
    expect(await loadCredential(memoryStorage())).toBeNull();
  });

  it('密钥丢失时返回 null 而不是抛错', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    await s.clearKeyMaterial();
    expect(await loadCredential(s)).toBeNull();
  });

  it('密钥被删后即使刚读过也必须返回 null（缓存不能掩盖磁盘状态）', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);

    // 先读一次，把密钥装进缓存
    expect(await loadCredential(s)).toEqual(credential);

    // 再从磁盘删掉密钥
    await s.clearKeyMaterial();

    // 缓存必须失效 —— 否则表现为"用户清了 storage 却清不干净"
    expect(await loadCredential(s)).toBeNull();
  });

  it('磁盘密钥被换掉后不会用旧缓存解密（必须重新 import）', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    const oldMaterial = s.dump().material as string;

    // 先读一次装缓存
    expect(await loadCredential(s)).toEqual(credential);

    // 模拟另一个测试/会话把密钥换成新的（密文还是旧的 → 应该解不开）
    await s.writeKeyMaterial('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await expect(loadCredential(s)).rejects.toThrow();

    // 换回原密钥应能恢复
    await s.writeKeyMaterial(oldMaterial);
    expect(await loadCredential(s)).toEqual(credential);
  });

  it('重复保存复用同一个密钥', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    const first = s.dump().material;
    await saveCredential(s, { ...credential, biliJct: 'rotated' });
    expect(s.dump().material).toBe(first);
  });

  it('覆盖保存后读到的是新值', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    await saveCredential(s, { ...credential, biliJct: 'rotated' });
    expect((await loadCredential(s))?.biliJct).toBe('rotated');
  });

  it('密文被篡改时抛错（GCM 认证失败）', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    const blob = s.dump().blob as EncryptedBlob;
    const bytes = Uint8Array.from(atob(blob.data), (c) => c.charCodeAt(0));
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await s.writeBlob({ ...blob, data: btoa(String.fromCharCode(...bytes)) });
    await expect(loadCredential(s)).rejects.toThrow();
  });

  it('换一个全新的 storage（模拟浏览器重启）仍能读出', async () => {
    const s1 = memoryStorage();
    await saveCredential(s1, credential);
    const snapshot = s1.dump() as { blob: EncryptedBlob; material: string };

    const s2 = memoryStorage();
    await s2.writeBlob(snapshot.blob);
    await s2.writeKeyMaterial(snapshot.material);

    expect(await loadCredential(s2)).toEqual(credential);
  });
});

describe('hasCredential', () => {
  it('没存过为 false，存过为 true', async () => {
    const s = memoryStorage();
    expect(await hasCredential(s)).toBe(false);
    await saveCredential(s, credential);
    expect(await hasCredential(s)).toBe(true);
  });

  it('不解密、不影响内存状态', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    const before = JSON.stringify(s.dump());
    expect(await hasCredential(s)).toBe(true);
    expect(JSON.stringify(s.dump())).toBe(before);
  });

  it('密钥丢失但密文还在时仍返回 true（它只判断"配过没"）', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    await s.clearKeyMaterial();
    expect(await hasCredential(s)).toBe(true);
  });
});

describe('clearVault', () => {
  it('清除后密文和密钥都没了', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    await clearVault(s);

    expect(await hasCredential(s)).toBe(false);
    expect(await loadCredential(s)).toBeNull();
    expect(s.dump().material).toBeNull();
  });

  it('清除后重新保存能正常工作（不会残留旧密钥状态）', async () => {
    const s = memoryStorage();
    await saveCredential(s, credential);
    await clearVault(s);

    const other: Credential = { sessdata: 'new', biliJct: 'new', dedeUserId: '999' };
    await saveCredential(s, other);
    expect(await loadCredential(s)).toEqual(other);
  });
});
