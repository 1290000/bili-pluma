/**
 * 跨分区存活应答（ping / pong）—— 2026-11-15 task-47 新增
 *
 * ## 它解决的是哪一半
 *
 * 心跳（`LOGIN_HEARTBEAT_KEY`）证明的是"**曾经**有过一个扫码窗口"。
 * 用户关窗时文档被直接销毁，React 的 cleanup 不跑 ⇒ 心跳冻结在最后一次写入 ⇒
 * 90 秒内普通实例一直以为窗口还开着 ⇒ 点击既不建窗也不提示。
 *
 * 关窗是**事件**，不是时长 —— 所以拿"时间戳还新"当判据永远修不干净
 * （缩 TTL 只会把"活窗口被判成关"换进来，用户看到两个二维码）。
 *
 * ⇒ 换判据：普通实例写一个 ping，**页面还活着就当场写 pong**。
 * `chrome.storage.onChanged` 是**浏览器投递的事件，不是定时器**
 * ⇒ 不受后台节流影响；页面没了就没人应答。
 *
 * ## 这张文件守什么
 *
 * 读方判据（`pong.at >= ping.at`）的**四条边界**，每条都对着一种真实失败形态。
 * 反向验证：把判据换成 `pong !== null`（或换成 `nonce` 相等）⇒ 下面
 * 「上一轮的旧 pong 不算应答」「并发时别人的 pong 也算应答」两条之一必红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStorage {
  bag: Record<string, unknown>;
}

const store: FakeStorage = { bag: {} };

/** 每次 set ping 时模拟扫码窗口页面的反应。默认「页面不在」（不写 pong） */
let respond: (ping: { nonce: string; at: number }) => void = () => {};

/** set 直接失败（模拟存储不可写） */
let setFails = false;

function installChrome(): void {
  const chromeStub = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store.bag[key] }),
        set: (items: Record<string, unknown>) => {
          if (setFails) return Promise.reject(new Error('QUOTA_BYTES exceeded'));
          Object.assign(store.bag, items);
          if (mod.LOGIN_PING_KEY in items) {
            const ping = mod.parseLoginPing(items[mod.LOGIN_PING_KEY]);
            if (ping !== null) respond(ping);
          }
          return Promise.resolve();
        },
        remove: (key: string) => {
          delete store.bag[key];
          return Promise.resolve();
        },
      },
    },
    extension: {
      isAllowedIncognitoAccess: () => Promise.resolve(true),
      inIncognitoContext: false,
    },
    windows: {
      getAll: () => Promise.resolve([{ id: 1 }]),
      create: vi.fn(() => Promise.resolve(undefined)),
      update: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    },
    tabs: { query: () => Promise.resolve([]) },
    runtime: { getURL: (p: string) => `chrome-extension://fake${p}` },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
}

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
  setFails = false;
  respond = () => {};
  installChrome();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseLoginPing：脏数据当没收到，不抛错', () => {
  it('合法载荷原样返回', () => {
    expect(mod.parseLoginPing({ nonce: 'abc', at: 123 })).toEqual({ nonce: 'abc', at: 123 });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'abc'],
    ['数字', 42],
    ['空对象', {}],
    ['缺 nonce', { at: 1 }],
    ['nonce 为空串', { nonce: '', at: 1 }],
    ['nonce 类型不对', { nonce: 1, at: 1 }],
    ['缺 at', { nonce: 'a' }],
    ['at 是字符串', { nonce: 'a', at: '1' }],
    ['at 是 NaN', { nonce: 'a', at: Number.NaN }],
    ['at 是 Infinity', { nonce: 'a', at: Number.POSITIVE_INFINITY }],
  ])('脏数据（%s）→ null', (_label, value) => {
    expect(mod.parseLoginPing(value)).toBeNull();
  });
});

describe('pong 的读写', () => {
  it('写进去能读回来', async () => {
    await mod.writeLoginPong('nonce-1');
    const pong = await mod.readLoginPong();
    expect(pong?.nonce).toBe('nonce-1');
    expect(typeof pong?.at).toBe('number');
  });

  it('没写过 → null', async () => {
    expect(await mod.readLoginPong()).toBeNull();
  });

  it('存储里是脏数据 → null（不抛错）', async () => {
    store.bag[mod.LOGIN_PONG_KEY] = { nonce: 123, at: 'x' };
    expect(await mod.readLoginPong()).toBeNull();
  });

  it('pong 与心跳**不是同一个键**（别把两者混成一条记录）', () => {
    expect(mod.LOGIN_PONG_KEY).not.toBe(mod.LOGIN_HEARTBEAT_KEY);
    expect(mod.LOGIN_PING_KEY).not.toBe(mod.LOGIN_HEARTBEAT_KEY);
    expect(mod.LOGIN_PING_KEY).not.toBe(mod.LOGIN_PONG_KEY);
  });
});

describe('★★★ requestLoginWindowPong 的四条边界', () => {
  it('★★★ 页面已不在（没人应答）→ false', async () => {
    /**
     * 这是"关窗 / 崩溃 / 硬杀"的唯一必要输出：**必须** false，
     * 否则调用方会去建窗而这里却报"已开着"。
     */
    respond = () => {};
    expect(await mod.requestLoginWindowPong()).toBe(false);
  });

  it('★★★ 页面在场（当场回 pong）→ true', async () => {
    respond = (ping) => void mod.writeLoginPong(ping.nonce);
    expect(await mod.requestLoginWindowPong()).toBe(true);
  });

  it('★★★ 上一轮点击留下的**旧 pong** 不算应答（否则关窗后永远开不出来）', async () => {
    /**
     * 失败形态：上次探测留下的 pong 还在存储里。若判据写成 `pong !== null`，
     * 一次"没人应答"也会被判成活着 ⇒ 关窗后 600ms 白等完又报 already-open。
     */
    respond = (ping) => {
      // 写一条"名字对得上、但时间更早"的 pong
      store.bag[mod.LOGIN_PONG_KEY] = { nonce: ping.nonce, at: Date.now() - 60_000 };
    };
    expect(await mod.requestLoginWindowPong()).toBe(false);
  });

  it('★★★ 别人的 pong（时间更晚、名字不同）算应答 —— 这是并发安全的前提', async () => {
    /**
     * 失败形态：两次点击几乎同时发 ping A(t1) / B(t2)，页面先回 A 再回 B，
     * pong 被覆盖成 B 的。若判据是 `nonce` 相等，A 会判"没人应答" ⇒
     * **又开一个窗口**（正是任务卡要消灭的副作用）。
     *
     * `pong.at >= ping.at` 表达的是"我问完之后它还写过字"，对并发天然安全。
     */
    respond = () => {
      store.bag[mod.LOGIN_PONG_KEY] = { nonce: 'someone-else', at: Date.now() + 1000 };
    };
    expect(await mod.requestLoginWindowPong()).toBe(true);
  });

  it('★★★ pong.at **恰好等于** ping.at 也算应答（判据是 `>=` 不是 `>`）', async () => {
    /**
     * 边界：ping 与 pong 落在**同一毫秒**完全可能（跨分区往返 ~20ms，
     * 但 `Date.now()` 精度是 1ms，快机器上撞同一毫秒很正常）。
     *
     * 若判据写成 `pong.at > ping.at`，这种**正常应答**会被判成"页面不在"
     * ⇒ 又开一个窗口。这条把 `>=` 钉住。
     *
     * ⚠️ 本条钉住的是**行为**（"同一毫秒的应答必须算应答"），不是某一处判据：
     * `respond` 在 `set` 里同步写 pong，首读必然命中；即使首读那处判据被改成 `>`
     * 轮询循环也会兜住 ⇒ **本条仍然绿**（2026-11-15 实测）。
     * 那**不是**假绿：首读只是省一次 100ms 轮询的优化，改错它不影响结论、只影响延迟。
     * 真正承重的是轮询那处 —— 由下一条用例单独钉住。
     *
     * 🔁 反向验证：把**两处**判据同时改成 `pong.at > ping.at` ⇒ 本条变红。
     */
    respond = (ping) => {
      store.bag[mod.LOGIN_PONG_KEY] = { nonce: ping.nonce, at: ping.at };
    };
    expect(await mod.requestLoginWindowPong()).toBe(true);
  });

  it('★★★ 同一判据在**轮询分支**也必须成立（pong 晚于首读到达时才走到那里）', async () => {
    /**
     * ## 为什么必须单独一条 —— 这是一次真实的假绿
     *
     * `at >= ping.at` 在 `requestLoginWindowPong()` 里写了**两遍**：
     * 首读一次（`immediate.at >= ping.at`）、轮询循环里又一次（`pong.at >= ping.at`）。
     * 上一条用例的 `respond` 是**同步**写 pong，首读必然命中 ⇒ **永远走不到轮询那一处**。
     *
     * 后果（QA 2026-11-15 实测）：只把**轮询**那处改成 `>`，全量 119 文件 /
     * 1951 用例**一条都不红** —— 而该处注释还写着"改成 `>` 必然变红"。
     * 那种测试比没有更糟：它替一处真实判据作伪证。
     *
     * 本条让 pong **晚 20ms** 才落库（首读必然错过），逼迫走轮询分支。
     *
     * 🔁 反向验证：把**轮询**里那处判据改成 `pong.at > ping.at` ⇒ 本条变红。
     */
    respond = (ping) => {
      setTimeout(() => {
        store.bag[mod.LOGIN_PONG_KEY] = { nonce: ping.nonce, at: ping.at };
      }, 20);
    };
    expect(await mod.requestLoginWindowPong()).toBe(true);
  });

  it('★★ 写 ping 失败 → false（**不许**乐观当活着）', async () => {
    setFails = true;
    expect(await mod.requestLoginWindowPong()).toBe(false);
  });

  it('★ 等 pong 的时间上限必须短到用户察觉不到（≤1.5s）', () => {
    // 它落在"点扫码"这条同步路径上：用户只点了一下，多等几秒就是"卡"。
    // 同时它必须明显大于一次跨分区 storage 往返（毫秒级），否则会误判"不在"。
    expect(mod.LOGIN_PING_TIMEOUT_MS).toBeGreaterThanOrEqual(300);
    expect(mod.LOGIN_PING_TIMEOUT_MS).toBeLessThanOrEqual(1500);
  });
});
