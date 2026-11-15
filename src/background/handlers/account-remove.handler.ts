/**
 * 退出播放账号。
 *
 * 一次清六样，缺一样都会留下误导：
 *
 * | 清什么 | 不清的后果 |
 * | --- | --- |
 * | 凭据（vault） | 还能继续代理，用户以为退出了 |
 * | DNR 规则（**`clearAllRules`**，不是 `disableProxy`） | 规则还带着已经没主的 Cookie 注入请求 |
 * | 健康记录 | 下次打开显示"上次失效"，用户以为是新问题 |
 * | 摘要缓存 | 下次显示上一个账号的头像和昵称 |
 * | 统计 | 失败曲线留在那里，看起来像"新账号也不行" |
 * | 主账号显示档案（ADR 0025） | 非播放页 popup 还会显示"上一个用这台机器的人"的昵称 |
 *
 * 最后一条看起来不属于"播放账号"，但用户点「退出」的心理预期是
 * "这个扩展我不用了"。此时还留着他的主账号昵称，既说不通也解释不清
 * —— 尤其在家用共用电脑上，那不是体验问题，是泄露。
 *
 * ## ⚠️ 为什么是 `clearAllRules()` 而不是 `disableProxy()`（2026-11-12，task-10）
 *
 * 用户裁决（原话）：
 * > 「可以保留这个开关原本的状态，但是因为退出了扩展账号所以这个开关即便是
 * > 开着也是没有用了，所以整个开关应变为灰色不可点击」
 *
 * `disableProxy()` 会**连带把总开关写成 `false`** —— 那等于"退出一次账号，
 * 用户设的开关状态被永久改掉"。而退出账号**不是用户的开关操作**。
 *
 * `clearAllRules()` 只清三类规则、**一个字都不写 `ENABLED_KEY`**，
 * 于是：开关保持用户设的状态，界面侧再把它显示成灰的（无账号 → 无效）。
 *
 * ## ⚠️ 安全底线：规则**必须**真的清干净
 *
 * 只删掉 `disableProxy()` 调用而忘了清规则 = 带着**已删除账号的 Cookie**
 * 继续对 B站发请求。所以 `clearAllRules()` 清的是**三段**：
 * 10000（路径）/ **11000（推荐流）** / 20000（标签页）。
 * 其中 11000 段不会被 `removeAllPathRules()` 覆盖 —— 见 `dnr.ts` 的注释。
 */

import { clearAllRules } from '@platform/http/dnr';
import { removeCredential } from '@platform/storage/credential-store';
import { clearHealth } from '@platform/storage/health-store';
import { clearPrimaryProfile } from '@platform/storage/primary-profile-store';
import { clearStats } from '@platform/storage/stats-store';
import type { ResponseMsg } from '@shared/types/messages';

import { clearCachedSummary } from './account.handler';

export async function handleAccountRemove(): Promise<ResponseMsg> {
  try {
    // 先清规则再删凭据：反过来会有极短的一瞬"规则在、凭据没了"
    //
    // ⚠️ 顺序不能反（2026-11-12，task-10）：`clearAllRules()` 必须早于
    // `removeCredential()`，否则任何时刻都可能出现"规则已删但凭据还在"的可用态，
    // 或者更糟 —— "凭据已删但规则还在"（那才是真正危险的中间态）。
    await clearAllRules();
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
