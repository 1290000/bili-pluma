/**
 * 扫码窗口存活探测（2026-11-12 task-24 起，2026-11-15 task-47 改造）
 *
 * ## 这张测试要守住的核心 bug（**两次**，别只看第一次）
 *
 * ### 第一次（task-24）：第二次点击静默
 *
 * `openLoginWindow()` 判断"扫码窗口已开着"的唯一依据是 `currentWindowId`，
 * 而它在 `incognito: "split"` 下**永远拿不到**（`create()` 返回 `undefined`）。
 * 修法：扫码窗口页面定期写心跳到 `chrome.storage.local`，普通实例读它。
 *
 * ### 第二次（task-47）：心跳会**冻结**，于是"没窗口"被说成"已开着"
 *
 * 心跳的清理写在页面 `useEffect` 的 cleanup 里。用户关窗时文档被直接销毁，
 * React **不会**卸载组件 ⇒ cleanup 不跑 ⇒ 心跳停在最后一次写入 ⇒
 * 90 秒 TTL 内所有点击都读到"活着" ⇒ 既不建窗也不提示。
 *
 * 真机日志（同一实例 14 次连续点击）：
 * ```
 * 20:50:52.633  probe/heartbeat  alive age=49080ms
 * 20:50:52.636  login/open  {"ok":true,"reason":"already-open"}
 * ...（到 20:51:05，age 涨到 62190ms，全部 already-open，屏幕上 0 个扫码窗）
 * ```
 *
 * ⇒ 判据从「时间戳还新」换成「**页面当场应答 ping**」。
 *
 * ## 为什么这些断言这样写
 *
 * 用**内存版 `chrome.storage.local`** 模拟真实存储，不 mock 被测函数 ——
 * 这样测到的是真实实现，包括过期判定、异常兜底这些容易写错的地方。
 *
 * 另外用一个开关模拟「页面还活着 / 已经没了」：
 * - `livePage: true`  → 页面收到 ping 立刻回 pong（真机上的活窗口）
 * - `livePage: false` → 没人应答（关窗 / 崩溃 / 硬杀）
 *
 * ⚠️ **不许把 `livePage` 的默认值改成 true**：那样"页面没了"这条最重要的
 * 断言会退化成"页面还在"，整张表就测不到本次修的 bug。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStorage {
  bag: Record<string, unknown>;
}

const store: FakeStorage = { bag: {} };

/** 页面是否「活着」—— 决定它会不会应答 ping。默认 **不活**（见文件头 ⚠️） */
let livePage = false;

/**
 * fake `chrome.storage` 的**异步 hop**。
 *
 * ## 为什么要加
 *
 * Lead 的验收要求：fake 的 storage 必须是**异步**的（"哪怕 1ms"），
 * 否则担心两次并发调用会"天然串起来"、掩盖竞态。
 *
 * ## ⚠️ 为什么是 `queueMicrotask` 而不是 `setTimeout(…, 1)`
 *
 * **实测**：用 `setTimeout` 时本文件两条 TTL 用例
 * （`心跳超过 TTL 后读作 null`、`恰好等于 TTL 边界时仍然有效`）直接
 * **5s 超时** —— 它们用 `vi.useFakeTimers()` 控 `Date.now()`，
 * 假定时器下 `setTimeout` 不会自己跑。
 * （改用 `shouldAdvanceTime` 会让 `Date.now()` 也随真实时间漂移，
 * TTL 边界断言变成 flaky，更糟。）
 *
 * ⇒ 用微任务：每次 storage 操作仍然**让出一次执行权**（这才能让两个并发调用
 * 交错），但不依赖定时器。
 *
 * ## ⚠️ 它不是检出竞态的**前提**（QA 用实验撤回过这条）
 *
 * QA 把延迟从 1ms 降到 0ms 重跑，`create` 仍是 **2** —— 因为
 * `openLoginWindowOnce()` 内部有多个 `await`（`isAllowedIncognitoAccess`、
 * `storage.get`、`diag`），微任务必然交错。
 * **检出竞态的充要条件是「同一 tick 启动两次调用」**（`Promise.all`）。
 * 这里加 hop 只是为了不必再去论证"同步 resolve 会不会串行"这个有争议的前提。
 *
 * ⚠️ 真机跨分区往返实测 ~20ms（见 `LOGIN_PING_TIMEOUT_MS` 注释）。
 * **不要**用加大这里的延迟去"模拟"它 —— 会让整个文件时长失控，
 * 而这条测试守的东西与延迟大小无关。
 */
function withLatency<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    queueMicrotask(() => resolve(value));
  });
}

function installChrome(opts: { inIncognitoContext?: boolean } = {}): void {
  const chromeStub = {
    storage: {
      local: {
        get: (key: string) => withLatency({ [key]: store.bag[key] }),
        set: (items: Record<string, unknown>) => {
          Object.assign(store.bag, items);
          /**
           * 模拟扫码窗口页面：它监听 `storage.onChanged`，看到 ping 就当场回 pong。
           *
           * 这里**直接调真实的 `writeLoginPong()`**（而不是手写一份 pong），
           * 因为被测的读方只认「pong.at >= ping.at」，用真实写方才能保证
           * 两端的载荷约定不会各自漂移。
           *
           * ⚠️ 只对 ping 键响应，否则会自己触发自己（pong 也是 set）。
           */
          if (livePage && mod.LOGIN_PING_KEY in items) {
            const ping = mod.parseLoginPing(items[mod.LOGIN_PING_KEY]);
            if (ping !== null) void mod.writeLoginPong(ping.nonce);
          }
          return withLatency(undefined);
        },
        remove: (key: string) => {
          delete store.bag[key];
          return withLatency(undefined);
        },
      },
    },
    extension: {
      isAllowedIncognitoAccess: () => Promise.resolve(true),
      inIncognitoContext: opts.inIncognitoContext ?? false,
    },
    windows: {
      getAll: () => Promise.resolve([{ id: 1 }]),
      create: vi.fn(() => {
        /**
         * 模拟**扫码窗口页面挂载**：`windows.create()` 之后页面加载、
         * `useEffect` 里 `beat()` 写第一次心跳。
         *
         * 少了这一步，"窗口开着"就没有任何线索，探测无从发起 —— 那测的是
         * 一个不存在的世界。`livePage === false` 时不写 = 窗口没起来 / 页面崩了。
         */
        if (livePage) {
          store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at: Date.now(), instance: 'mounted' };
        }
        return Promise.resolve(undefined);
      }),
      update: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    },
    tabs: { query: () => Promise.resolve([]) },
    runtime: { getURL: (p: string) => `chrome-extension://fake${p}` },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
}

// `diag` 走真实实现会写 storage 并串行化，这里替换成空实现，
// 避免探测测试被日志写入干扰（日志本身另有测试）
vi.mock('@platform/storage/diag-store', () => ({
  diag: () => Promise.resolve(),
  readDiag: () => Promise.resolve([]),
  instanceId: () => 'test',
  DIAG_KEY: 'pluma:diag',
  DIAG_LIMIT: 30,
}));

const mod = await import('../../../src/background/login-window');

beforeEach(() => {
  store.bag = {};
  livePage = false;
  mod.forgetLoginWindow();
  installChrome();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('心跳读写与过期', () => {
  it('写完能读回，且在 TTL 内', async () => {
    await mod.writeLoginHeartbeat('inst-1');
    const beat = await mod.readLoginHeartbeat();
    expect(beat).not.toBeNull();
    expect(beat?.instance).toBe('inst-1');
  });

  it('心跳超过 TTL 后读作 null（关窗后不能永远误判"还开着"）', async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await mod.writeLoginHeartbeat('inst-1');
    expect(await mod.readLoginHeartbeat()).not.toBeNull();

    // 前进到 TTL 之后 1ms
    vi.setSystemTime(now + mod.LOGIN_HEARTBEAT_TTL_MS + 1);
    expect(await mod.readLoginHeartbeat()).toBeNull();
  });

  it('恰好等于 TTL 边界时仍然有效（不早退）', async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await mod.writeLoginHeartbeat('inst-1');

    vi.setSystemTime(now + mod.LOGIN_HEARTBEAT_TTL_MS);
    expect(await mod.readLoginHeartbeat()).not.toBeNull();
  });

  it('clear 之后立刻读不到（不用等 TTL）', async () => {
    await mod.writeLoginHeartbeat('inst-1');
    await mod.clearLoginHeartbeat();
    expect(await mod.readLoginHeartbeat()).toBeNull();
  });

  it('心跳里带未来时间戳（时钟回拨）时读作 null，不当作"还活着"', async () => {
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at: Date.now() + 60_000, instance: 'x' };
    expect(await mod.readLoginHeartbeat()).toBeNull();
  });

  it('存储里是脏数据时读作 null 而不是抛错', async () => {
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at: 'not-a-number' };
    expect(await mod.readLoginHeartbeat()).toBeNull();
  });

  it('TTL 必须显著大于心跳间隔（配置自洽，防止正常节流被误判成"关了"）', () => {
    expect(mod.LOGIN_HEARTBEAT_TTL_MS).toBeGreaterThanOrEqual(mod.LOGIN_HEARTBEAT_INTERVAL_MS * 3);
  });

  /**
   * `readLoginHeartbeatRecord()` 是 task-47 新增的"不套 TTL"版本。
   *
   * 探测**必须**用它而不是 `readLoginHeartbeat()`：过期只说明"被节流了"，
   * 不说明窗口关了（活窗口可能 60 秒才写一次心跳）。用 TTL 版本当判据
   * 就会对**开着的**窗口建第二个窗。
   */
  it('`readLoginHeartbeatRecord` 不套 TTL：过期记录照样读得出来', async () => {
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = {
      at: Date.now() - mod.LOGIN_HEARTBEAT_TTL_MS - 5000,
      instance: 'stale',
    };
    expect(await mod.readLoginHeartbeat()).toBeNull();
    const record = await mod.readLoginHeartbeatRecord();
    expect(record?.instance).toBe('stale');
    expect(mod.isHeartbeatFresh(record)).toBe(false);
  });
});

describe('probeExistingLoginWindow：分区分流', () => {
  it('普通实例 + 页面应答 → 返回心跳', async () => {
    installChrome({ inIncognitoContext: false });
    livePage = true;
    await mod.writeLoginHeartbeat('inst-1');

    const beat = await mod.probeExistingLoginWindow();
    expect(beat?.instance).toBe('inst-1');
  });

  it('普通实例没有心跳 → null（然后调用方会去 create）', async () => {
    installChrome({ inIncognitoContext: false });
    expect(await mod.probeExistingLoginWindow()).toBeNull();
  });

  it('无痕实例即使页面会应答也**不探测**', async () => {
    // 这一条是整个方案的安全闸：split 下两个实例都收到点击。
    // 若无痕实例也去探测，它会读到**自己页面**的 pong → 返回 already-open →
    // **永远不创建窗口**，首次点击就再也开不出扫码窗口。
    installChrome({ inIncognitoContext: true });
    livePage = true;
    await mod.writeLoginHeartbeat('from-incognito');

    const beat = await mod.probeExistingLoginWindow();
    expect(beat).toBeNull();
  });
});

/**
 * ## ★★★ 本次（task-47）修复的**本体**
 *
 * 下面 5 条全部围绕同一件事：**"时间戳还新"≠"窗口还活着"**。
 *
 * 反例验证（实际跑过，见交付报告）：
 * 把 `probeExistingLoginWindow()` 里的 `const alive = await requestLoginWindowPong();`
 * 及其后的 `if (!alive) { … return null }` 换成 `return beat;`（即退回旧判据），
 * 第 1、2、3 条**同时变红**。
 */
describe('★★★ 冻结的心跳不许再当闸门（task-47）', () => {
  it('★★★ 心跳新鲜（30s）但页面已关 ⇒ 必须建新窗，不得 already-open', async () => {
    /**
     * 这就是用户报的场景：关窗时 React cleanup 没跑，心跳停在 30 秒前。
     * 旧代码读到 age=30000ms < 90s ⇒ already-open ⇒ **点了没反应**。
     */
    installChrome({ inIncognitoContext: false });
    livePage = false;
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at: Date.now() - 30_000, instance: 'frozen' };

    const res = await mod.openLoginWindow();

    expect(res.reason, '冻结的旧心跳又把窗口谎报成已开着 —— 用户会点了没反应').not.toBe(
      'already-open',
    );
    expect(chrome.windows.create, '关窗后必须能重新开出窗口').toHaveBeenCalledTimes(1);
  });

  it('★★★ 硬杀窗口（心跳 2 秒前刚写过，页面不可能再应答）⇒ 必须建新窗', async () => {
    /**
     * 硬杀（崩溃 / 任务管理器结束进程）时**任何**页面清理都不会跑，
     * 心跳会新鲜得不能再新鲜。这正是"只清心跳"永远修不掉的那一半 ——
     * 只有"问一句、没人答"才盖得住。
     */
    installChrome({ inIncognitoContext: false });
    livePage = false;
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at: Date.now() - 2_000, instance: 'killed' };

    const res = await mod.openLoginWindow();

    expect(res.reason, '硬杀后的残留心跳不能挡住重新开窗').not.toBe('already-open');
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('★★★ 心跳已过 TTL 但页面仍应答 ⇒ 仍然 already-open（不许多开第二个二维码）', async () => {
    /**
     * 反方向的代价：窗口被完全遮住时 Chromium 会把定时器压到每分钟一次，
     * **活着的**窗口也会留下 >90s 的旧心跳。若因为"过期"就直接建窗，
     * 用户会看到两个二维码 —— 本项目明确裁决过这比"少开一次"更糟。
     *
     * ## ⚠️ 这条同时是「心跳周期刷新未证实」的守卫（2026-11-15 真机采样）
     *
     * LevelDB 直读：整个存储里**只有 2 次**心跳写入（20:50:03 / 20:54:56，
     * 对应两次开窗），随后 32 秒内 age 单调增长、**零新写入**：
     *
     * ```
     * 20:55:19  writes=2  age=23.5s    20:55:43  writes=2  age=47.6s
     * 20:55:27  writes=2  age=31.6s    20:55:51  writes=2  age=55.6s
     * ```
     *
     * 采样时段窗口是否还开着**未确证**（`tasklist /v` 只看到主窗口有标题），
     * 所以既不能断定周期写坏了，也**绝不能假定它会刷新**。
     *
     * ⇒ 这条用例模拟的正是"周期刷新根本没发生"的形状：记录已过 TTL，
     *   而窗口是活的。任何人把判据改回「看 age / 看序号推进」都会让它变红。
     * 🔁 反向验证：`const beat = fresh ?? (await readLoginHeartbeatRecord());`
     *    → `const beat = fresh;` ⇒ 本条必红（实际测过）。
     */
    installChrome({ inIncognitoContext: false });
    livePage = true;
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = {
      at: Date.now() - mod.LOGIN_HEARTBEAT_TTL_MS - 5000,
      instance: 'throttled-but-alive',
    };

    const res = await mod.openLoginWindow();

    expect(res.reason, '被节流的活窗口被判成"关了"→ 又开了一个窗口').toBe('already-open');
    expect(chrome.windows.create, '窗口还开着，不许再 create 一个').not.toHaveBeenCalled();
  });

  /**
   * ## 判据对「周期刷新从未发生」必须免疫
   *
   * 上一条的极端版本：页面**只在挂载时写了一次**心跳，之后 `setInterval`
   * 一次都没触发（这就是真机采样里看到的"writes=2 且 age 单调增长"的形状，
   * 只是我们无法证明当时窗口是死是活）。
   *
   * 只要窗口还活着，pong 就来 ⇒ 必须 already-open。这条不许依赖任何时间量。
   */
  it('★★★ 只有挂载那一次心跳（周期写从未触发）+ 页面应答 ⇒ 仍判 already-open', async () => {
    installChrome({ inIncognitoContext: false });
    livePage = true;
    // 唯一一条记录：很久以前写的（模拟"周期刷新完全没工作"）
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = {
      at: Date.now() - 6 * 60 * 60 * 1000,
      instance: 'mount-only',
    };

    const res = await mod.openLoginWindow();

    expect(res.reason, '把"周期刷新"当成前提了 —— 活窗口被当成关了').toBe('already-open');
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('★★ 判定"已关"时顺手清掉残留心跳（下一次点击少等 600ms）', async () => {
    installChrome({ inIncognitoContext: false });
    livePage = false;
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at: Date.now() - 1000, instance: 'dead' };

    await mod.probeExistingLoginWindow();

    expect(
      store.bag[mod.LOGIN_HEARTBEAT_KEY],
      '残留心跳没清 —— 下次点击还要再等一次 ping 超时',
    ).toBeUndefined();
  });

  it('★ 探测是只读的：页面应答时**不许**改写心跳（否则会伪造"刚活着"）', async () => {
    installChrome({ inIncognitoContext: false });
    livePage = true;
    const at = Date.now() - 20_000;
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at, instance: 'alive' };

    await mod.probeExistingLoginWindow();

    expect((store.bag[mod.LOGIN_HEARTBEAT_KEY] as { at: number }).at).toBe(at);
  });
});

/**
 * ## ★★★ 这两条守的是 `already-open` 判据 + "不重复建窗"（2026-11-15，task-47）
 *
 * ### ⚠️ 它们**不是**「再点一次」的许可证 —— 那句话已经不在文案里了
 *
 * 本轮中途曾把 `ASSUMED_TEXT` 写成「还是有**没有**就再点一次」，并用下面这两条
 * 真机日志去支撑。**那个支撑是错的**（Lead 终裁撤回，QA 指出）：
 *
 * ```
 * 21:12:45  probe/heartbeat none → create → assumed            （开窗）
 * 21:12:48  record age=2276ms → ping/pong → already-open       （窗口开着时再点：未建第二个）
 * 21:12:52  record age=6731ms → ping/pong → already-open       （再点一次：仍未建第二个）
 * 21:12:58  probe/heartbeat none → create（关窗后立刻点，秒开）
 * ```
 *
 * 这三行走的是 **`already-open` 路径**（已证明有一个活页面刚应答过），
 * 而那句话说在 **`assumed` 路径**上（`create()` 没抛错、**一条证据都没有**）。
 * **两个状态不可外推**：`assumed` 下"页面始终不写心跳"子情形仍在，
 * 且串行第二次点击会读到"无心跳"⇒ 直接建窗（见 `login-outcome.ts` 的
 * `#### 已知残余竞态`）。⇒ 文案里**没有**那句话了（`ASSUMED_TEXT` 现 36 汉字）。
 *
 * ### 那这两条还守什么
 *
 * 1. `already-open` 判据成立时**不许**再建窗（真机 21:12:48/52 的行为被钉住）；
 * 2. 旧 pong 不许冒充应答（右条）。
 *
 * 任何一条变红，说明 `already-open` 路径**开始多开窗口**了 —— 那是本次修复的卖点，
 * 必须当 P0 处理，**不是**"改测试"。
 */
describe('★★★ 连续点击 / 残留 pong：两条端到端守卫（走真实 openLoginWindow）', () => {
  it('★★★ 窗口活着时连续两次点击：第二次必须 already-open，windows.create 总共只调用 1 次', () => {
    /**
     * 判据是**累计只 create 一次**：只看第二次的 reason 不够，
     * "already-open + 又 create 了一个" 同样是灾难。
     *
     * ⚠️ **不覆盖**"页面挂载 > 400ms"的情形：fixture 的 `create()` 是
     * **立刻**写心跳（0ms 挂载），比真机乐观。真机上 `create()` 到
     * `beat()` 落库之间有空档，串行的第二次点击会读到"无心跳"⇒ 直接建窗。
     * 那是**已知残余竞态**，记录在 `login-outcome.ts` 的 `#### 已知残余竞态`，
     * 本条**盖不住**它 —— 别以为这条绿了就等于那段空档安全。
     *
     * 🔁 反向验证 RV8：把 `const alive = await requestLoginWindowPong();`
     * 改成 `const alive = false;`（探测永远判"不在"）⇒ 本条变红
     * （第二次也 create ⇒ 累计 2 次）。
     */
    installChrome({ inIncognitoContext: false });
    livePage = true;
    expect.assertions(3);

    return (async () => {
      const first = await mod.openLoginWindow();
      /** 第一次：没有心跳记录 ⇒ 立刻建窗（快路径不付 ping 延迟） */
      expect(first.reason, '第一次应该去建窗').not.toBe('already-open');

      /** 窗口"挂载完成"（fixture 的 create 里已写心跳），用户又点了一次 */
      const second = await mod.openLoginWindow();
      expect(second.reason, '窗口开着时再点必须 already-open').toBe('already-open');
      expect(
        chrome.windows.create,
        '第二次点击又建了一个窗口 —— 那正是 task-44 真机的两个二维码',
      ).toHaveBeenCalledTimes(1);
    })();
  });

  it('★★★ 残留的**旧 pong**（早于本次 ping）+ 页面不在 ⇒ 必须建新窗，不得 already-open', () => {
    /**
     * ## QA 发现的测试洞（2026-11-15）
     *
     * `requestLoginWindowPong()` 的判据是 `pong.at >= ping.at`。QA 把条件改成
     * `pong !== null` 时，只有 `login-window-pong.test.ts` 的一条单元用例变红，
     * `login-heartbeat-probe.test.ts` **全绿** —— 因为它从来不往 store 里放残留 pong。
     *
     * 而"上一轮窗口留下的旧 pong"恰恰是**最可能出现的脏数据**：
     * 关窗后它还在存储里，若判据只看 `pong !== null`，就会把"没有窗口"
     * 判成"窗口还开着"⇒ 用户点了没反应（旧 bug 原样复发，只是脏数据换了个键）。
     *
     * 🔁 反向验证 RV7：把 `pong.at >= ping.at` 改成 `pong !== null` ⇒ 本条变红。
     */
    installChrome({ inIncognitoContext: false });
    livePage = false;
    /** 上一轮窗口留下的记录与 pong */
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = { at: Date.now() - 5_000, instance: 'prev-window' };
    store.bag[mod.LOGIN_PONG_KEY] = {
      nonce: 'stale-from-previous-window',
      at: Date.now() - 60_000,
    };

    return (async () => {
      const res = await mod.openLoginWindow();
      expect(res.reason, '旧 pong 被当成应答 ⇒ 没窗口却报 already-open').not.toBe('already-open');
      expect(chrome.windows.create, '窗口不在，必须建出来').toHaveBeenCalledTimes(1);
    })();
  });
});

/**
 * ## ★★★ in-flight 去重：**同一时刻**的并发点击只建一个窗口（P0，2026-11-15）
 *
 * ### 为什么这条是 P0
 *
 * `entrypoints/background.ts` 的 `login/open` 分支是
 * `handleLoginOpen().then(sendResponse); return true;` —— **完全并发、不排队**；
 * 而 `currentWindowId` 在 split 下恒为 `null`，探测又要先花 ~120ms。
 *
 * ⇒ QA 用真实 `openLoginWindow()` 探针实测（两次**并发**调用）：
 *
 * | 场景 | `windows.create` |
 * | --- | --- |
 * | 窗口开着（页面应答） | 0 ✅ |
 * | 关窗后残留心跳（页面不在） | **2** ❌ |
 * | 从没开过窗 | **2** ❌ |
 *
 * **这不是理论风险**：这个用户报 bug 时的原始行为就是连点
 * （真机日志：13 秒内 14 次点击）。旧 build 的连点被冻结心跳吞掉
 * （所以"没反应"）；新 build 不再吞 —— 不补这条，同样的连点就变成**连开窗口**。
 *
 * ⚠️ 判据刻意是**累计 create 次数**，不是 `reason`：这次 bug 的伤害形态就是
 * "`create` 被多调了一次"。
 */
describe('★★★ in-flight 去重：并发点击只建一个窗口', () => {
  it('★★★ 无心跳 + 两次**并发**调用 ⇒ windows.create 只被调用 1 次，两个返回值一致', async () => {
    /**
     * 🔁 反向验证 RV10：删掉 `openLoginWindow()` 里的
     * `if (inflight !== null) { return inflight; }` ⇒ 本条变红（create 变 2 次）。
     */
    installChrome({ inIncognitoContext: false });
    livePage = false;

    const results = await Promise.all([mod.openLoginWindow(), mod.openLoginWindow()]);

    expect(
      chrome.windows.create,
      '并发点击各建了一个窗口 —— 用户看到两个二维码',
    ).toHaveBeenCalledTimes(1);
    expect(results[0], '两次调用必须拿到同一个结果').toEqual(results[1]);
    expect(results[0]?.reason).not.toBe('already-open');
  });

  it('★★★ 三次并发也只建一个（不是只处理两次的特例）', async () => {
    installChrome({ inIncognitoContext: false });
    livePage = false;

    await Promise.all([mod.openLoginWindow(), mod.openLoginWindow(), mod.openLoginWindow()]);

    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('★★★ create 抛错后**再调一次仍能建窗**（finally 必须清空，不许缓存 rejected promise）', async () => {
    /**
     * 🔁 反向验证 RV10b：删掉 `finally(() => { inflight = null; })`
     * ⇒ 本条变红（后续每次点击都拿到那个已 settle 的 Promise ⇒ 永久卡死）。
     *
     * 失败形态：第一次 `create()` 抛错 ⇒ `inflight` 若不清，之后**每一次**
     * 点击都拿到那个已 settle 的 Promise ⇒ 用户怎么点都建不出窗口。
     *
     * ⚠️ 断言 `reason !== 'unknown'` 是 Lead 明确要求的第二条：
     * 第二个调用者**不允许**继承前一次的失败（`unknown` 就是"建窗失败"的兜底）。
     */
    installChrome({ inIncognitoContext: false });
    livePage = false;

    const createSpy = chrome.windows.create as unknown as {
      mockImplementationOnce: (fn: () => Promise<unknown>) => void;
    };
    createSpy.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const first = await mod.openLoginWindow();
    expect(first.ok, 'create 抛错时不该报成功').toBe(false);

    const second = await mod.openLoginWindow();
    expect(second.ok, 'finally 没清空 ⇒ 之后再也建不出窗口').toBe(true);
    expect(second.reason, '第二个调用者继承了前一次的失败（unknown）').not.toBe('unknown');
    expect(chrome.windows.create, '第二次必须真的又调了一次 create').toHaveBeenCalledTimes(2);
  });

  it('★★ 串行两次（第一个已完成）**不**被 in-flight 拦住 —— 关窗后必须能立刻重开', async () => {
    /**
     * 这个方向同样重要：in-flight **不是时间窗口**。
     * 若有人把判据改成 `Date.now() - lastCreateAt < N`（冷却期），本条必红 ——
     * 而那正是**验收标准 1**（关窗后 ≤5 秒必须能开新窗口）。
     */
    installChrome({ inIncognitoContext: false });
    livePage = false;

    await mod.openLoginWindow();
    await mod.openLoginWindow();

    expect(
      chrome.windows.create,
      '第二次串行点击被拦住了 —— 关窗后点不出窗口',
    ).toHaveBeenCalledTimes(2);
  });
});

describe('openLoginWindow：第二次点击不再静默', () => {
  it('心跳活着（页面应答）时返回 already-open，且**不调用** windows.create', async () => {
    installChrome({ inIncognitoContext: false });
    livePage = true;
    await mod.writeLoginHeartbeat('alive');

    const res = await mod.openLoginWindow();

    expect(res.reason).toBe('already-open');
    expect(res.ok).toBe(true);
    // 关键：不许再开一个窗口（用户会看到两个二维码）
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('心跳过期且没人应答后照常开窗（关窗后必须还能重新打开）', async () => {
    installChrome({ inIncognitoContext: false });
    // 直接写入一个**过期**的心跳，而不是用假时钟推进：
    // `openLoginWindow()` 里有真实的 `setTimeout(400)` 等待，
    // 开假时钟会让它一直等 → 测试超时。这里只关心"过期后不返回 already-open"。
    store.bag[mod.LOGIN_HEARTBEAT_KEY] = {
      at: Date.now() - mod.LOGIN_HEARTBEAT_TTL_MS - 1000,
      instance: 'stale',
    };

    const res = await mod.openLoginWindow();

    expect(res.reason).not.toBe('already-open');
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('无痕实例不因心跳而跳过建窗（否则首次点击就开不出窗口）', async () => {
    installChrome({ inIncognitoContext: true });

    const res = await mod.openLoginWindow();

    expect(res.reason).not.toBe('already-open');
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('权限读到 false 时**在探测之前**就返回 incognito-disabled（2026-11-15 task-46 口径）', async () => {
    /**
     * ## ⚠️ 口径反转了（第二次），请勿按旧注释改回去
     *
     * - 2026-11-12（task-32）：本条断言「权限读 false **不**报 incognito-disabled，
     *   照常探测、照常建窗」，理由是 22 次**跨实例**读取里 true 10 / false 12、翻转 15 次。
     * - 2026-11-15（task-46）：按 **SW 实例分组**重看同一批日志，实例 `wo1xrs` 连续
     *   `isAllowedIncognitoAccess=false` **90/90** 条、`probe/instance incognito=false`
     *   **90/90** 条，一条 true 都没有；用户本人也确认权限当时是**关着的**。
     *   ⇒ 那个"翻转"是把「权限真的没开」和「不同实例的读数」混成了一条时间序列。
     *   不拦的代价是：权限关着仍 `create({incognito:true})` ⇒ 无痕分区没有本扩展
     *   ⇒ `ERR_BLOCKED_BY_CLIENT` 废页 ⇒ `create()` 返回 undefined ⇒ 报 `assumed`「成功」。
     *
     * 本条现在守的是**顺序**：权限闸门在探测**之前**。
     * 心跳活着也必须先被权限拦下 —— 否则窗口根本没建，却因为别处残留的心跳
     * 被改判成 `already-open`，用户还是看不到窗口。
     */
    installChrome({ inIncognitoContext: false });
    livePage = true;
    await mod.writeLoginHeartbeat('alive');
    (
      chrome as unknown as { extension: { isAllowedIncognitoAccess: () => Promise<boolean> } }
    ).extension.isAllowedIncognitoAccess = () => Promise.resolve(false);

    const res = await mod.openLoginWindow();
    expect(res.reason, '权限关着必须报 incognito-disabled（不是 assumed / already-open）').toBe(
      'incognito-disabled',
    );
    /** 心跳活着也不许改判：窗口没建，already-open 是谎报 */
    expect(res.reason).not.toBe('already-open');
    /** 而且一次 create 都不许发生 */
    expect(chrome.windows.create, '权限关着还去建无痕窗').not.toHaveBeenCalled();
  });

  it('closeLoginWindow 清掉心跳，让下一次点击不必等探测超时', async () => {
    installChrome({ inIncognitoContext: false });
    await mod.writeLoginHeartbeat('alive');

    await mod.closeLoginWindow();

    expect(await mod.readLoginHeartbeat()).toBeNull();
  });
});

describe('isIncognitoInstance 兜底', () => {
  it('API 抛错时当作普通实例（false），不抛到调用方', async () => {
    installChrome({ inIncognitoContext: false });
    Object.defineProperty(
      (globalThis as unknown as { chrome: Record<string, unknown> }).chrome['extension'] as object,
      'inIncognitoContext',
      {
        get() {
          throw new Error('not supported');
        },
      },
    );
    await mod.writeLoginHeartbeat('inst-1');

    // 不向外抛错即可；读不读得到心跳不是这一条要断言的重点
    await expect(mod.probeExistingLoginWindow()).resolves.toBeDefined();
  });
});
