/**
 * 退出播放账号。
 *
 * 一次清六样，缺一样都会留下误导：
 *
 * | 清什么 | 不清的后果 |
 * | --- | --- |
 * | 凭据（vault） | 还能继续代理，用户以为退出了 |
 * | DNR 规则（disableProxy） | 规则还带着已经没主的 Cookie 注入请求 |
 * | 健康记录 | 下次打开显示"上次失效"，用户以为是新问题 |
 * | 摘要缓存 | 下次显示上一个账号的头像和昵称 |
 * | 统计 | 失败曲线留在那里，看起来像"新账号也不行" |
 * | 主账号显示档案（ADR 0025） | 非播放页 popup 还会显示"上一个用这台机器的人"的昵称 |
 *
 * 最后一条看起来不属于"播放账号"，但用户点「退出」的心理预期是
 * "这个扩展我不用了"。此时还留着他的主账号昵称，既说不通也解释不清
 * —— 尤其在家用共用电脑上，那不是体验问题，是泄露。
 */

import { disableProxy } from '@platform/http/dnr';
import { removeCredential } from '@platform/storage/credential-store';
import { clearHealth } from '@platform/storage/health-store';
import { clearPrimaryProfile } from '@platform/storage/primary-profile-store';
import { clearStats } from '@platform/storage/stats-store';
import type { ResponseMsg } from '@shared/types/messages';

import { clearCachedSummary } from './account.handler';

export async function handleAccountRemove(): Promise<ResponseMsg> {
  try {
    // 先关代理再删凭据：反过来会有极短的一瞬"规则在、凭据没了"
    await disableProxy();
    await removeCredential();
    await clearHealth();
    await clearStats();
    await clearCachedSummary();
    await clearPrimaryProfile();

    return { type: 'account/remove:ok' };
  } catch (e) {
    return {
      type: 'account/remove:err',
      detail: e instanceof Error ? e.message.slice(0, 80) : '未知错误',
    };
  }
}
