/**
 * 诊断日志 —— 一个存在 `storage.local` 里的环形缓冲。
 *
 * ## 为什么在 `platform/`
 *
 * 它原来是 `background/login-window.ts` 的一部分（因为最早只有登录窗口用它）。
 * 但 options 的「诊断」分区也要读日志，而 **`entrypoints` 不许依赖 `background`** ——
 * 所以实现下沉到 `platform/storage`，两边都从这里取。
 *
 * ## 已知缺陷：并发写会丢条目
 *
 * `diag()` 是"读整个数组 → push → 写回"。`incognito: "split"` 下普通/无痕是**两个
 * SW 实例**，共享同一个 `storage.local`：两个实例同时写，后写的覆盖先写的，
 * 表现为**日志莫名其妙缺一段**。
 *
 * 保持 30 条不解决这个问题，只是让它发生得少一点。真要修得**按实例分 key、
 * 读取时合并**（`from` 字段已经记了实例 ID，具备合并条件）。现在不做，
 * 是因为日志只用于排障，丢几条不至于误导 —— 但如果以后发现"日志跳着缺"，
 * 该修的是并发，不是扩容。
 */

export const DIAG_KEY = 'pluma:diag';

/** 保留条数。30 条够覆盖"刚才发生了什么"（一次页面加载约产生 8-10 条） */
export const DIAG_LIMIT = 30;

export interface DiagEntry {
  at: number;
  step: string;
  detail?: string;
  /** 哪个实例写的：`split` 模式下普通/无痕是两个独立 SW，靠它区分 */
  from?: string;
}

/**
 * 本实例的随机 ID。
 *
 * 模块级变量在同一个 background 进程里是稳定的，而 split 模式下普通/无痕
 * 是两个独立进程 → 各自生成不同的 ID。
 * **这比任何 API 探测都可靠**：不依赖"能否看到对方分区"这类不确定行为。
 */
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);

export function instanceId(): string {
  return INSTANCE_ID;
}

/**
 * 写入队列 —— 把并发的 `diag()` 串行化。
 *
 * ## 为什么必须有（2026-10-27 实测复现的真 bug）
 *
 * `diag()` 是典型的 **read-modify-write**：
 *
 * ```
 * get() → list.push() → set()
 * ```
 *
 * 多个 content script 同时上报时，两次 get 会读到**同一份快照**，
 * 后写的那个把先写的整条覆盖掉。
 *
 * 实测（5 个页面各 6 条，共 30 条）：**只存下 6 条，丢了 24 条**。
 * 表现是"诊断日志看不出问题"—— 因为大部分记录根本没落盘。
 *
 * ## 为什么是 Promise 链而不是锁
 *
 * 这里只有单线程（一个 SW 实例一个事件循环），不需要真锁。
 * 把每次写入挂在上一次之后，就保证"读到的是上一条写完的结果"。
 *
 * ## ⚠️ 但**绝不能**让"一次卡住"变成"永久悬挂"（2026-11-10 修）
 *
 * ### 原实现的问题
 *
 * 原来 `diag()` 和 `trace()` **共用同一个模块级 `pending`**：
 *
 * ```ts
 * let pending: Promise<void> = Promise.resolve();
 * export function diag(...)  { pending = pending.then(...); return pending; }
 * export function trace(...) { pending = pending.then(...); return pending; }   // ← 同一条链
 * ```
 *
 * 只要链上**任何一次** `chrome.storage.local.get/set` 卡住（SW 挂起、storage 争用），
 * 整条链就永久悬挂，之后**所有** `diag()` / `trace()` 都返回那个卡住的 Promise。
 *
 * 后果是**诊断功能整体失效且无感知** —— 日志一条不写，而调用方拿到的
 * 只是"一个永远不 resolve 的 Promise"（多数地方 `void` 掉，看起来一切正常）。
 * 更糟的是它会让后续排查**全部误判**：看到"日志里没有"就以为"代码没执行"。
 *
 * ### 现在的做法：**每类通道各自一条链 + 每次写入都有超时**
 *
 * - `diag()` 一条链，`trace()` 一条链 —— 互不牵连
 * - **每次写入与超时竞速**（`WRITE_TIMEOUT_MS`）：超时后链**继续往下走**，
 *   不会因为一次卡住而把后面全堵死
 * - 语义完全不变：仍是 30 条环形缓冲、时间正序、静默失败
 */
export const WRITE_TIMEOUT_MS = 3000;

/** `diag()` 专用链 */
let diagChain: Promise<void> = Promise.resolve();
/** `trace()` 专用链（与 `diag()` 分开，互不牵连） */
let traceChain: Promise<void> = Promise.resolve();

/**
 * 把一次写入包成"最多等 `WRITE_TIMEOUT_MS`"。
 *
 * ⚠️ 超时**不抛错**，resolve 掉 —— 目的是让链继续，而不是报告失败。
 * 诊断本身失败不需要任何人知道（调用方全是 `void`）。
 */
function withTimeout(task: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // 不清理句柄：它最多存活 3s，清理逻辑只会多出错面
    setTimeout(done, WRITE_TIMEOUT_MS);
    void task().then(done, done);
  });
}

/** 记录一条诊断信息（只保留最近 `DIAG_LIMIT` 条） */
export function diag(step: string, detail?: string): Promise<void> {
  diagChain = diagChain.then(() =>
    withTimeout(async () => {
      try {
        const bag = await chrome.storage.local.get(DIAG_KEY);
        const list = (bag[DIAG_KEY] as DiagEntry[] | undefined) ?? [];
        list.push({
          at: Date.now(),
          step,
          from: INSTANCE_ID,
          ...(detail === undefined ? {} : { detail }),
        });
        await chrome.storage.local.set({ [DIAG_KEY]: list.slice(-DIAG_LIMIT) });
      } catch {
        // 诊断失败不能影响主流程
      }
    }),
  );
  return diagChain;
}

/**
 * 读取诊断日志，**时间正序（最旧在前）**。
 *
 * ⚠️ 这是**数据层**的顺序，与写入顺序一致，导出诊断包也按它。
 * 界面展示是**最新在上**，倒序在渲染层做（`options/sections/diagnostics.tsx`
 * 的 `LogList`）。**别为了显示去改这里** —— 会让导出文件和分析脚本跟着变。
 */
export async function readDiag(): Promise<DiagEntry[]> {
  try {
    const bag = await chrome.storage.local.get(DIAG_KEY);
    return (bag[DIAG_KEY] as DiagEntry[] | undefined) ?? [];
  } catch {
    return [];
  }
}

// ─────────────────────────── 定位追踪通道 ───────────────────────────

/**
 * 定位追踪的 storage key —— **与主日志分开，独立存活**。
 *
 * ## 为什么必须有单独通道（2026-11-10 第七轮，smoke 发现）
 *
 * `diag()` 是 30 条环形缓冲，而 `page/quality` 在播放中**每几秒写一轮、
 * 一次 3 条** —— 几分钟就把缓冲冲干净。
 *
 * 于是出现了两次误判：调��者看到"没有任何 `onMessage` / `entered` 日志"，
 * 就以为"这条代码没执行"，而实际上**它执行了，只是被挤掉了**。
 *
 * 第七轮之前的排查因此反复跑偏。
 *
 * ## 两个通道的设计
 *
 * | 通道 | 语义 | 保留 |
 * | --- | --- | --- |
 * | `diag()` → `pluma:diag` | 事件流（发生过什么） | 30 条环形 |
 * | **`trace()`** → `pluma:diag-trace` | **最近一次的定位结果**（覆盖写） | **1 条** |
 *
 * 覆盖写是刻意的：定位只需要"现在这一点是什么"，不需要历史。
 * 这保证**永远看得见最近一次**，不会被任何高频日志挤掉。
 */
export const DIAG_TRACE_KEY = 'pluma:diag-trace';

/** 追踪记录（覆盖写，只有最近一条） */
export interface DiagTrace {
  at: number;
  /** 哪一段（如 `diag/facts`） */
  step: string;
  /** 结果摘要（已截断，不会很大） */
  detail: string;
  /** 哪个实例写的（split 模式下普通/无痕是两个 SW） */
  from: string;
}

/** `detail` 的最大长度 —— 覆盖写要保证一条记录不会把 storage 撑大 */
export const DIAG_TRACE_DETAIL_MAX = 600;

/**
 * 写一条定位追踪（**覆盖**上一条，不追加）。
 *
 * ⚠️ 失败静默：定位通道坏掉不应该影响主流程。
 *
 * @param step 哪一段
 * @param detail 结果摘要（会被截断到 `DIAG_TRACE_DETAIL_MAX`）
 */
export function trace(step: string, detail: string): Promise<void> {
  traceChain = traceChain.then(() =>
    withTimeout(async () => {
      try {
        const entry: DiagTrace = {
          at: Date.now(),
          step: step.slice(0, 60),
          detail: String(detail).slice(0, DIAG_TRACE_DETAIL_MAX),
          from: INSTANCE_ID,
        };
        await chrome.storage.local.set({ [DIAG_TRACE_KEY]: entry });
      } catch {
        /* 定位失败不影响主流程 */
      }
    }),
  );
  return traceChain;
}

/** 读当前那条追踪记录；没有或读失败返回 `null` */
export async function readDiagTrace(): Promise<DiagTrace | null> {
  try {
    const bag = await chrome.storage.local.get(DIAG_TRACE_KEY);
    const raw = bag[DIAG_TRACE_KEY] as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.step !== 'string' || typeof o.detail !== 'string') return null;
    return {
      at: typeof o.at === 'number' ? o.at : 0,
      step: o.step,
      detail: o.detail,
      from: typeof o.from === 'string' ? o.from : '?',
    };
  } catch {
    return null;
  }
}
