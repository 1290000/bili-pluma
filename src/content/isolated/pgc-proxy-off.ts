/**
 * 总开关「关」的本地落地 —— ADR 0028 的三层里有两层住在这里。
 *
 * ## 为什么这些函数不在 `entrypoints/content.ts` 里
 *
 * `entrypoints/content.ts` 是 WXT 入口，**没有任何单测能 import 它**
 * （它调 `defineContentScript()`，副作用在 import 时就发生）。
 * 而"清哪几个 key、什么时候清"恰恰是最容易改错、最需要守卫的部分 ——
 * 放在入口文件里等于完全没有测试。
 *
 * 所以纯逻辑（遍历、前缀匹配、删哪些）抽到这里，入口只留一行调用。
 *
 * ## 三层里各层的归属
 *
 * | 层 | 做什么 | 住在哪 |
 * | --- | --- | --- |
 * | ① 门控 | 写 `/` 删 `localStorage` 标记 | 本文件 `writeProxyOffMark()` |
 * | ① 门控 | **读**标记（在 `__playinfo__` setter 里同步读） | `src/content/main-world.js` |
 * | ② 清理 | 清 `sessionStorage` 的注入缓存 | 本文件 `clearPgcSessionCache()` |
 * | ③ 恢复 | 重开开关时清刷新护栏 | 本文件 `clearPgcReloadGuards()` |
 *
 * ⚠️ 读取必须在主世界：它要在 `__playinfo__` 的 setter 里**同步**执行，
 * 只有主世界能碰那个 setter。写入在 ISOLATED 侧是因为 `chrome.storage.onChanged`
 * 只有扩展侧能监听。
 */

import { PGC_SS_PREFIX } from './pgc-cache-inject';
import { GUARD_KEY_PREFIX } from './pgc-reload-plan';

/**
 * 总开关「关着」的标记键 —— **必须与 `src/content/main-world.js` 的
 * `PROXY_OFF_KEY` 字符串一致**。
 *
 * 主世界是裸 JS（不参与 TS 编译），无法 import，所以两处各写一份。
 * 不一致的后果是**门控静默失效**（读的是不存在的键 → 永远判不出来 → 永远放行
 * → 退回原 bug），而且**没有任何报错**。
 *
 * 一致性由 `tests/unit/content/main-world-pgc.test.ts` 直接读两边源码断言。
 */
export const PROXY_OFF_KEY = 'pluma:proxy-off';

/**
 * 标记的时间上界：30 分钟。**必须与 `main-world.js` 的 `PROXY_OFF_TTL_MS` 一致**。
 *
 * 标记记的是"写入那一刻"的状态，不是"读的那一刻"。某次写入失败
 * （配额满 / 隐私模式 / SW 没醒）会留下一个旧标记，若永久有效就等于
 * **永久拦住注入** —— PGC 功能静默消失。给上界把"最多错多久"变成可陈述的数字。
 */
export const PROXY_OFF_TTL_MS = 30 * 60 * 1000;

/**
 * 写 / 删「总开关关着」的本地标记。
 *
 * | `off` | 动作 | 场景 |
 * | --- | --- | --- |
 * | `true` | 写入 `{"at": <now>}` | 用户关了总开关 |
 * | `false` | 删除标记 | 用户开了总开关 |
 *
 * ## 为什么放 `localStorage` 而不是 `sessionStorage`
 *
 * ADR 0028 第一层的三个性质缺一不可：
 *   - **同步 API** —— 主世界在 setter 里读，只有微秒级预算
 *   - **跨标签页共享** —— 一处写，所有已开的番剧标签页全部生效（补掉洞 3）
 *   - **不依赖扩展消息** —— `cfg` 永远不到也照样能判
 *
 * `sessionStorage` 按标签页隔离，做不到第二条。
 *
 * @param off `true` = 开关关着；`false` = 开关开着
 * @returns 是否写成功（失败不影响调用方流程，仅供测试与排查）
 */
export function writeProxyOffMark(off: boolean): boolean {
  try {
    if (off) {
      localStorage.setItem(PROXY_OFF_KEY, JSON.stringify({ at: Date.now() }));
    } else {
      localStorage.removeItem(PROXY_OFF_KEY);
    }
    return true;
  } catch {
    /* 页面禁用 localStorage：门控退化为"放行"，是 ADR 明确接受的代价 */
    return false;
  }
}

/**
 * 收集 `sessionStorage` 里所有以 `prefix` 开头的键。
 *
 * ## 为什么要先收集再删
 *
 * `sessionStorage` 的长度与索引在删除时会实时变化，边遍历边删会让索引错位，
 * 结果是"删一条、跳一条"。先收集快照再删是唯一可靠写法。
 *
 * ⚠️ **永不抛错**：隐私模式 / 配额满 / 跨源 iframe 里 `sessionStorage`
 * 可能连 `length` 都读不了。
 *
 * @param prefix 键前缀
 * @returns 匹配到的键名（顺序为遍历顺序）
 */
export function collectKeysWithPrefix(prefix: string): string[] {
  const found: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (k !== null && k.startsWith(prefix)) found.push(k);
    }
  } catch {
    return [];
  }
  return found;
}

/**
 * 清掉本标签页 `sessionStorage` 里的 PGC 注入缓存（ADR 0028 第二层）。
 *
 * ## ⚠️ 它**不承担门控职责**
 *
 * 门控是主世界那道 `localStorage` 读取（第一层）。这里只做两件小事：
 *   1. **数据卫生**：开关关着时，页面里躺着一份 4K 流地址没有意义
 *   2. **双保险**：如果 `localStorage` 被外部工具清掉，缓存也没了
 *
 * 单靠它**修不好**用户报的 bug：清缓存的时机（`page/activate` 回包 ~400ms）
 * 必然晚于注入（实测 358ms）。那只是把竞争从"读缓存"挪到"删缓存"，
 * 同一个赛跑换个赛道 —— 见 ADR 0028 的「洞 1」。
 *
 * ## 只清 `pluma:pgc-vi:`（ADR 0028「边界」一节）
 *
 * | key | 清？ | 理由 |
 * | --- | --- | --- |
 * | `pluma:pgc-vi:<cid>` | **清** | 唯一影响注入的数据源 |
 * | `pluma:pgc-ep:<epId>` | **不清** | `ep_id → cid` 映射，与"能不能注入"无关 |
 * | `pluma:pgc-reload:<cid>` | **不清** | 防刷新循环护栏。关闭时清掉会削弱护栏 |
 * | `pluma:pgc-resume:<cid>` | **不清** | 播放位置记忆，与画质无关 |
 *
 * ⚠️ **按前缀清，不是按当前 cid 单点清**：一个 SPA 会话里可能攒了多集
 * （`tryUpgradeForQuality` 每集都会写一份）。只清当前集会留下一堆
 * "开关开着时攒的 4K"，用户重开开关后仍会命中过期的那一集。
 *
 * @returns 实际删掉了几条（0 = 本来就没有）
 */
export function clearPgcSessionCache(): number {
  const doomed = collectKeysWithPrefix(PGC_SS_PREFIX);
  let removed = 0;
  for (const k of doomed) {
    try {
      sessionStorage.removeItem(k);
      removed += 1;
    } catch {
      /* 单条删失败就跳过，继续删剩下的 */
    }
  }
  return removed;
}

/**
 * 清掉本标签页所有 `pluma:pgc-reload:` 刷新护栏（ADR 0028 第三层，补洞 2）。
 *
 * ## 为什么要补这个洞
 *
 * `pgc-reload:<cid>` 记的是「本会话已为这一集刷过一次」（10 分钟 TTL）。
 * 只清缓存、不清护栏就会出现：
 *
 * ```
 * 关开关 → 清 vi，留 guard
 * 重开开关 → 刷新 → 无缓存，该取流了
 *          → isAlreadyTried(guard) === true → 直接 return
 *          → 不取流、不刷新、无提示 → 停在试看，最长 10 分钟
 * ```
 *
 * 这是同一类 bug 的**反面**：开关的动作在另一个方向不生效。
 *
 * ## 为什么只在「重开」这一个瞬间清
 *
 * 不能在每次页面加载时清 —— 那会废掉 `alreadyTried` 的**防刷新循环**本意
 * （`pgc-reload-plan.ts` 的三条硬护栏之一）。只有"用户把开关从 false 拨到 true"
 * 这个一次性事件才清。
 *
 * @returns 实际删掉了几条
 */
export function clearPgcReloadGuards(): number {
  const doomed = collectKeysWithPrefix(GUARD_KEY_PREFIX);
  let removed = 0;
  for (const k of doomed) {
    try {
      sessionStorage.removeItem(k);
      removed += 1;
    } catch {
      /* 同上 */
    }
  }
  return removed;
}

/**
 * 这次 `storage.onChanged` 的变化是不是「总开关从关变开」。
 *
 * ## 为什么必须单独判，不能无条件清护栏
 *
 * `chrome.storage.onChanged` 会在**任何**存储变化时触发。若每次触发都清护栏，
 * `alreadyTried` 就永远为 false → 取流失败的页面会**无限刷新**。
 * 那是比原 bug 严重得多的故障。
 *
 * ## 为什么用严格比较 `=== false` / `=== true`
 *
 * - `oldValue` 在"键从未存在过"时是 `undefined` —— 那不是重开
 *   （用户从没开过，或存储被整个清过），不该清护栏
 * - 字符串 `"false"` / 数字 `1` 一律不算，与 `set-proxy` 通道的严格布尔口径一致
 *
 * @param oldValue `storage.local` 里该键的旧值
 * @param newValue 新值
 * @returns `true` 表示"刚刚从关闭拨到开启"
 */
export function isProxyReenabled(oldValue: unknown, newValue: unknown): boolean {
  return oldValue === false && newValue === true;
}
