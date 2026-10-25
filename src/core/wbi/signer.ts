/**
 * WBI 签名 —— B站 Web 接口的 `w_rid` / `wts` 参数。
 *
 * 算法（B站前端行为）：
 *   1. 从 nav 接口拿到 `img_url` / `sub_url`，各取文件名部分作为 `img_key` / `sub_key`
 *   2. `mixin_key = (img_key + sub_key)` 经固定置换表重排后取前 32 位
 *   3. 参数按 key 升序排列，值过滤 `!'()*` 字符
 *   4. `w_rid = md5(query + mixin_key)`，`wts = 当前秒级时间戳`
 *
 * ⚠️ 本文件的真值校验方式是**对拍真实请求**（见 docs/guides/debugging.md），
 * 单测只能验证置换表和过滤规则的内部一致性。
 */

/** B站固定的 mixinKey 置换表（下标 → 原位置） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
] as const;

/** 从完整 URL 里取文件名部分作为 key */
export function extractKeyFromUrl(url: string): string {
  const name = url.slice(url.lastIndexOf('/') + 1);
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/** img_key + sub_key → 32 位 mixin_key */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let out = '';
  for (const index of MIXIN_KEY_ENC_TAB) {
    out += raw[index] ?? '';
  }
  return out.slice(0, 32);
}

/** B站要求过滤掉 !'()* 这几个字符 */
export function filterValue(value: string): string {
  return value.replace(/[!'()*]/g, '');
}

/** 给参数加 wts + w_rid，返回完整的查询串 */
export function signQuery(params: Record<string, string | number>, mixin: string, wts: number): string {
  const withTs: Record<string, string> = { ...toStrMap(params), wts: String(wts) };

  const sorted = Object.keys(withTs)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filterValue(withTs[k] ?? ''))}`)
    .join('&');

  const wRid = md5Hex(sorted + mixin);
  return `${sorted}&w_rid=${wRid}`;
}

function toStrMap(params: Record<string, string | number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = String(v);
  return out;
}

// ── MD5（WebCrypto 不提供，必须自带实现） ──
// 只用于计算 w_rid，不涉及安全强度要求，标准实现即可。

function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return md5(bytes);
}

/** RSA Data Security 标准 MD5。返回 32 位小写 hex */
export function md5(message: Uint8Array): string {
  // 补位
  const bitLen = message.length * 8;
  const paddedLen = (((message.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(message);
  buf[message.length] = 0x80;

  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const s = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    const m = new Uint32Array(16);
    for (let j = 0; j < 16; j += 1) m[j] = view.getUint32(offset + j * 4, true);

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i += 1) {
      let F: number;
      let g: number;

      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      F = (F + A + k[i]! + m[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      const shift = s[(i >> 4) * 4 + (i % 4)]!;
      B = (B + ((F << shift) | (F >>> (32 - shift)))) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return [a0, b0, c0, d0].map((n) => hexLE(n)).join('');
}

function hexLE(n: number): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}
