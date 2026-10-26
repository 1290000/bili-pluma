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
 * ## 为什么队列不会无限增长
 *
 * 每完成一次就从链上摘掉，`pending` 始终只指向最后一次。
 * 写入本身很快（一个 local.set），不会积压。
 */
let pending: Promise<void> = Promise.resolve();

/** 记录一条诊断信息（只保留最近 `DIAG_LIMIT` 条） */
export function diag(step: string, detail?: string): Promise<void> {
  pending = pending.then(async () => {
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
  });
  return pending;
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
