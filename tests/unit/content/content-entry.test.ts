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
       *
       * ## ⚠️ 2026-11-11 签名扩到三个参数（task-15）
       *
       * 原断言是 `tellMainWorld(proxyEnabled, res.activated === true)`（两参）。
       * 现在第三个参数是 `extensionEngaged` —— **它回答的是另一个问题**：
       *
       * | 参数 | 回答 | 式样 |
       * | --- | --- | --- |
       * | 1 | 用户的总开关开没开 | 否定式（fail-open） |
       * | 2 | 这个标签页装没装规则 | `res.activated === true` |
       * | 3 | **扩展这次有没有真的参与取流** | 肯定式 `=== 'ok'`（fail-closed） |
       *
       * 三者不能合并：总开关开着 ≠ 装了规则 ≠ 参与了取流
       * （`page-identity` / `self` 都是"开关开着、没装规则、没参与"）。
       */
      /**
       * ## ⚠️ 2026-11-20：第 2/3 个参数改成"先记住再传"（候选过滤要能热更新）
       *
       * 形状变成 `tellMainWorld(switchOn, activatedKnown, rewriteGateKnown, …)` ——
       * 但**语义一个字没变**：第 2 个仍是 `res.activated === true`，第 3 个仍是
       * `extensionEngaged`，只是赋值挪到了两行之前（开关热更新时要重发 cfg，
       * 那时拿不到 `res`）。所以这条判据改成"两个来源仍在、且被原样传进去"。
       */
      expect(CONTENT).toContain('activatedKnown = res.activated === true;');
      expect(CONTENT).toContain('rewriteGateKnown = extensionEngaged;');
      expect(CONTENT).toContain('tellMainWorld(switchOn, activatedKnown, rewriteGateKnown,');
      expect(CONTENT).not.toContain('tellMainWorld(true, activatedKnown');
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

  describe('消息分支顺序：诊断路由表必须在有状态分支之后', () => {
    /**
     * ## 这条测试是怎么来的
     *
     * S3.4 把 6 条纯诊断消息（patch / sb-* / codec / req / pgc）收进了
     * `diagnostic-routes.ts`，并在 `listenMainWorld` **末尾**统一查表。
     *
     * 我把路由表挪到 `playurl-tracks` 之前做反例实验时，**29 条测试全绿** ——
     * 因为路由表对未知 type 返回 null、会自然往下走，`playurl-tracks` 本来
     * 就不在表里，所以挪位置**碰巧**没坏事。
     *
     * 但这个"碰巧"靠不住：只要将来有人往表里加了一个有状态的消息类型，
     * 放在前面就会把它**静默吃掉**（返回拒绝，后面的分支不再执行）。
     *
     * 所以这里从**源码结构**上锁死：诊断路由表的调用必须在
     * 所有 `if (d.type === ...)` 之后。
     */
    it('describeDiagnostic 出现在所有 if (d.type === ...) 之后', () => {
      const diagAt = CONTENT.indexOf('const diagnosticNote = describeDiagnostic(');
      expect(diagAt).toBeGreaterThan(0);

      /** `listenMainWorld` 里所有分支的位置 */
      const listenStart = CONTENT.indexOf('function listenMainWorld');
      const listenEnd = CONTENT.indexOf('\n}', listenStart);
      const body = CONTENT.slice(listenStart, listenEnd);

      const branchPositions = [...body.matchAll(/if \(d\.type (?:===|!==) '/g)].map(
        (m) => m.index ?? 0,
      );
      expect(branchPositions.length).toBeGreaterThan(0);

      const diagInBody = body.indexOf('const diagnosticNote = describeDiagnostic(');
      expect(diagInBody).toBeGreaterThan(0);

      const lastBranch = Math.max(...branchPositions);
      expect(diagInBody, '诊断路由表必须排在所有消息分支之后').toBeGreaterThan(lastBranch);
    });

    it('诊断路由表只处理纯诊断（有状态分支不在表里）', () => {
      /**
       * 这条与 `diagnostic-routes.test.ts` 互为双保险：
       * 那边测表的内容，这里测**调用处**没有把有状态分支也一起交出去。
       */
      expect(CONTENT).toContain('describeDiagnostic(');
      // 有状态的三条仍然各自独立判断
      expect(CONTENT).toContain("if (d.type === 'ssr-playinfo')");
      expect(CONTENT).toContain("if (d.type === 'playurl-tracks')");
      expect(CONTENT).toContain("if (d.type === 'hdr')");
    });
  });

  /**
   * ## T11：「扩展介入」的上报入口
   *
   * 主世界（`main-world.js` 的 `reportExtPatch()`）发 `__PLUMA_EXT_PATCH__`，
   * **这条监听器是它唯一的接收方**。少一个 `noteExtPatch()` 调用，
   * 时间轴上那个节点就永远是空的 —— 而这**不会让任何别的测试变红**：
   * `loading-trace.test.ts` 直接调 `recordExtPatch()`，面板测试直接构造事件，
   * 唯独"两界之间这根线"没有行为测试覆盖（它要一个真的 content script 实例）。
   *
   * 所以这里按本文件既有的手法做**源码级**断言：钉住"判据"与"落点"两件事。
   */
  describe('T11 · 扩展介入上报的接收端', () => {
    it('判据只有 __PLUMA_EXT_PATCH__ === true，且要求 at 是有限数', () => {
      expect(CONTENT).toContain('__PLUMA_EXT_PATCH__ === true');
      expect(CONTENT).toContain('Number.isFinite(d.at)');
      // 缺 at 时**不补一个** performance.now()（那会把一处 bug 掩盖成正常值）
      expect(/noteExtPatch\(performance\.now\(\)\)/.test(CONTENT)).toBe(false);
    });

    it('收到的 at 原样交给采集器（不换算、不加偏移）', () => {
      expect(CONTENT).toContain('noteExtPatch(d.at)');
      // 报了名却没接上：导入与调用必须同时在
      expect(CONTENT).toContain('noteExtPatch,');
    });

    /**
     * ## T13/P0-3：第二个触发点（接管取流）的判据来源
     *
     * 采集器要知道"本页取流是否由扩展代理"，只能由 `page/activate` 的
     * **回包**告诉它 —— 那是 background 确认"DNR 规则真的装上了"的唯一出口。
     * 少了这一行，首次观看（没有历史进度可还原）就永远不会出现「扩展介入」，
     * 而**没有任何别的测试会红**（纯函数那一半是直接给 state 赋值的）。
     */
    it('page/activate 回包把 activated 交给采集器（判据不许用"配了账号"推断）', () => {
      expect(CONTENT).toContain('setLoadingTraceProxied(res.activated === true)');
      expect(CONTENT).toContain('setLoadingTraceProxied,');
      // 反例：拿 streamingIdentity 直接推断"扩展在取流" —— page 身份下会误报
      expect(CONTENT).not.toContain("setLoadingTraceProxied(streamingIdentity === 'extension')");
    });
  });
});
