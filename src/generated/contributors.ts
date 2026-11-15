/**
 * 生成物 —— **不要手改**。
 *
 * 由 scripts/gen-contributors.mjs 生成：按 contributions 降序、已过滤 Bot 账号、最多 12 位。
 * 为什么构建期生成而不是面板打开时拉：GitHub 未认证配额 60 次/小时且按 IP 共享，
 * 而这份名单不是实时数据。
 */

export interface Contributor {
  login: string;
  avatarUrl: string;
  htmlUrl: string;
  contributions: number;
}

export const CONTRIBUTORS_SOURCE = '1290000/bili-pluma'; // secrets-ok: GitHub 仓库坐标，公开信息

export const CONTRIBUTORS: readonly Contributor[] = [
  {
    login: '1290000', // secrets-ok: GitHub 用户名，公开信息
    avatarUrl: 'https://avatars.githubusercontent.com/u/223883074?v=4',
    htmlUrl: 'https://github.com/1290000', // secrets-ok: GitHub 用户名，公开信息
    contributions: 226,
  },
];
