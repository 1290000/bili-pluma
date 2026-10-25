/**
 * 凭据加密原语 —— 纯 WebCrypto，不碰 storage、不碰 chrome API。
 *
 * 设计（见 docs/decisions/0008-drop-passphrase-mode.md）：
 *   - AES-GCM 256 认证加密：密文被篡改会**解密失败**，不会返回垃圾数据
 *   - 每次加密重新生成随机 IV
 *   - 密钥由 `generateRandomKey` 生成，导出为 base64 后由 platform 层存储
 *
 * ⚠️ 诚实的安全边界（必须原样出现在 README）：
 * 密钥与密文同存于本地，此加密**只防其他网页脚本 / 其他扩展直接读取**，
 * **不防本机程序**——任何能读本机文件的程序都能解密。
 * 且 B站登录态本身就保存在浏览器 cookie 中，本加密不改变这一点。
 */

const IV_BYTES = 12; // AES-GCM 推荐 96-bit IV
const KEY_BITS = 256;

export interface EncryptedBlob {
  /** 格式版本，用于将来迁移 */
  v: 1;
  /** base64，随机 IV */
  iv: string;
  /** base64，密文（含 GCM 认证标签） */
  data: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * base64 → 字节。
 *
 * 注意：TS 5.9 起 `crypto.subtle` 的参数要求 `ArrayBufferView<ArrayBuffer>`，
 * 而 `new Uint8Array(n)` 推断为 `ArrayBufferLike`（可能是 SharedArrayBuffer）。
 * 所以这里先显式建 `ArrayBuffer` 再包，返回类型标注为 `Uint8Array<ArrayBuffer>`。
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const buffer = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** 生成新的随机 AES-GCM 密钥 */
export async function generateRandomKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: KEY_BITS }, true, ['encrypt', 'decrypt']);
}

/** 导出为 base64，供 platform 层存储 */
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return toBase64(new Uint8Array(raw));
}

/** 从 base64 恢复密钥 */
export async function importKey(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64(base64), { name: 'AES-GCM', length: KEY_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/** 加密任意可序列化对象 */
export async function encryptJson(key: CryptoKey, payload: unknown): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext);

  return {
    v: 1,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(cipher)),
  };
}

/** 解密。密钥不对或密文被改会抛错（GCM 认证失败），不会返回垃圾数据 */
export async function decryptJson<T>(key: CryptoKey, blob: EncryptedBlob): Promise<T> {
  if (blob.v !== 1) throw new Error(`不支持的加密格式版本`);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(blob.iv) as BufferSource },
    key,
    fromBase64(blob.data) as BufferSource,
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
