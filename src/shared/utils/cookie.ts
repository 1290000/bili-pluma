/**
 * Cookie 头的解析 / 序列化 / 合并 —— 纯函数，零依赖。
 *
 * 这些函数看着简单，但 B站的真实 Cookie 有几个坑：
 *   - `SESSDATA` 的值里含**逗号**（`deadbeef,1700000000,1*FAKEsessdata*...`）
 *   - `buvid4` 的值里含**等号**（base64 padding `==`）
 *   - 值里可能有 `%2C` 之类的 URL 编码，**不能解码**（服务端要原样）
 *
 * 解析错了的表现是"偶发 -101 / -412"，极难定位，所以这里必须有单测。
 */

export type CookieMap = Record<string, string>;

/** `a=1; b=2` → `{ a: '1', b: '2' }`。忽略空段与无等号的段。 */
export function parseCookie(header: string): CookieMap {
  const out: CookieMap = {};
  if (header.length === 0) return out;

  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;

    const name = segment.slice(0, eq).trim();
    if (name.length === 0) continue;

    out[name] = segment.slice(eq + 1).trim();
  }

  return out;
}

/** `{ a: '1', b: '2' }` → `a=1; b=2` */
export function serializeCookie(cookies: CookieMap): string {
  return Object.entries(cookies)
    .filter(([name]) => name.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/** override 覆盖 base 的同名键，base 独有的键保留 */
export function mergeCookie(base: CookieMap, override: CookieMap): CookieMap {
  return { ...base, ...override };
}

/** 只挑指定名字，缺失的不产生 undefined 字段 */
export function pickCookie(cookies: CookieMap, names: readonly string[]): CookieMap {
  const out: CookieMap = {};
  for (const name of names) {
    const value = cookies[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
