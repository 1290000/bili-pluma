// @vitest-environment jsdom

/**
 * 「打开「关于」Tab 即视为已读」的**接线**测试（2026-11-17，2026-11-17 二轮补强）。
 *
 * ## 为什么这条必须单独测
 *
 * `aboutTab()`（视图层）不负责发消息，`handleUpdateDismiss()`（background）也不负责
 * "什么时候该发" —— 中间那一步在 `panel.ts` 的 `ensureUpdateDismissed()`。
 *
 * 那一步错了会分成三种，都很糟，而且**都不会被别的测试发现**：
 *
 * | 写错 | 后果 |
 * | --- | --- |
 * | 不接线（少调一次） | `dismissedVersion` 永远是 `null` ⇒ 红点与角标**永远消不掉** |
 * | 不防重 | `render()` 是高频函数 ⇒ **每一帧一条消息**（失败分支直接无限循环） |
 * | 防重退化成布尔 | 同一会话里出的下一版，红点再也消不掉 |
 *
 * ## 红点通道（P1）也必须在这里钉住
 *
 * `updateDot` 的显示依赖 `updateStatus`，而 `updateStatus` 只有在
 * "有人去读" 之后才有值。曾经 `ensureUpdateRead()` 只写在 `tab === 'about'` 分支里，
 * 于是不点进「关于」就恒为 `null` ⇒ 红点**永远不亮**，通知通道整个是死的。
 * 下面的「红点通道」那一组就是这个缺陷的回归测试。
 *
 * ## 反向验证（全部实跑过）
 *
 * | 变异 | 变红的那条 |
 * | --- | --- |
 * | 删掉 `render()` 里的 `ensureUpdateDismissed()` | 恰好一次 / 不风暴 / 失败静默 |
 * | 删掉 `dismissedFor === latest` 早退 | 不风暴（且失败分支会无限循环挂死） |
 * | `dismissedFor` 换成一次性布尔 | 下一版还要再消一次 |
 * | `if (status) updateStatus = status` 改成直接赋值 | 失败后 status 调用次数不增加 |
 * | `ensureUpdateRead()` 放回 about 分支 | 红点通道：不进「关于」也要亮 |
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountPanelBody } from '@/src/content/panel/panel';
import type { PanelController } from '@/src/content/panel/panel';
import type { UpdateStatusView } from '@shared/types/update';

function view(over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    currentVersion: '1.1.0',
    latestVersion: '1.2.0',
    latestSizeBytes: 289_831,
    latestZipUrl: 'https://example.invalid/pluma-1.2.0.zip',
    phase: 'available',
    autoCheckEnabled: true,
    intervalDays: 1,
    lastCheckAt: Date.now() - 60_000,
    lastAppliedVersion: null,
    lastFailedVersion: null,
    ...over,
  };
}

const noopActions = {
  login: () => undefined,
  logout: async () => ({ ok: true }),
  streamingIdentity: null,
  toggleStreamingIdentity: () => undefined,
  feedAccountEnabled: false,
  toggleFeedAccount: () => undefined,
  currentStreamingIdentity: () => null,
};

interface Backend {
  /** `update/status` 的应答。`null` = 读失败（回 err，模拟 SW 没醒） */
  status?: UpdateStatusView | null;
  /** `update/dismiss` 的应答。参数是第几次调用（1 起）。缺省 = ok + 换成 dismissed */
  dismiss?: (call: number) => {
    type: string;
    status?: UpdateStatusView;
    detail?: string | null;
  };
  /** `update/check` 的应答状态。缺省 = 不处理（回 err） */
  check?: UpdateStatusView;
  /**
   * `update/dismiss` **同步抛**（扩展被重载后的 `Extension context invalidated`）。
   *
   * 这是 `.catch()` 接不到的那一类：`chrome.runtime.sendMessage` 在上下文失效时是
   * **同步抛**，不是返回 rejected promise。
   */
  syncThrowDismiss?: boolean;
}

interface Harness {
  dismissCalls: () => number;
  statusCalls: () => number;
}

/**
 * 桩后台。
 *
 * ⚠️ `update/status` **每次**都回同一个 `available`（不模拟"落盘后变 dismissed"）——
 * 这样"防重"能证明靠的是面板自己的 flag，而不是"后台恰好不再回 available"。
 */
function stubBackend(backend: Backend = {}): Harness {
  let dismissCalls = 0;
  let statusCalls = 0;
  const status = backend.status === undefined ? view() : backend.status;

  /** 各消息的应答（同步抛那条在 `sendMessage` 外面单独拦） */
  const route = (msg: { type?: string }): Promise<unknown> => {
    if (msg.type === 'update/status') {
      statusCalls += 1;
      return Promise.resolve(
        status === null
          ? { type: 'update/status:err', detail: 'boom' }
          : { type: 'update/status:ok', status },
      );
    }
    if (msg.type === 'update/dismiss') {
      dismissCalls += 1;
      return Promise.resolve(
        backend.dismiss
          ? backend.dismiss(dismissCalls)
          : { type: 'update/dismiss:ok', status: view({ phase: 'dismissed' }) },
      );
    }
    if (msg.type === 'update/check') {
      if (!backend.check) return Promise.resolve({ type: 'update/check:err', detail: 'boom' });
      return Promise.resolve({
        type: 'update/check:ok',
        status: backend.check,
        outcome: 'ok',
        reason: null,
      });
    }
    return Promise.resolve({
      type: 'proxy/status:ok',
      enabled: true,
      hasCredential: true,
      ruleCount: 0,
    });
  };

  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn((msg: { type?: string }) => {
        if (msg.type === 'update/dismiss' && backend.syncThrowDismiss) {
          // 同步抛：不是 rejected promise，`.catch()` 根本接不到
          throw new Error('Extension context invalidated');
        }
        return route(msg);
      }),
      getManifest: () => ({ version: '1.1.0' }),
    },
  });

  return { dismissCalls: () => dismissCalls, statusCalls: () => statusCalls };
}

const model = {
  quality: {
    pill: '已接管',
    tone: 'good',
    line: null,
    unlock: null,
    proxyEnabled: true,
    pageKind: 'play',
  },
  clean: null,
  account: {
    primary: { uname: '主账号', level: 6, loggedIn: 'yes', source: 'live' },
    playback: null,
    unknown: false,
    hasCredential: true,
    needsLogin: false,
  },
  pageKind: 'play',
  pageStateKind: 'ok',
  pageView: null,
} as const;

let controller: PanelController | null = null;

beforeEach(() => {
  document.body.textContent = '';
});

function mount(): PanelController {
  controller = mountPanelBody(noopActions as never);
  return controller;
}

function versionLine(c: PanelController): string {
  return c.root.querySelector('[data-testid="update-version"]')?.textContent ?? '';
}

function updateBtn(c: PanelController): HTMLButtonElement | null {
  return c.root.querySelector('[data-testid="update-now"]');
}

function checkBtn(c: PanelController): HTMLButtonElement | null {
  return c.root.querySelector('[data-testid="update-check"]');
}

function aboutDot(c: PanelController): HTMLElement | null {
  // 红点挂在「关于」这个 tab 按钮上
  for (const btn of c.root.querySelectorAll('.tab')) {
    if ((btn.textContent ?? '').includes('关于')) return btn.querySelector('.tab-dot');
  }
  return null;
}

/** 让出几轮微任务，给"如果没防重"的实现留出暴露机会 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('红点通道：不点进「关于」也必须能亮（P1 回归）', () => {
  it('★★★ 挂载后后台报 available ⇒ 关于 Tab 的红点**可见**', async () => {
    const h = stubBackend();
    const c = mount();

    // 关键：**不**调 showTab('about')
    await vi.waitFor(() => {
      expect(aboutDot(c)?.hidden, '不点进关于页，红点就不亮 —— 这条通知通道等于不存在').toBe(false);
    });
    // 也不许顺手发 dismiss（没人看过，凭什么算已读）
    expect(h.dismissCalls()).toBe(0);
  });

  it('读不到状态 ⇒ 红点保持隐藏（不许瞎亮）', async () => {
    // `update/status` 回 err ⇒ readUpdateStatus() = null
    const h = stubBackend({ status: null });
    const c = mount();

    await vi.waitFor(() => {
      expect(h.statusCalls()).toBe(1);
    });
    await flush();
    expect(aboutDot(c)?.hidden, '读不到状态还亮红点，等于编一个"有新版本"').toBe(true);
    // 点进「关于」也只说读不到，不 dismiss
    c.showTab('about');
    await flush();
    expect(c.root.textContent ?? '').toContain('读不到更新状态');
    expect(h.dismissCalls()).toBe(0);
  });

  it('phase 是 idle（没有新版）⇒ 红点保持隐藏', async () => {
    const h = stubBackend({ status: view({ phase: 'idle', latestVersion: '1.1.0' }) });
    const c = mount();

    await vi.waitFor(() => {
      expect(h.statusCalls()).toBe(1);
    });
    await flush();
    expect(aboutDot(c)?.hidden).toBe(true);
  });

  /**
   * P1 的**副作用护栏**：`ensureUpdateRead()` 从「关于」分支提到 `render()` 顶部之后，
   * 任何一次 reject 都会让 `updateReadFailed` 保持 `false`，于是
   * `render → read → reject → finally(render) → read …` 变成**死循环**。
   *
   * 真机场景：扩展被重载后旧的 content script 里 `sendMessage` **同步抛**
   * `Extension context invalidated` → `readUpdateStatus` 的 `.catch()` 挂不上去
   * （异常发生在它被调用之前）→ 整个 async 函数 reject → 面板卡死、CPU 拉满。
   *
   * ⚠️ 桩必须是**同步抛**，不能是 `Promise.reject`：后者会被
   * `readUpdateStatus` 里的 `.catch(() => null)` 吃掉，转成 `null`，环根本起不来。
   *
   * ## 为什么桩要"前 5 次抛，之后回 err"
   *
   * 纯抛的桩会让变异版本**挂死**（微任务死循环连计时器都饿死），
   * 那样得到的是超时/OOM 而不是一条清晰的断言失败。给个上限，环就会自然收敛：
   * 正确实现只读 1 次；变异实现会一路读到第 6 次被 err 终止。
   *
   * 变异验证：把 `.catch(() => { updateReadFailed = true; })` 改成 `.catch(() => undefined)`
   * → 本条必红（`expected 6 to be 1`）。
   */
  it('★★ update/status 同步抛 ⇒ 不许死循环重读（P1 的副作用护栏）', async () => {
    let calls = 0;
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(() => {
          calls += 1;
          if (calls <= 5) throw new Error('Extension context invalidated');
          return Promise.resolve({ type: 'update/status:err', detail: 'boom' });
        }),
        getManifest: () => ({ version: '1.1.0' }),
      },
    });

    const c = mount();
    c.showTab('quality');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();

    expect(calls, 'read 失败后还在反复重试 —— 这是一个死循环').toBe(1);
  });
});

describe('进入「关于」Tab 即视为已读', () => {
  it('phase 为 available ⇒ 发**恰好一次** dismiss，并把状态换成 dismissed', async () => {
    const h = stubBackend();
    const c = mount();
    c.showTab('about');

    await vi.waitFor(() => {
      expect(h.dismissCalls(), '进了「关于」却没发 dismiss —— 红点将永远消不掉').toBe(1);
    });
    // 拿到应答后要重画：红点消失、按钮仍可点
    await vi.waitFor(() => {
      expect(aboutDot(c)?.hidden, 'dismiss 成功了红点却还亮着').toBe(true);
    });
  });

  it('高频 render 不产生消息风暴（dismiss 只发一次）', async () => {
    const h = stubBackend();
    const c = mount();
    c.showTab('about');

    await vi.waitFor(() => {
      expect(h.dismissCalls()).toBe(1);
    });

    // 面板会在这些路径上重画：切 Tab、模型更新、以及 ensureUpdateRead 的 finally
    c.showTab('quality');
    c.showTab('about');
    c.setModel(model as never);
    c.showTab('about');
    await flush();

    expect(h.dismissCalls()).toBe(1);
  });

  /**
   * P2：防重**必须是版本号级的**，不能是一次性布尔。
   *
   * `dismissedVersion` 的语义是"压住**这一版**"（`shouldPrompt` 的判据就是
   * `state.dismissedVersion !== state.latest?.version`）。面板若退化成"本会话已 dismiss 过"，
   * 用户停在这一页时查出的下一版就永远不会被记成已读 —— 红点消不掉，而且
   * **只有重开面板才能恢复**。
   *
   * 变异验证：把 `dismissedFor` 换成 `dismissedOnce: boolean` → 本条必红（`dismissCalls` 停在 1）。
   */
  it('★★ dismiss 掉 1.2.0 后又查出 1.3.0 ⇒ 还要再消一次（版本号级防重）', async () => {
    const h = stubBackend({
      status: view({ phase: 'available', latestVersion: '1.2.0' }),
      dismiss: (call) =>
        call === 1
          ? {
              type: 'update/dismiss:ok',
              status: view({ phase: 'dismissed', latestVersion: '1.2.0' }),
            }
          : {
              type: 'update/dismiss:ok',
              status: view({ phase: 'dismissed', latestVersion: '1.3.0' }),
            },
      check: view({ phase: 'available', latestVersion: '1.3.0' }),
    });

    const c = mount();
    c.showTab('about');
    await vi.waitFor(() => {
      expect(h.dismissCalls()).toBe(1);
    });

    // 用户就停在这一页，点「检查更新」查到了 1.3.0
    checkBtn(c)?.click();

    await vi.waitFor(() => {
      expect(h.dismissCalls(), '下一版没有重新 dismiss —— 红点再也消不掉').toBe(2);
    });
    await vi.waitFor(() => {
      expect(aboutDot(c)?.hidden).toBe(true);
    });
    // dismiss 只压提示：版本行与「立即更新」都必须保留
    expect(versionLine(c)).toContain('最新 v1.3.0');
    expect(updateBtn(c)?.disabled).toBe(false);
  });

  it('dismiss 失败 ⇒ 静默保留红点，**不**把界面切成错误态', async () => {
    const h = stubBackend({ dismiss: () => ({ type: 'update/dismiss:err', detail: 'boom' }) });
    const c = mount();
    c.showTab('about');

    await vi.waitFor(() => {
      expect(h.dismissCalls()).toBe(1);
    });
    await flush();

    // 红点仍在（这一版确实还没被记成已读）
    expect(aboutDot(c)?.hidden).toBe(false);
    // Tab 里其他内容完全没受影响：版本行还在，按钮还能点
    expect(versionLine(c)).toContain('最新 v1.2.0');
    expect(updateBtn(c)?.disabled).toBe(false);
  });

  /**
   * P3：失败时**不许**把 `updateStatus` 置成 `null`。
   *
   * ## 为什么单看 DOM 抓不到这个 bug
   *
   * 置成 `null` 之后 `ensureUpdateRead` 的 `updateStatus !== null` 早退失效，会立刻
   * 重读一次把界面**救回来** —— 最终 DOM 长得和正确实现一模一样，只有中间闪过一帧
   * 「读不到更新状态」。真机代价是每次失败多一条 `update/status` + 一次闪烁。
   *
   * 所以这里断言的是**消息次数**，不是 DOM。
   *
   * 变异验证：把 `if (status) updateStatus = status;` 改成 `updateStatus = status;` → 本条必红。
   */
  it('★★ dismiss 失败后**不许多读一次** update/status（置 null 会白跑一趟）', async () => {
    const h = stubBackend({ dismiss: () => ({ type: 'update/dismiss:err', detail: 'boom' }) });
    const c = mount();
    c.showTab('about');

    await vi.waitFor(() => {
      expect(h.dismissCalls()).toBe(1);
    });
    await flush();

    expect(h.statusCalls(), 'dismiss 失败却把 updateStatus 置 null，白重读了一次').toBe(1);
    // 再切一次 Tab 也不该产生新的读取
    c.showTab('quality');
    c.showTab('about');
    await flush();
    expect(h.statusCalls()).toBe(1);
  });

  /**
   * P4（顺手）：`sendMessage` 在扩展被重载后是**同步抛**，而挂在其后的 `.catch()` 接不到。
   *
   * ## 为什么"穿不穿出 render"这条断言**抓不到**真正的 bug
   *
   * `requestUpdateDismiss()` 是 `async` 函数 —— 体内的同步抛被它自己转成
   * **rejected promise**，所以：
   *
   * | | 有没有 try/catch | 有没有链上 `.catch()` |
   * | --- | --- | --- |
   * | `showTab` 会不会抛 | 不会 | 不会 |
   * | 有没有未处理的 rejection | **有** | 没有 |
   *
   * 也就是说只加 `try/catch` 是**假修**：`.finally` 照跑（标志位不卡），
   * 但真机上会留一条 unhandled rejection。所以这里直接监听
   * `unhandledRejection` 事件来断言 —— 这才是这类 bug 唯一可观测的形态。
   *
   * 变异验证：删掉 `ensureUpdateDismissed` 里的 `.catch(() => undefined)` → 本条必红。
   */
  it('★ sendMessage **同步抛**（扩展被重载）⇒ 不许留下未处理的 rejection', async () => {
    const unhandled: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    try {
      stubBackend({ syncThrowDismiss: true });
      const c = mount();

      expect(
        () => c.showTab('about'),
        '同步抛穿了 render / showTab，整个面板就不能用了',
      ).not.toThrow();

      // 让出宏任务：unhandledRejection 要等微任务队列排空才发得出来
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled, '未处理的 promise rejection —— 真机控制台会一片红').toHaveLength(0);
      // 面板照常可用
      await vi.waitFor(() => {
        expect(versionLine(c)).toContain('最新 v1.2.0');
      });
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('phase 本来就不是 available（没有新版）⇒ 一条 dismiss 都不许发', async () => {
    const h = stubBackend({ status: view({ phase: 'idle', latestVersion: '1.1.0' }) });
    const c = mount();
    c.showTab('about');

    await vi.waitFor(() => {
      expect(versionLine(c)).toBe('当前 v1.1.0 · 已是最新');
    });
    expect(h.dismissCalls(), '没有新版还去 dismiss，等于凭空写一个 dismissedVersion').toBe(0);
  });
});

describe('读失败后的自救路径', () => {
  /**
   * `updateReadFailed` 是"本会话不再重试"的闸，它挡住了
   * `render → read → reject → render` 那个死循环。但它也把**瞬时**失败
   * 变成**永久**失败：用户只剩「关掉面板再打开试试」一条路。
   *
   * 项目里已有先例（`showTab` 的 `badgeReadFailed`）：进那个 Tab = 一次明确的重试意愿。
   *
   * 变异验证：删掉 `showTab` 里的 `if (t === 'about') updateReadFailed = false;` → 本条必红（停在 1）。
   */
  it('★★ 读失败后进「关于」= 一次重试意愿（每次进 Tab 恰好 1 次，不成风暴）', async () => {
    const h = stubBackend({ status: null }); // 回 err ⇒ readUpdateStatus() = null
    const c = mount();

    await vi.waitFor(() => {
      expect(h.statusCalls()).toBe(1);
    });
    /**
     * ⚠️ 必须等**这次读落定**再切 Tab：`ensureUpdateRead` 有 `updateReading` 早退，
     * 读还在飞的时候切 Tab，复位会被这条早退吃掉（人做不到这么快的操作）。
     */
    await flush();
    expect(h.statusCalls()).toBe(1);

    c.showTab('about');
    await vi.waitFor(() => {
      expect(h.statusCalls(), '进「关于」没有重试 —— 瞬时失败被固化成了永久失败').toBe(2);
    });

    // 同一屏内不许反复重试（那条会变成消息风暴）
    await flush();
    expect(h.statusCalls()).toBe(2);

    // 再进一次 = 又一次明确的重试
    c.showTab('quality');
    c.showTab('about');
    await vi.waitFor(() => {
      expect(h.statusCalls()).toBe(3);
    });
  });
});

describe('跨 Tab 同步（storage.onChanged → applyUpdateStatus）', () => {
  /**
   * 多 Tab 场景：`updateStatus` 是**每个面板实例自己的缓存**，读到一次就不再重读。
   * 所以在 A 里看过「关于」之后，B 的红点会一直亮着 —— 界面与后台事实相反。
   *
   * 解法是入口订阅 `pluma:update-state` 后调 `applyUpdateStatus()`。
   * 这里测的是**面板这一半**（入口那一半在 `entry-panel-update-sync.test.ts` 里断言）。
   */
  it('★★ 别的 Tab 写了"已读" ⇒ 推来的状态让红点消失，且不再 dismiss', async () => {
    const h = stubBackend();
    const c = mount();

    await vi.waitFor(() => {
      expect(aboutDot(c)?.hidden).toBe(false);
    });

    // 另一个标签页里点进了「关于」→ 后台落盘 dismissedVersion → storage.onChanged 推过来
    c.applyUpdateStatus(view({ phase: 'dismissed' }));

    expect(aboutDot(c)?.hidden, '别的 Tab 已经读过这一版了，这里的红点还亮着').toBe(true);
    expect(h.dismissCalls(), '同步来的状态不许再触发一次 dismiss').toBe(0);
  });

  /**
   * ⚠️ 反过来那一半更重要：推来的 `available` **不许**算"用户看过"。
   *
   * 否则两个面板互相踩：A 里刚查出 1.3.0，B 恰好停在「关于」上就把它记成已读，
   * A 那边的红点直接消失 —— 而 A 的用户根本没看到。
   *
   * 变异验证：删掉 `applyUpdateStatus` 里的 `suppressDismissOnce = true;`
   * （以及 render 里那次消费）→ 本条必红（`dismissCalls` 变成 1）。
   */
  it('★★ 推来的 available 在「关于」页上也不许触发 dismiss（多 Tab 互相踩）', async () => {
    const h = stubBackend({ status: view({ phase: 'idle', latestVersion: '1.1.0' }) });
    const c = mount();
    c.showTab('about');

    await vi.waitFor(() => {
      expect(versionLine(c)).toBe('当前 v1.1.0 · 已是最新');
    });

    // 后台自动检查（或另一个 Tab 手点）发现了 1.2.0
    c.applyUpdateStatus(view({ phase: 'available', latestVersion: '1.2.0' }));

    expect(aboutDot(c)?.hidden, '有新版本，红点该亮').toBe(false);
    expect(
      h.dismissCalls(),
      '存储推来的状态被当成"用户看过"了 —— 另一个 Tab 的红点会凭空消失',
    ).toBe(0);
    // 版本行同步更新了
    expect(versionLine(c)).toContain('最新 v1.2.0');
  });

  /**
   * ## `suppressDismissOnce` 的**消费位置**（2026-11-17 四轮）
   *
   * ## 为什么单独立一条
   *
   * 这个标志必须**在 `render()` 入口消费**，不能在 `about` 分支里消费。
   * 差别只在"当前不在「关于」时收到推送"这一种情形下暴露：
   *
   * | 消费位置 | 不在「关于」时收到推送 | 随后进「关于」 |
   * | --- | --- | --- |
   * | `render()` 入口（正确） | 标志当场被吃掉 | **正常 dismiss** ✅ |
   * | `about` 分支里（错误） | 标志留着 | 被压制 ⇒ **0 次 dismiss**，要进第二次才生效 ❌ |
   *
   * 后者的用户可见后果就是**这一版的红点再也消不掉**（除非退出再进一次）——
   * 正是本功能要修的那条原始 bug 换了个入口回归。
   *
   * ⚠️ 这个变异**能骗过此前的全部用例**（14 条全绿）：因为其他用例要么不在
   * 「关于」时推送（那条只断言红点），要么推送时就停在「关于」上（那条断言"不许 dismiss"，
   * 两种实现都给 0）。**"设计决定无测试钉住"在这个仓库已经出现三次**，这次钉死。
   *
   * 变异验证：把 `render()` 顶部那两行
   * `const suppressDismiss = suppressDismissOnce; suppressDismissOnce = false;`
   * 搬进 `about` 分支 → 本条必红（`expected +0 to be 1`）。
   */
  it('★★ 不在「关于」时收到推送 ⇒ 随后进「关于」必须正常 dismiss 一次', async () => {
    const h = stubBackend({ status: view({ phase: 'idle', latestVersion: '1.1.0' }) });
    const c = mount();
    c.showTab('quality');

    await vi.waitFor(() => {
      expect(aboutDot(c)?.hidden).toBe(true);
    });

    // 后台检查发现了 1.2.0 —— 此时用户**不在**「关于」Tab
    c.applyUpdateStatus(view({ phase: 'available', latestVersion: '1.2.0' }));
    expect(h.dismissCalls(), '没人在看「关于」，这一刻不该 dismiss').toBe(0);

    // 用户随后点进「关于」= 一次真实的"我看到了"
    c.showTab('about');
    await vi.waitFor(() => {
      expect(
        h.dismissCalls(),
        '推送留下的压制标志没被 render() 消费掉 —— 这次合法的 dismiss 被吃掉了',
      ).toBe(1);
    });
    await vi.waitFor(() => {
      expect(aboutDot(c)?.hidden).toBe(true);
    });
  });

  /**
   * B2：压制是**一次性**的，不是"从此不再 dismiss"。
   *
   * 若有人把 `suppressDismissOnce = false` 那次消费漏掉（只置 true 不复位），
   * 第一条还能过（第一次进「关于」时标志已在 render 入口被读走…），
   * 但再进一次就会暴露：标志还挂着 ⇒ 第二次也不 dismiss。
   */
  it('★★ 压制只生效一次：再进一次「关于」不会重复 dismiss，但也不会永久失效', async () => {
    const h = stubBackend({ status: view({ phase: 'idle', latestVersion: '1.1.0' }) });
    const c = mount();
    c.showTab('quality');

    await vi.waitFor(() => {
      expect(aboutDot(c)?.hidden).toBe(true);
    });

    c.applyUpdateStatus(view({ phase: 'available', latestVersion: '1.2.0' }));
    c.showTab('about');
    await vi.waitFor(() => {
      expect(h.dismissCalls()).toBe(1);
    });

    // 已 dismiss（phase=dismissed）→ 再进不会再发
    c.showTab('quality');
    c.showTab('about');
    await flush();
    expect(h.dismissCalls(), '同一版被 dismiss 了两次').toBe(1);

    // 又来一个新版本：这一屏收到推送（若压制标志没被消费，就会永久压制下去）
    c.applyUpdateStatus(view({ phase: 'available', latestVersion: '1.3.0' }));
    c.showTab('quality');
    c.showTab('about');
    await vi.waitFor(() => {
      expect(h.dismissCalls(), '压制标志没复位 —— 之后的版本再也 dismiss 不了').toBe(2);
    });
  });
});
