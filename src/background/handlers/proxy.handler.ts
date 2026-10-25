/**
 * 总开关处理 —— ADR 0006 的硬性配套之一。
 *
 * 为什么必须有：常驻规则意味着播放账号凭据一旦失效，**所有白名单路径会一起变未登录**。
 * 没有开关，用户只能卸载扩展才能恢复，而且会以为 B站坏了。
 *
 * ## 归属
 *
 * - `handleProxyStatus`：**已有调用方**（自检页只读显示）
 * - `handleProxySet`：**P2 的 popup 才是它的 UI**。当前没有产品界面调用它，
 *   但能力必须在 P1 就位 —— P2 做 popup 时直接接上，不用回头改架构。
 *
 * 不要因为"没人调用"就删掉 `handleProxySet`：它是总开关的另一半，
 * 只有 `disableProxy()` 而没有切换到开启的入口，等于开关只能关不能开。
 */

import { describeRules, disableProxy, enableProxy, isProxyEnabled } from '@platform/http/dnr';
import { readPersistedCredential } from '@platform/storage/credential-store';
import { serializeCookie } from '@shared/utils/cookie';
import type { ResponseMsg } from '@shared/types/messages';

export async function handleProxyStatus(): Promise<ResponseMsg> {
  try {
    const [enabled, rules, credential] = await Promise.all([
      isProxyEnabled(),
      describeRules(),
      readPersistedCredential().catch(() => null),
    ]);

    return {
      type: 'proxy/status:ok',
      enabled,
      hasCredential: credential !== null,
      ruleCount: rules.length,
    };
  } catch {
    return { type: 'proxy/status:ok', enabled: false, hasCredential: false, ruleCount: 0 };
  }
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

    await enableProxy(cookie);
    return { type: 'proxy/set:ok', enabled: true };
  } catch (e) {
    return {
      type: 'proxy/set:err',
      detail: e instanceof Error ? e.message.slice(0, 80) : '未知错误',
    };
  }
}
