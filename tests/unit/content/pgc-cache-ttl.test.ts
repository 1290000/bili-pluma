/**
 * PGC 缓存 TTL 常量对账（O7，2026-10-30）
 *
 * ## 为什么需要这条断言
 *
 * PGC 有**两份缓存**，各自一个 TTL 常量，值必须一致：
 *
 * | 常量 | 位置 | 用途 |
 * | --- | --- | --- |
 * | `PGC_CACHE_TTL_MS` | `src/platform/storage/pgc-cache-store.ts` | `chrome.storage` 缓存（异步那份） |
 * | `PGC_SS_TTL_MS` | `src/content/isolated/pgc-cache-inject.ts` | `sessionStorage` 同步缓存（主世界读的那份） |
 *
 * 它们的注释都写着"与对方保持一致"，但**没有任何脚本在检查这件事**。
 *
 * ## 不一致的后果
 *
 * 两份缓存存的是同一个流地址。若 `PGC_SS_TTL_MS` 明显长于 `PGC_CACHE_TTL_MS`：
 *   - 同步缓存（主世界注入用）会比异步缓存多活很久
 *   - 流地址实测约 110 分钟失效，超期注入 = 播放器拿到死链
 *   - 表现为「重开页面画质不恢复」或「转圈」，而日志里看不出原因
 *
 * 反过来（同步那份更短）则只是少了一次注入机会，影响较小但仍属漂移。
 *
 * ## 为什么用正则读源码而不是 import
 *
 * 两个常量分别在 `platform/` 和 `content/`，`tests/` 直接 import 没有问题 ——
 * 但这样只能验证"值相等"，**验不了"这个值本身是不是 100 分钟"**。
 * 两处一起被改成别的值同样能通过。所以这里额外锁死字面量。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PGC_SS_TTL_MS } from '@/src/content/isolated/pgc-cache-inject';
import { PGC_CACHE_TTL_MS } from '@platform/storage/pgc-cache-store';

describe('PGC 缓存 TTL 对账（O7）', () => {
  it('两个 TTL 常量值相等', () => {
    expect(PGC_SS_TTL_MS).toBe(PGC_CACHE_TTL_MS);
  });

  it('TTL 锁死为 100 分钟（防两处一起被改）', () => {
    expect(PGC_SS_TTL_MS).toBe(100 * 60 * 1000);
    expect(PGC_CACHE_TTL_MS).toBe(100 * 60 * 1000);
  });

  it('同步缓存的写入侧确实带 exp（主世界读取时靠它判断过期）', () => {
    /**
     * `main-world.js` 的 `pgcReadCacheSync` 里有一句：
     *   `if (typeof o.exp === 'number' && Date.now() > o.exp) return null;`
     *
     * 也就是说 **TTL 不是靠常量比对的，是靠写入时算好的 `exp` 字段**。
     * 如果写入侧哪天漏了 `exp`，主世界那句判断会**静默跳过**（`typeof o.exp !== 'number'`），
     * 缓存永不失效 —— 这比 TTL 不一致更难发现。
     */
    const source = readFileSync(
      resolve(process.cwd(), 'src/content/isolated/pgc-cache-inject.ts'),
      'utf8',
    );
    expect(source).toMatch(/exp:\s*Date\.now\(\)\s*\+\s*PGC_SS_TTL_MS/);
  });

  it('主世界读取侧确实校验 exp（否则写入的 exp 无意义）', () => {
    const mainWorld = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');
    expect(mainWorld).toMatch(/typeof o\.exp === 'number' && Date\.now\(\) > o\.exp/);
  });
});
