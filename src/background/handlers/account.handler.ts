/**
 * 账号摘要与凭据健康 —— popup 的唯一数据源。
 *
 * ## 惰性检查，不做定时任务
 *
 * 见 `docs/04-project-structure.md` §6「凭据健康检查：惰性，不用 alarms」。
 *
 * 为什么不能定时：`incognito: "split"` 下普通/无痕是两个独立 SW 实例，
 * 共享 `storage.local`。定时任务跑在哪个实例不确定，两个实例会互相覆盖健康标记。
 *
 * 所以只在**要展示时**问一句"该不该重查"：
 *   - popup 打开 → `account/summary`（`recheck` 省略 → 后端按新鲜度判断）
 *   - 用户点"重新检查" → `recheck: true`
 *
 * ## 凭据纪律
 *
 * 凭据只在函数栈里流转。返回给 UI 的是 `AccountSummary`，该类型**没有**
 * sessdata / biliJct 字段，从类型层面就漏不出去。
 */

import { applyVerdict, needsRecheck } from '@core/auth/health';
import { checkCredential } from '@platform/http/nav';
import { readPersistedCredential } from '@platform/storage/credential-store';
import { readHealth, writeHealth } from '@platform/storage/health-store';
import type { AccountSummary } from '@shared/types/account';
import type { ResponseMsg } from '@shared/types/messages';

/**
 * 读账号摘要。
 *
 * @param recheck 是否强制重新探测。省略/false 时按 `HEALTH_TTL_MS` 惰性判断
 */
export async function handleAccountSummary(recheck = false): Promise<ResponseMsg> {
  try {
    const credential = await readPersistedCredential();
    if (!credential) {
      // 未配置：不探测、不报警。这是"还没开始用"，不是"出错了"
      return { type: 'account/summary:ok', configured: false, account: null, needsRecheck: false };
    }

    const now = Date.now();
    const record = await readHealth();

    // 记录新鲜且没被判失效 → 不需要探测。
    // 但此时拿不到 uname/mid（健康记录只存健康，不存资料），
    // 所以摘要给一个"只有 health、profile 待补"的形态是不行的——
    // AccountSummary.profile 是必填。
    //
    // 因此：即使新鲜，也要探测一次补资料。这是 popup 的核心内容，不能省。
    // 真正的成本控制在别处：popup 只在用户点开时调这个 handler，
    // 且 result 会被 health 记录挡在 6 小时窗口内（见下面 skip 分支）。
    const fresh = !needsRecheck(record, now);
    if (fresh && recheck === false) {
      const cached = await readCachedSummary();
      if (cached) {
        return {
          type: 'account/summary:ok',
          configured: true,
          account: cached,
          needsRecheck: false,
        };
      }
    }

    const verdict = await checkCredential(credential, now);
    const next = applyVerdict(record, verdict, now);
    await writeHealth(next);

    if (verdict.kind === 'healthy' || verdict.kind === 'not-vip') {
      const summary: AccountSummary = {
        ...verdict.summary,
        health: { healthy: true, checkedAt: next.checkedAt, reason: null },
      };
      await writeCachedSummary(summary);
      return {
        type: 'account/summary:ok',
        configured: true,
        account: summary,
        needsRecheck: false,
      };
    }

    /**
     * ## `unknown`（探测不确定）不能当成"失效"
     *
     * 踩过的坑：探活要发 `nav` 请求，可能因为分区不对 / 网络 / 风控拿不到结果。
     * 这种情况下如果返回 `account: null`，popup 会显示
     * **"凭据失效"——而实际画质正常播到 2160p**。
     *
     * 所以分两种情况：
     *   - `unknown`：**不污染健康状态**，把缓存资料原样给出（没有就 null），
     *     让 UI 靠 "DNR 规则在不在" 自己判断该不该报警
     *   - `expired`（明确 -101）：才算真的失效
     */
    if (verdict.kind === 'unknown') {
      const cached = await readCachedSummary();
      return {
        type: 'account/summary:ok',
        configured: true,
        // 有缓存就继续用它（资料是上次成功时的，不会因为这次探测失败变旧）
        account: cached,
        // 不要求 popup 反复重试——重试也大概率还是 unknown
        needsRecheck: false,
      };
    }

    // 失效：把上一次成功探测到的资料仍给 UI——
    // popup 需要显示"是哪个号失效了"
    const cached = await readCachedSummary();
    if (cached) {
      return {
        type: 'account/summary:ok',
        configured: true,
        account: {
          ...cached,
          health: { healthy: false, checkedAt: next.checkedAt, reason: next.reason },
        },
        needsRecheck: next.expired,
      };
    }

    // 有凭据但探测不出资料（从未成功过 + 缓存也没了）。
    // `configured: true` 是关键：UI 要显示"凭据可能失效"，而不是"未配置"。
    return { type: 'account/summary:ok', configured: true, account: null, needsRecheck: true };
  } catch (e) {
    return {
      type: 'account/summary:err',
      code: 'UNKNOWN',
      detail: e instanceof Error ? e.name : null,
    };
  }
}

// ── 摘要缓存 ──
//
// 为什么单独存：`HealthRecord` 只记"凭据行不行"，不该混进 uname/mid 这类资料。
// 混进去会让"清除健康记录"把账号资料一起抹掉。

const SUMMARY_KEY = 'pluma:account-summary';

async function readCachedSummary(): Promise<AccountSummary | null> {
  try {
    const bag = await chrome.storage.local.get(SUMMARY_KEY);
    const v = bag[SUMMARY_KEY] as AccountSummary | undefined;
    if (!v || typeof v !== 'object') return null;
    if (!v.profile || typeof v.profile.mid !== 'number') return null;
    return v;
  } catch {
    return null;
  }
}

async function writeCachedSummary(summary: AccountSummary): Promise<void> {
  await chrome.storage.local.set({ [SUMMARY_KEY]: summary }).catch(() => {});
}

/** 退出账号时清掉，避免下次显示上一个号 */
export async function clearCachedSummary(): Promise<void> {
  await chrome.storage.local.remove(SUMMARY_KEY).catch(() => {});
}
