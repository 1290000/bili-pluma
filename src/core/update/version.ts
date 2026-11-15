/**
 * 版本号比较 —— **纯函数，没有任何 IO**。
 *
 * ## 为什么不能直接用字符串比较
 *
 * `'1.10.0' > '1.9.9'` 在字符串比较下是 `false`（`'10' < '9'`，逐字符）。
 * 这个坑在自动更新里是致命的：新版本会被判成"更旧"，于是**永远不提示更新**，
 * 而且不会有任何报错。
 *
 * ## 支持哪几种写法
 *
 * - `v1.2.3` / `1.2.3` —— git tag 带 `v`，`manifest.version` 不带
 * - `1.2.3.4` —— Chrome 的 `manifest.version` 允许 1–4 段数字，缺的段按 0 补齐
 * - `1.2.3-beta.1` —— 预发布后缀。**同号之下预发布比正式版旧**（semver 惯例）
 *
 * 本项目**不消费预发布**（只读 `releases/latest`），但比较函数必须能处理它 ——
 * 否则用户装了 beta 包之后会被判成"已是最新"。
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 第 4 段（Chrome manifest 允许），没有就是 0 */
  build: number;
  /** 预发布标识；`null` 表示正式版 */
  prerelease: string | null;
}

const VERSION_RE =
  /^[vV]?(\d{1,5})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?(?:-([0-9A-Za-z.-]+))?$/;

/**
 * 解析版本号。**解析不了就返回 `null`，不猜**。
 *
 * 每段上限 65535 是 Chrome 的硬限制（`manifest.version` 超了直接装不上），
 * 这里顺手拦掉，免得把 `20261026` 这种日期方案放进比较逻辑。
 */
export function parseVersion(input: string): ParsedVersion | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;

  const nums = [m[1], m[2] ?? '0', m[3] ?? '0', m[4] ?? '0'].map((s) => Number(s));
  if (nums.some((n) => !Number.isFinite(n) || n > 65535)) return null;

  return {
    major: nums[0] as number,
    minor: nums[1] as number,
    patch: nums[2] as number,
    build: nums[3] as number,
    prerelease: m[5] ?? null,
  };
}

/** 只比较数字段。预发布部分在 `compareVersions` 里单独处理。 */
function compareNumbers(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch', 'build'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

/**
 * 比较两个版本：`a` 比 `b` 新返回 `1`，相同 `0`，更旧 `-1`。
 *
 * ⚠️ **解析失败直接抛错**，不返回 0。返回 0 会让"版本号写错了"伪装成"已是最新"，
 * 那是自动更新里最难查的一类 bug。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) throw new Error(`无法解析版本号：${JSON.stringify(a)}`);
  if (!pb) throw new Error(`无法解析版本号：${JSON.stringify(b)}`);

  const byNumber = compareNumbers(pa, pb);
  if (byNumber !== 0) return byNumber;

  // 数字部分相同：正式版 > 预发布；两个都是预发布时按字典序（够用，不做 semver 的段比较）
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  if (pa.prerelease === pb.prerelease) return 0;
  return pa.prerelease > pb.prerelease ? 1 : -1;
}

/**
 * `candidate` 是否比 `current` 新。更新提示的唯一判据。
 *
 * 相等返回 `false` —— "同版本"不是"有更新"，否则每次检查都会冒出一个红点。
 */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
