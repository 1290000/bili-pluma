/**
 * content.ts 入口的特征测试（S3.1 前置，2026-10-30）
 *
 * ## 为什么先写这个
 *
 * 阶段 3 要把 `entrypoints/content.ts` 的职责逐段下沉到 `src/content/isolated/`。
 * 但该文件**零直接 import 测试** —— 33 个测试文件中没有任何一个 import 它
 * （仅有几处 `readFileSync` 字符串断言）。
 *
 * 直接拆等于在没有防护网的地方做高风险手术。所以先建立**特征测试**（characterization test）：
 * 不验证"设计意图"，只**钉住当前已有的行为约束**，让接下来的移动/抽取一有偏差就红。
 *
 * ## 为什么用源码字符串断言而不是 import
 *
 * 它是 WXT 入口，`export default defineContentScript({...})` 在 import 时就会执行
 * 注册逻辑，且依赖 `chrome.*` / `document` 等大量全局。对一个**准备拆开**的文件，
 * 字符串断言反而更稳：
 *   - 不依赖内部函数是否导出（拆的时候签名会变）
 *   - 直接校验"这几条约束还在不在"
 *
 * 这与 `main-world-pgc.test.ts` 里校验常量的手法一致（裸 JS 没法 import）。
 *
 * ## ⚠️ 这个文件的定位
 *
 * 它是**过渡性的**。等 S3.1-S3.4 拆完、各模块有了真正的行为测试后，
 * 这里大部分断言应该迁移成对被拆出模块的直接测试，然后删除对应条目。
 * **不要把字符串断言当成长期方案** —— 它测不了行为，只能测"结构还在"。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONTENT = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

describe('content.ts 特征测试（拆分安全网）', () => {
  describe('入口契约：WXT 匹配规则必须与主世界一致', () => {
    it('matches 包含普通视频页与 PGC 页两类', () => {
      expect(CONTENT).toContain("'*://*.bilibili.com/video/*'");
      expect(CONTENT).toContain("'*://*.bilibili.com/bangumi/play/*'");
    });

    it('runAt 是 document_start（早于播放器初始化）', () => {
      expect(CONTENT).toMatch(/runAt:\s*'document_start'/);
    });
  });

  describe('report() 的关键行为（历史 bug 的防线）', () => {
    it('两类页面都登记 pageState（不是只登记 video 页）', () => {
      /**
       * 2026-10-29 的真实 bug：`if (info.kind === 'video') pageState.setPageKey(...)`
       * 导致 PGC 页从不登记 → `view()` 恒为 null → popup 一直显示"正在读取"，
       * 连主账号昵称都拿不到。
       *
       * 断言方式：`setPageKey` 不能在 `kind === 'video'` 的分支里。
       */
      expect(CONTENT).toContain('pageState.setPageKey(pageKey, p)');
      // 不许再出现"只给 video 页登记"的写法
      expect(/if \(info\.kind === 'video'\)\s*\{?\s*pageState\.setPageKey/.test(CONTENT)).toBe(
        false,
      );
    });

    it('主账号 mid 从页面 cookie 读，且带 settled 判据', () => {
      // document_start 时 document.cookie 往往为空，读不到不代表游客
      expect(CONTENT).toMatch(/readPrimaryMidFromCookie\(document\.cookie\)/);
      expect(CONTENT).toContain("document.readyState !== 'loading'");
    });

    it('走 sendToBackground 而不是直接调 browser.runtime.sendMessage', () => {
      /**
       * `browser.runtime.sendMessage` 在扩展重载后会**同步抛出**
       * `Extension context invalidated`，`.catch()` 接不住。
       */
      expect(CONTENT).toContain('sendToBackground(');
      expect(/^\s*(void )?browser\.runtime\.sendMessage\(/m.test(CONTENT)).toBe(false);
    });

    it('tellMainWorld 的第一个参数是总开关（不是写死 true）', () => {
      /**
       * 2026-10-29 修：原来写死 `tellMainWorld(true, ...)`，
       * 导致 `cfgEnabled` 永远为 true，"关开关后刷新番剧页画质不回落"。
       */
      expect(CONTENT).toContain('tellMainWorld(proxyEnabled, res.activated === true)');
      expect(CONTENT).not.toContain('tellMainWorld(true, res.activated === true)');
    });

    it('失败分支不清缓存、不无脑撤角标（防"角标乱跳"）', () => {
      expect(CONTENT).toContain('hasEverActivated');
      expect(CONTENT).toContain('badgeState.proxying = false');
    });
  });

  describe('main() 的生命周期与直连查询', () => {
    it('用原生 chrome.runtime.onMessage（Edge 下 browser.* 会静默失效）', () => {
      expect(CONTENT).toContain('chrome.runtime.onMessage.addListener');
    });

    it('不主动读 ctx.isInvalid（那个 getter 有副作用）', () => {
      // 2026-10-27 踩过：会把整个 ctx 永久 abort
      expect(/ctx\.isInvalid/.test(CONTENT.replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
    });

    it('接了 ctx 参数（Extension context invalidated 的正规解法）', () => {
      expect(CONTENT).toMatch(/main\(ctx\)/);
    });
  });

  describe('拆分期间必须保持的结构性事实', () => {
    it('页面判定只走 parsePlayPage，不自己写路径字面量', () => {
      /**
       * AGENTS.md §4.3：三个文件都在回答"这是不是播放页"，
       * 判据只许走 `parsePlayPage()`，路径字面量只许留在
       * `video-page.ts` / `routes.ts` / 两个 content 入口的 matches。
       * page-gate 检查会红，这里再做一道。
       */
      expect(CONTENT).toContain('parsePlayPage(');
    });

    it('代理开关状态只以 background 回报为准（不假定配置了就生效）', () => {
      expect(CONTENT).toContain("res?.type === 'page/activate:ok'");
      expect(CONTENT).toContain('res.activated === true');
    });
  });
});
