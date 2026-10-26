/**
 * 凭据健康记录的持久化 —— `chrome.storage.local`。
 *
 * 存在 `local` 而不是 `session`：健康状态要跨 SW 重启保留，
 * 否则每次 SW 冷启动都当成"从未校验"，popup 一打开就发 nav 请求。
 *
 * ⚠️ `storage.local` 在 `incognito: "split"` 下是**跨分区共享**的。
 * 这是有意的：健康状态描述的是"播放账号凭据还行不行"，与在哪个分区读到无关。
 */

import type { HealthRecord } from '@core/auth/health';
import { INITIAL_HEALTH } from '@core/auth/health';

const HEALTH_KEY = 'pluma:health';

/** 读取健康记录。没有或格式不对时返回初始值（不抛错） */
export async function readHealth(): Promise<HealthRecord> {
  try {
    const bag = await chrome.storage.local.get(HEALTH_KEY);
    const raw = bag[HEALTH_KEY] as Partial<HealthRecord> | undefined;
    if (!raw || typeof raw !== 'object') return { ...INITIAL_HEALTH };

    return {
      expired: raw.expired === true,
      checkedAt: typeof raw.checkedAt === 'number' ? raw.checkedAt : 0,
      consecutiveFailures:
        typeof raw.consecutiveFailures === 'number' ? raw.consecutiveFailures : 0,
      reason: typeof raw.reason === 'string' ? raw.reason : null,
    };
  } catch {
    return { ...INITIAL_HEALTH };
  }
}

/** 写入健康记录 */
export async function writeHealth(record: HealthRecord): Promise<void> {
  await chrome.storage.local.set({ [HEALTH_KEY]: record });
}

/** 清除（退出播放账号时调用，避免残留"上次失效"误导用户） */
export async function clearHealth(): Promise<void> {
  await chrome.storage.local.remove(HEALTH_KEY).catch(() => {});
}
