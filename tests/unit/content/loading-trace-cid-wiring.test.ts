// @vitest-environment jsdom

/**
 * `/video/` 页 SPA 换片的加载观测重置（2026-11-18）。
 *
 * ## 背景
 *
 * B站合集 / 相关视频是 pushState 导航：页面不刷新、采集器不重装、content.ts
 * 也不追踪 `/video/` 的 pageKey。`playurl-tracks` 消息新带的 `cid` 是**唯一**
 * 可观测的换片信号 —— cid 变化就重置加载观测（与 PGC 换集 `:1094` 同一条纪律）。
 *
 * ## 手法
 *
 * 照 `pgc-takeover-wiring.test.ts`：`playurl-tracks` 分支的**真实代码文本**从
 * `content.ts` 里抠出来，用 `new Function` + `with(stubs)` 注入依赖执行 ——
 * 测的是真正会跑的那段代码，不是抄一份的实现。
 *
 * ## 两个时序陷阱（钉死在本文件里）
 *
 * 1. 首次取流（`loadingTraceCid === null`）**不许重置**：首屏重置会把
 *    「页面开始加载 0.00s」清掉（`loading-pane.ts` 写明 reset 后有意不补 nav 事件）。
 * 2. 同 cid 不重置：切画质也发 playurl，时间轴继续累计是正确语义。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

const CONTENT_SRC = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

/** 从源码里抠出 `playurl-tracks` 分支并执行（依赖经 stubs 注入；d 的 summary/cid 由调用方给）。 */
function runTracksBranch(
  cid: string | undefined,
  summary: unknown,
  env: {
    loadingTraceCid: string | null;
    resetLoadingTrace: () => void;
    attachLoadingTraceVideo: () => void;
  },
): { loadingTraceCid: string | null } {
  const at = CONTENT_SRC.indexOf("if (d.type === 'playurl-tracks')");
  expect(at, '源码里找不到 playurl-tracks 分支').toBeGreaterThan(-1);
  // ⚠️ 分支里有多个 `return;`（`!s` 早退等），不能拿第一个 return 当结束 ——
  // 那会把 cid 重置逻辑（在 `if (!s) return;` 之后）整段切掉。以下一个分支
  // （HDR）的注释为界，截到本分支闭合。
  const nextBranch = CONTENT_SRC.indexOf('// HDR 状态', at);
  expect(nextBranch, '找不到下一个分支的注释标记').toBeGreaterThan(at);
  const block = CONTENT_SRC.slice(at, nextBranch).replace(/\s+$/, '');
  // content.ts 是 TS：先剥类型（`as` 断言 / 类型标注）再交给 `new Function`
  const js = transpileModule(block, {
    compilerOptions: { target: 99 /* ESNext */, module: 99 /* ESNext（类型剥离） */ },
  }).outputText;
  const stubs = {
    d: { type: 'playurl-tracks', cid, summary },
    loadingTraceCid: env.loadingTraceCid,
    resetLoadingTrace: env.resetLoadingTrace,
    attachLoadingTraceVideo: env.attachLoadingTraceVideo,
    badgeState: {},
    paintBadge: () => {},
    reportQuality: () => {},
    describeTracks: () => 'tracks',
  };
  new Function('stubs', `with (stubs) { ${js} }`)(stubs);
  // with-stub 上的赋值落在 stubs 对象属性上 —— 读回来即是分支写入的最新值
  return { loadingTraceCid: stubs.loadingTraceCid as string | null };
}

/** 分支桩里需要的最小 summary（badge 逻辑只看 `dolbyVision`） */
function trackSummary(): unknown {
  return { audio: [], video: [], flac: null, dolby: null, dolbyVision: false };
}

describe('S-T3：/video/ SPA 换片 → cid 变化才重置加载观测', () => {
  it('首次取流（loadingTraceCid=null）→ 不重置，只记 cid', () => {
    let resets = 0;
    const { loadingTraceCid } = runTracksBranch('42141027046', trackSummary(), {
      loadingTraceCid: null,
      resetLoadingTrace: () => {
        resets += 1;
      },
      attachLoadingTraceVideo: () => {},
    });

    expect(resets).toBe(0); // 首屏重置会把「页面开始加载 0.00s」清掉
    expect(loadingTraceCid).toBe('42141027046');
  });

  it('cid 变化 → 重置 + 重挂 video 监听', () => {
    let resets = 0;
    let attaches = 0;
    const { loadingTraceCid } = runTracksBranch('99999999999', trackSummary(), {
      loadingTraceCid: '42141027046',
      resetLoadingTrace: () => {
        resets += 1;
      },
      attachLoadingTraceVideo: () => {
        attaches += 1;
      },
    });

    expect(resets).toBe(1);
    expect(attaches).toBe(1); // 播放器可能重建了 <video>
    expect(loadingTraceCid).toBe('99999999999');
  });

  it('同 cid（切画质也发 playurl）→ 不重置，时间轴继续累计', () => {
    let resets = 0;
    const { loadingTraceCid } = runTracksBranch('42141027046', trackSummary(), {
      loadingTraceCid: '42141027046',
      resetLoadingTrace: () => {
        resets += 1;
      },
      attachLoadingTraceVideo: () => {},
    });

    expect(resets).toBe(0);
    expect(loadingTraceCid).toBe('42141027046');
  });

  it('cid 解析不出（空串）→ 不重置也不更新记忆值', () => {
    let resets = 0;
    const { loadingTraceCid } = runTracksBranch(undefined, trackSummary(), {
      loadingTraceCid: '42141027046',
      resetLoadingTrace: () => {
        resets += 1;
      },
      attachLoadingTraceVideo: () => {},
    });

    expect(resets).toBe(0);
    expect(loadingTraceCid).toBe('42141027046');
  });
});
