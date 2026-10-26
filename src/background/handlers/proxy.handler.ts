/**
 * 总开关处理 —— ADR 0006 的硬性配套之一。
 *
 * 为什么必须有：常驻规则意味着播放账号凭据一旦失效，**所有白名单路径会一起变未登录**。
 * 没有开关，用户只能卸载扩展才能恢复，而且会以为 B站坏了。
 *
 * ## 归属
 *
 * - `handleProxyStatus`：popup 打开时读一次
 * - `handleProxySet`：popup 的开关调它
 *
 * ## 设计要点：把"关着"的原因分开
 *
 * `enabled: false` 可能是三种完全不同的情况，UI 必须区别对待：
 *
 * | 情况 | UI 应该说什么 |
 * | --- | --- |
 * | `hasCredential: false` | 还没配置 → 主按钮是「扫码登录」 |
 * | `enabled: false` + 有凭据 | 用户主动关的 → 主按钮是「重新开启」 |
 * | `enabled: true` + `ruleCount: 0` | **不一致状态**，说明规则被清了（如浏览器重启后自愈失败） |
 *
 * 第三种最危险：用户以为在代理，实际一条规则都没有。所以 `ruleCount` 必须回传给 UI，
 * 不能只报 `enabled`。
 */

import { describeRules, disableProxy, enableProxy, isProxyEnabled } from '@platform/http/dnr';
import { diag } from '@platform/storage/diag-store';

/**
 * `ruleCount` 的"未知"哨兵值。
 *
 * 用 -1 而不是 0：0 表示"确认没有规则"，那是真实的不一致状态；
 * -1 表示"读不到"，UI 必须区别对待，否则会把读失败误报成不一致。
 */
export const RULE_COUNT_UNKNOWN = -1;
import { readPersistedCredential } from '@platform/storage/credential-store';
import { serializeCookie } from '@shared/utils/cookie';
import type { ResponseMsg } from '@shared/types/messages';

export async function handleProxyStatus(): Promise<ResponseMsg> {
  /**
   * ## 这里曾有一个"静默降级"的 bug
   *
   * 旧实现把所有取值包在一个 try 里，任何一处抛异常就返回
   * `{ enabled: false, hasCredential: false, ruleCount: 0 }`。
   *
   * 结果诊断页显示「已开启（0 条路径规则，⚠️ 不一致）」——
   * 而同一时刻诊断页自己调 `getSessionRules()` 能看到 2 条规则。
   * 两处数字对不上，用户和开发者都无从判断哪个是真的。
   *
   * 现在**每项独立降级**：某一项失败只影响那一项，不会把整份状态抹平。
   * 失败项用安全默认值 + 记诊断，绝不静默变成"什么都没配置"。
   */
  let enabled = false;
  let hasCredential = false;
  let ruleCount = 0;

  try {
    enabled = await isProxyEnabled();
  } catch {
    // 读不到开关状态时按"关"处理：宁可少代理，不可错代理
  }

  try {
    hasCredential = (await readPersistedCredential()) !== null;
  } catch {
    // 解密失败 ≠ 没配置。但这里拿不到密文是否存在的证据，
    // 只能保守报 false；「凭据失效」态会由 account/summary 那条路径覆盖
  }

  try {
    const rules = await describeRules();
    // 只数**全局路径规则**（10000 段）。
    // 标签页规则随页面开关，不能当作"总开关是否生效"的证据。
    ruleCount = rules.filter((r) => r.kind === 'path').length;
  } catch (e) {
    /**
     * ⚠️ 关键：拿不到规则列表时**不要把 ruleCount 报成 0**。
     * 0 在 UI 里意味着"开关开着却没规则 = 不一致"，会触发误报警。
     * 拿不到就是"不知道"，用 -1 表示，UI 会跳过一致性检查。
     */
    ruleCount = RULE_COUNT_UNKNOWN;
    void diag('proxy/status', `读取规则失败: ${e instanceof Error ? e.name : 'unknown'}`);
  }

  return { type: 'proxy/status:ok', enabled, hasCredential, ruleCount };
}

export async function handleProxySet(enabled: boolean): Promise<ResponseMsg> {
  try {
    if (!enabled) {
      await disableProxy();
      return { type: 'proxy/set:ok', enabled: false };
    }

    // 开启需要凭据。没有就明确报错，不要假装成功
    const credential = await readPersistedCredential();
    if (!credential) {
      return { type: 'proxy/set:err', detail: '还没有配置播放账号' };
    }

    const cookie = serializeCookie({
      SESSDATA: credential.sessdata,
      bili_jct: credential.biliJct,
      DedeUserID: credential.dedeUserId,
    });

    // enableProxy 在"白名单无启用项"时会抛错，不会留下"开关 true、规则 0 条"的状态。
    // 错误信息已经是给人看的（不含技术细节），直接透出
    await enableProxy(cookie);
    return { type: 'proxy/set:ok', enabled: true };
  } catch (e) {
    return {
      type: 'proxy/set:err',
      detail: e instanceof Error ? e.message.slice(0, 80) : '未知错误',
    };
  }
}
