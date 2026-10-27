import { describe, expect, it } from 'vitest';

import {
  decryptJson,
  encryptJson,
  exportKey,
  generateRandomKey,
  importKey,
  type EncryptedBlob,
} from '@core/vault/crypto';

interface Sample {
  sessdata: string;
  biliJct: string;
  dedeUserId: string;
}

const sample: Sample = {
  sessdata: 'deadbeef,1700000000,1*FAKEsessdataSignature',
  biliJct: '8bf1e88c2633143a485be4ad40e29c7e',
  dedeUserId: '1000002',
};

describe('加解密往返', () => {
  it('加密后能原样解回', async () => {
    const key = await generateRandomKey();
    const blob = await encryptJson(key, sample);
    expect(await decryptJson<Sample>(key, blob)).toEqual(sample);
  });

  it('密文里不出现任何明文片段', async () => {
    const key = await generateRandomKey();
    const blob = await encryptJson(key, sample);
    const raw = JSON.stringify(blob);
    expect(raw).not.toContain('deadbeef');
    expect(raw).not.toContain('8bf1e88c');
    expect(raw).not.toContain('sessdata');
  });

  it('blob 只有 v / iv / data 三个字段', async () => {
    const key = await generateRandomKey();
    const blob = await encryptJson(key, sample);
    expect(Object.keys(blob).sort()).toEqual(['data', 'iv', 'v']);
    expect(blob.v).toBe(1);
  });

  it('相同明文两次加密的密文不同（IV 随机）', async () => {
    const key = await generateRandomKey();
    const a = await encryptJson(key, sample);
    const b = await encryptJson(key, sample);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it('能加密不含字符串的对象（数组、数字、null、布尔）', async () => {
    const key = await generateRandomKey();
    for (const payload of [[1, 2, 3], { n: 42 }, null, true, { nested: { deep: ['a'] } }]) {
      const blob = await encryptJson(key, payload);
      expect(await decryptJson(key, blob)).toEqual(payload);
    }
  });
});

describe('密钥导出与导入', () => {
  it('导出再导入仍能解密', async () => {
    const key = await generateRandomKey();
    const blob = await encryptJson(key, sample);
    const restored = await importKey(await exportKey(key));
    expect(await decryptJson<Sample>(restored, blob)).toEqual(sample);
  });

  it('导出的密钥是 256 位（base64 后 44 字符）', async () => {
    const material = await exportKey(await generateRandomKey());
    expect(material).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(atob(material).length).toBe(32);
  });

  it('每次生成的密钥都不同', async () => {
    const a = await exportKey(await generateRandomKey());
    const b = await exportKey(await generateRandomKey());
    expect(a).not.toBe(b);
  });
});

describe('认证失败防护', () => {
  it('用错误的密钥解密会抛错，不返回垃圾数据', async () => {
    const key = await generateRandomKey();
    const wrong = await generateRandomKey();
    const blob = await encryptJson(key, sample);
    await expect(decryptJson(wrong, blob)).rejects.toThrow();
  });

  it('密文被篡改会抛错', async () => {
    const key = await generateRandomKey();
    const blob = await encryptJson(key, sample);
    const bytes = Uint8Array.from(atob(blob.data), (c) => c.charCodeAt(0));
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered: EncryptedBlob = { ...blob, data: btoa(String.fromCharCode(...bytes)) };
    await expect(decryptJson(key, tampered)).rejects.toThrow();
  });

  it('IV 被篡改会抛错', async () => {
    const key = await generateRandomKey();
    const blob = await encryptJson(key, sample);
    const bytes = Uint8Array.from(atob(blob.iv), (c) => c.charCodeAt(0));
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered: EncryptedBlob = { ...blob, iv: btoa(String.fromCharCode(...bytes)) };
    await expect(decryptJson(key, tampered)).rejects.toThrow();
  });

  it('不支持的版本号直接拒绝', async () => {
    const key = await generateRandomKey();
    const blob = await encryptJson(key, sample);
    await expect(decryptJson(key, { ...blob, v: 2 as unknown as 1 })).rejects.toThrow(/版本/);
  });

  it('空字符串也能正确往返（不触发 falsy 判断错误）', async () => {
    const key = await generateRandomKey();
    const blob = await encryptJson(key, '');
    expect(await decryptJson<string>(key, blob)).toBe('');
  });
});
