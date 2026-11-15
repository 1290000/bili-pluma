/**
 * 自动更新相关的常量 —— **唯一真相源**。
 *
 * 这里的每个值都直接决定"能不能连上、能不能写进去"，改之前先读
 * `docs/plans/2026-11-15-auto-update-plan.md`。
 */

/**
 * 仓库坐标。运行时**不能**从 git remote 读（扩展里没有 git），只能硬编码。
 * 改仓库时要同步 `package.json` 的 `repository`（若有）与 README 的链接。
 *
 * ⚠️ 下面这行带 `secrets-ok` 标记：`check-secrets.mjs` 把仓库 owner 那串数字
 * 误判成 B 站主账号 mid。它是**公开的 GitHub 用户名**（写在 README 与 remote 里），
 * 与账号凭据无关。标记必须留在同一行 —— 注释一折行豁免就失效了。
 */
export const UPDATE_REPO_OWNER = '1290000'; // secrets-ok: GitHub owner，公开信息
export const UPDATE_REPO_NAME = 'bili-pluma';

/** GitHub REST：拿最新正式 Release（不含预发布、不含 draft）。 */
export const UPDATE_LATEST_API = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`;

/** 给人看的 Releases 页（「跳转 Releases」按钮用，与下载无关）。 */
export const UPDATE_RELEASES_PAGE = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases`;

/** 资产文件名前缀。完整名形如 `pluma-1.2.0.zip`，**不带** `-with-source`。 */
export const UPDATE_ASSET_PREFIX = 'pluma-';

/**
 * 自动检查间隔默认值（天）。
 *
 * `1` = 每天首次加载时检查一次，当天之后不再查。用户可在面板改。
 */
export const UPDATE_DEFAULT_INTERVAL_DAYS = 1;

/** 手动「检查更新」的冷却。防连点把 60/h 的未认证配额抽干。 */
export const UPDATE_MANUAL_COOLDOWN_MS = 60_000;

/**
 * 允许写进扩展目录的**顶层项**。
 *
 * ⚠️ 这份清单必须跟着 `entrypoints/` 与构建产物走：新增一个 HTML 入口就要加进来，
 * 否则那次更新会**明确失败**（这是故意的 —— 拒绝未知文件比静默写进去安全）。
 *
 * 目录项以 `/` 结尾，表示整棵子树都允许。
 */
export const UPDATE_ALLOWED_TOP_LEVEL: readonly string[] = [
  'manifest.json',
  'background.js',
  'popup.html',
  'login-window.html',
  'need-incognito.html',
  'content-scripts/',
  'chunks/',
  'assets/',
  'icon/',
  '安装说明.txt',
];

/** zip 里允许出现的**最大**单文件字节数。超出即判为异常包，直接拒绝。 */
export const UPDATE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/** 整个 zip 的体积上限。真实包约 283 KB，留足余量。 */
export const UPDATE_MAX_ZIP_BYTES = 24 * 1024 * 1024;
