// @vitest-environment jsdom

/**
 * ADR 0028 的第二层（清注入缓存）与第三层（重开时清刷新护栏）。
 *
 * ## 为什么这组测试必须存在
 *
 * 这两层的逻辑原先写在 `entrypoints/content.ts` 里 —— 那是 WXT 入口，
 * **没有任何单测能 import 它**（它调 `defineContentScript()`，import 即有副作用）。
 * 于是"清哪些 key、什么时候清"完全没有守卫，而它恰恰有两个**很容易踩的坑**：
 *
 *   1. 误清 `pgc-reload:` 护栏 → 取流失败时**无限刷新**
 *   2. 无条件清护栏 → 废掉 `alreadyTried` 的防循环本意，同样是无限刷新
 *
 * 所以逻辑抽到 `src/content/isolated/pgc-proxy-off.ts`，在这里钉死。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { PGC_SS_PREFIX } from '../../../src/content/isolated/pgc-cache-inject';
import {
  PROXY_OFF_KEY,
  PROXY_OFF_TTL_MS,
  clearPgcReloadGuards,
  clearPgcSessionCache,
  collectKeysWithPrefix,
  isProxyReenabled,
  writeProxyOffMark,
} from '../../../src/content/isolated/pgc-proxy-off';
import { GUARD_KEY_PREFIX, RESUME_KEY_PREFIX } from '../../../src/content/isolated/pgc-reload-plan';

/** 每个用例从干净的存储开始 —— jsdom 的 localStorage 在同一文件内是共享的 */
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('第一层：写 / 删 localStorage 标记', () => {
  it('off=true 写入带时间戳的 JSON', () => {
    const before = Date.now();
    expect(writeProxyOffMark(true)).toBe(true);

    const raw = localStorage.getItem(PROXY_OFF_KEY);
    expect(raw).not.toBeNull();
    const o = JSON.parse(raw as string) as { at: number };
    expect(typeof o.at).toBe('number');
    expect(o.at).toBeGreaterThanOrEqual(before);
    expect(o.at).toBeLessThanOrEqual(Date.now());
  });

  it('off=false 删除标记（重开开关后必须能恢复注入）', () => {
    writeProxyOffMark(true);
    expect(localStorage.getItem(PROXY_OFF_KEY)).not.toBeNull();

    expect(writeProxyOffMark(false)).toBe(true);
    expect(localStorage.getItem(PROXY_OFF_KEY)).toBeNull();
  });

  it('off=false 在标记本来就不存在时也不报错', () => {
    expect(localStorage.getItem(PROXY_OFF_KEY)).toBeNull();
    expect(writeProxyOffMark(false)).toBe(true);
    expect(localStorage.getItem(PROXY_OFF_KEY)).toBeNull();
  });

  it('localStorage.setItem 抛错时返回 false 而不是抛（隐私模式）', () => {
    /**
     * 反过来验证：如果不包 try/catch，这里会抛出去 → 调用点的
     * `page/activate` 回包流程会整个中断（画质上报、角标都要走那条路）。
     */
    const proto = Object.getPrototypeOf(localStorage) as {
      setItem: (k: string, v: string) => void;
    };
    const original = proto.setItem;
    proto.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(() => writeProxyOffMark(true)).not.toThrow();
      expect(writeProxyOffMark(true)).toBe(false);
    } finally {
      proto.setItem = original;
    }
  });
});

describe('collectKeysWithPrefix', () => {
  it('只返回带前缀的键，顺序稳定', () => {
    sessionStorage.setItem('pluma:pgc-vi:111', 'a');
    sessionStorage.setItem('other', 'b');
    sessionStorage.setItem('pluma:pgc-vi:222', 'c');

    const got = collectKeysWithPrefix('pluma:pgc-vi:');
    expect(got.sort()).toEqual(['pluma:pgc-vi:111', 'pluma:pgc-vi:222']);
  });

  it('没有匹配时返回空数组', () => {
    sessionStorage.setItem('other', 'x');
    expect(collectKeysWithPrefix('pluma:pgc-vi:')).toEqual([]);
  });

  it('空存储返回空数组（不抛）', () => {
    expect(collectKeysWithPrefix('pluma:pgc-vi:')).toEqual([]);
  });
});

describe('第二层：清注入缓存 —— 只清 pgc-vi', () => {
  /** 铺满四类 key，然后只清 vi，看另外三类是否幸存 */
  function seedAll(): void {
    sessionStorage.setItem(PGC_SS_PREFIX + '111', '{"vi":{},"exp":1}');
    sessionStorage.setItem(PGC_SS_PREFIX + '222', '{"vi":{},"exp":1}');
    sessionStorage.setItem('pluma:pgc-ep:9001', '111');
    sessionStorage.setItem(GUARD_KEY_PREFIX + '111', '{"attempts":1,"at":1}');
    sessionStorage.setItem(RESUME_KEY_PREFIX + '111', '42');
  }

  it('删掉所有 pgc-vi，返回删除条数', () => {
    seedAll();
    expect(clearPgcSessionCache()).toBe(2);
    expect(sessionStorage.getItem(PGC_SS_PREFIX + '111')).toBeNull();
    expect(sessionStorage.getItem(PGC_SS_PREFIX + '222')).toBeNull();
  });

  it('⚠️ 不清 pgc-ep（它与"能不能注入"无关）', () => {
    seedAll();
    clearPgcSessionCache();
    expect(sessionStorage.getItem('pluma:pgc-ep:9001')).toBe('111');
  });

  it('⚠️ 不清 pgc-reload 护栏（清了会削弱防刷新循环）', () => {
    seedAll();
    clearPgcSessionCache();
    expect(sessionStorage.getItem(GUARD_KEY_PREFIX + '111')).toBe('{"attempts":1,"at":1}');
  });

  it('⚠️ 不清 pgc-resume（播放位置与画质无关）', () => {
    seedAll();
    clearPgcSessionCache();
    expect(sessionStorage.getItem(RESUME_KEY_PREFIX + '111')).toBe('42');
  });

  it('按前缀清，不是只清当前 cid（SPA 一个会话会攒多集）', () => {
    /**
     * 只清当前集会留下一堆"开关开着时攒的 4K"，
     * 用户重开开关后仍会命中过期的那一集。
     */
    seedAll();
    const removed = clearPgcSessionCache();
    expect(removed).toBe(2);
    expect(collectKeysWithPrefix(PGC_SS_PREFIX + '2')).toEqual([]);
    expect(collectKeysWithPrefix(PGC_SS_PREFIX + '1')).toEqual([]);
  });

  it('本来就空 → 返回 0（不抛）', () => {
    expect(clearPgcSessionCache()).toBe(0);
  });
});

describe('第三层：重开开关时清刷新护栏', () => {
  it('删掉所有 pgc-reload，返回删除条数', () => {
    sessionStorage.setItem(GUARD_KEY_PREFIX + '111', '{"attempts":1,"at":1}');
    sessionStorage.setItem(GUARD_KEY_PREFIX + '222', '{"attempts":1,"at":1}');

    expect(clearPgcReloadGuards()).toBe(2);
    expect(collectKeysWithPrefix(GUARD_KEY_PREFIX)).toEqual([]);
  });

  it('⚠️ 不清 pgc-vi（清护栏不应该顺手把缓存删了）', () => {
    sessionStorage.setItem(PGC_SS_PREFIX + '111', '{"vi":{},"exp":1}');
    sessionStorage.setItem(GUARD_KEY_PREFIX + '111', '{"attempts":1,"at":1}');

    clearPgcReloadGuards();
    expect(sessionStorage.getItem(PGC_SS_PREFIX + '111')).toBe('{"vi":{},"exp":1}');
  });

  it('本来就空 → 返回 0（不抛）', () => {
    expect(clearPgcReloadGuards()).toBe(0);
  });
});

describe('isProxyReenabled：必须是「从关到开」这一个瞬间', () => {
  it('false → true 才算重开', () => {
    expect(isProxyReenabled(false, true)).toBe(true);
  });

  it('⚠️ true → true 不算（否则任何存储写入都会清护栏）', () => {
    expect(isProxyReenabled(true, true)).toBe(false);
  });

  it('⚠️ undefined → true 不算（键从未存在过 ≠ 重开）', () => {
    /**
     * 用户从没拨过开关、或 storage 被整个清过时，`oldValue` 是 `undefined`。
     * 把它当"重开"会在插件首次安装时清一次护栏 —— 目前无害但语义错误，
     * 而语义错误的条件早晚会被别处依赖。
     */
    expect(isProxyReenabled(undefined, true)).toBe(false);
  });

  it('⚠️ false → undefined 不算（键被删了，不是重开）', () => {
    expect(isProxyReenabled(false, undefined)).toBe(false);
  });

  it('⚠️ 严格布尔：字符串 "false" / "true" 都不算', () => {
    expect(isProxyReenabled('false', 'true')).toBe(false);
    expect(isProxyReenabled('false', true)).toBe(false);
    expect(isProxyReenabled(false, 'true')).toBe(false);
  });

  it('⚠️ 数字 0 / 1 不算（与 set-proxy 通道的严格布尔口径一致）', () => {
    expect(isProxyReenabled(0, 1)).toBe(false);
  });

  it('false → false 不算（关两次）', () => {
    expect(isProxyReenabled(false, false)).toBe(false);
  });
});

describe('TTL 常量必须与主世界一致', () => {
  it('PROXY_OFF_TTL_MS 是 30 分钟', () => {
    /**
     * 主世界是裸 JS，`PROXY_OFF_TTL_MS` 也各写一份。这里锁死具体值，
     * 两边都改成别的数时至少能被这里发现（`main-world-pgc.test.ts`
     * 另有断言比对两个源文件的字面量）。
     */
    expect(PROXY_OFF_TTL_MS).toBe(30 * 60 * 1000);
  });
});
