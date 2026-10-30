// @vitest-environment jsdom

/**
 * `readProxyOffMarkSync()` —— 「总开关关着」标记的**同步读取端**（G5，2026-10-30）
 *
 * ## 为什么需要它
 *
 * `handleHello` 的首发 `cfg` 必须同步发出（异步化 = 2026-10-29 真机事故），
 * 而真实的开关值只有异步的 `proxy/status` 能给。`localStorage` 标记是
 * **唯一同步可得**的开关证据，所以首发值拿它。
 *
 * ## 这里守的三件事
 *
 * 1. **只返回 `true` / `null`，永不返回 `false`** —— 标记只证明"关"，
 *    不证明"开"。返回 `false` 会让调用方以为"已知开着"，
 *    而 ADR 0020 要的是"判不了就放行"。
 * 2. **判据与 `main-world.js` 的 `pgcReadProxyOff()` 一致**（TTL、`at` 类型、
 *    坏 JSON、抛错）—— 不一致会出现"ISOLATED 说开着、主世界说关着"。
 * 3. **永不抛错** —— 它跑在 `postMessage` 监听器的同步路径上。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PROXY_OFF_KEY,
  PROXY_OFF_TTL_MS,
  readProxyOffMarkSync,
} from '../../../src/content/isolated/pgc-proxy-off';

/** 每个用例从干净的存储开始 —— jsdom 的 localStorage 在同一文件内是共享的 */
beforeEach(() => {
  localStorage.clear();
});

/** 写一个"现在刚关"的标记 */
function writeFresh(now: number, at: number = now): void {
  localStorage.setItem(PROXY_OFF_KEY, JSON.stringify({ at }));
}

describe('readProxyOffMarkSync：三态', () => {
  const NOW = 1_700_000_000_000;

  it('没有标记 → null（判不了，放行）', () => {
    expect(readProxyOffMarkSync(NOW)).toBeNull();
  });

  it('标记新鲜 → true（明确关着）', () => {
    writeFresh(NOW, NOW - 1000);
    expect(readProxyOffMarkSync(NOW)).toBe(true);
  });

  it('★ 永不返回 false —— "没有标记"不等于"开着"', () => {
    /**
     * 反例：把 `return null` 改成 `return false`，本条必须红。
     *
     * 为什么这是硬约束：标记写入会失败（配额满 / 隐私模式 / SW 没醒），
     * 那时"没有标记"与"开关开着"无法区分。返回 `false` 等于告诉调用方
     * "我确定是开着的"，而调用方会据此**不再查异步通道** ——
     * 功能从此绑死在存储能不能写上。
     */
    const cases = [
      null, // 没有标记
      'not-json', // 坏 JSON
      JSON.stringify({}), // 缺 at
      JSON.stringify({ at: 'yesterday' }), // at 不是数字
      JSON.stringify({ at: NOW - PROXY_OFF_TTL_MS }), // 刚过期（边界：不满足 age < TTL）
    ];
    for (const raw of cases) {
      localStorage.clear();
      if (raw !== null) localStorage.setItem(PROXY_OFF_KEY, raw);
      const v = readProxyOffMarkSync(NOW);
      expect(v, `raw=${String(raw)} 必须返回 null 而不是 false`).toBeNull();
    }
  });

  it('TTL 边界：29 分钟前算数，31 分钟前不算', () => {
    writeFresh(NOW, NOW - 29 * 60 * 1000);
    expect(readProxyOffMarkSync(NOW)).toBe(true);

    localStorage.clear();
    writeFresh(NOW, NOW - 31 * 60 * 1000);
    expect(readProxyOffMarkSync(NOW)).toBeNull();
  });

  it('未来时间戳（用户改过系统时钟）也算数', () => {
    /**
     * 与 `main-world.js` 的 `pgcReadProxyOff()` 口径一致：`age < TTL` 对未来时间戳
     * 天然成立（age 是负数）。标记记的是"写入那一刻"的意图，时钟跳变不改变意图。
     */
    writeFresh(NOW, NOW + 60_000);
    expect(readProxyOffMarkSync(NOW)).toBe(true);
  });

  it('坏 JSON → null，不抛', () => {
    localStorage.setItem(PROXY_OFF_KEY, '{oops');
    expect(() => readProxyOffMarkSync(NOW)).not.toThrow();
    expect(readProxyOffMarkSync(NOW)).toBeNull();
  });

  it('值是 JSON 字面量非对象（null / 数字 / 数组）→ null', () => {
    for (const raw of ['null', '42', '"off"', '[1,2]']) {
      localStorage.clear();
      localStorage.setItem(PROXY_OFF_KEY, raw);
      expect(readProxyOffMarkSync(NOW), `raw=${raw}`).toBeNull();
    }
  });

  it('localStorage.getItem 抛错 → null，不抛（隐私模式）', () => {
    /**
     * 抛在 `hello` 分支里会让整条 `postMessage` 分支失效 —— 那比"没有门控"严重。
     * 反例：去掉 try/catch，本条红。
     */
    const proto = Object.getPrototypeOf(localStorage) as {
      getItem: (k: string) => string | null;
    };
    const original = proto.getItem;
    proto.getItem = () => {
      throw new Error('SecurityError: localStorage 被禁用');
    };
    try {
      expect(() => readProxyOffMarkSync(NOW)).not.toThrow();
      expect(readProxyOffMarkSync(NOW)).toBeNull();
    } finally {
      proto.getItem = original;
    }
  });

  it('默认参数用 Date.now()（不传 now 也能用）', () => {
    localStorage.setItem(PROXY_OFF_KEY, JSON.stringify({ at: Date.now() }));
    expect(readProxyOffMarkSync()).toBe(true);
  });
});

describe('TTL 与键名必须与主世界一致', () => {
  it('PROXY_OFF_TTL_MS 是 30 分钟（与 main-world.js 的 PROXY_OFF_TTL_MS 同值）', () => {
    /**
     * 主世界是裸 JS，两处各写一份。这里只锁具体值；
     * "两个源文件的字面量一致"由 `main-world-pgc.test.ts` 断言。
     */
    expect(PROXY_OFF_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('PROXY_OFF_KEY 的字面量（与 main-world.js 的 PROXY_OFF_KEY 同值）', () => {
    expect(PROXY_OFF_KEY).toBe('pluma:proxy-off');
  });
});

/**
 * 判据**逻辑**的跨文件一致性（2026-10-30 补）。
 *
 * ## 为什么上面的常量断言不够
 *
 * 键名与 TTL 一致**不代表判据一致**。判据里有三个不显眼的分支：
 *
 * | 分支 | 两处都要求 |
 * | --- | --- |
 * | `at` 不是 number | 返回 `null` |
 * | 未来时间戳（用户改过系统时钟） | `age` 为负，`age < TTL` 成立 → **仍算数** |
 * | 过期边界 | `!(age < TTL)` → `null`（恰好等于 TTL 也算过期） |
 *
 * 只要一边把 `!(age < TTL)` 写成 `age > TTL`，TTL 那一刻两边就劈开：
 * ISOLATED 说"判不了"（放行）、主世界说"还关着"（拦截）—— 表现是
 * **关着开关偶尔回落、偶尔不回落**，是最难复现的那类症状。
 *
 * ## 为什么用源码断言而不是行为断言
 *
 * `main-world.js` 是裸 JS（不参与 TS 编译、不是模块），测试里 import 不了。
 * 所以钉住"两边的比较方式写成同一形态"，行为一致性由本文件上面的
 * 三态用例（针对 `readProxyOffMarkSync`）与 `main-world-pgc.test.ts`
 * （针对 `pgcReadProxyOff`）各自负责。
 *
 * ⚠️ **反例验证**：把 `pgc-proxy-off.ts` 的 `!(now - at < PROXY_OFF_TTL_MS)`
 * 改成 `now - at > PROXY_OFF_TTL_MS`，本组必红。
 */
describe('判据逻辑必须与 main-world.js 的 pgcReadProxyOff() 同形', () => {
  const mainWorldSource = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');
  const moduleSource = readFileSync(
    resolve(process.cwd(), 'src/content/isolated/pgc-proxy-off.ts'),
    'utf8',
  );

  it('两边都用 `!(age < TTL)` 形式判过期（边界含 TTL 那一毫秒）', () => {
    expect(/!\s*\(age\s*<\s*PROXY_OFF_TTL_MS\)/.test(mainWorldSource)).toBe(true);
    expect(/!\s*\(now\s*-\s*at\s*<\s*PROXY_OFF_TTL_MS\)/.test(moduleSource)).toBe(true);
  });

  it('两边都没有把它写成 `age > TTL`（差一毫秒的分支）', () => {
    // 写成 `>` 时 `age === TTL` 会被判"未过期"，与主世界劈开
    expect(/age\s*>\s*PROXY_OFF_TTL_MS/.test(mainWorldSource)).toBe(false);
    expect(/\bat\s*>\s*PROXY_OFF_TTL_MS/.test(moduleSource)).toBe(false);
    expect(/now\s*-\s*at\s*>\s*PROXY_OFF_TTL_MS/.test(moduleSource)).toBe(false);
  });

  it('两边都校验 `at` 是 number', () => {
    expect(/typeof at !== 'number'/.test(mainWorldSource)).toBe(true);
    expect(/typeof at !== 'number'/.test(moduleSource)).toBe(true);
  });

  it('两边读的都是 localStorage（不是 sessionStorage —— 跨标签页共享是必需性质）', () => {
    expect(/localStorage\.getItem\(PROXY_OFF_KEY\)/.test(mainWorldSource)).toBe(true);
    expect(/localStorage\.getItem\(PROXY_OFF_KEY\)/.test(moduleSource)).toBe(true);
  });
});
