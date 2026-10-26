/**
 * 当前视频页的取流数据 —— content 侧的纯逻辑（零 DOM、零 chrome API，可单测）。
 *
 * ## 它解决什么问题
 *
 * popup §2.3 要显示"已解锁 [4K] ｜ 主账号仅可用 1080P"。两侧数据来源完全不同：
 *
 * | 侧 | 来源 | 拿到的是谁 |
 * | --- | --- | --- |
 * | 主账号 | `document_start` 那刻的 `window.__playinfo__` | 服务端用**主账号**生成 |
 * | 播放账号 | 页面自己发的 playurl 响应 | 已被 DNR 换成**播放账号** |
 *
 * ## 为什么"主账号基线"要这么小心
 *
 * `ADR 0010` 说 `__playinfo__` 是 SSR 的，`poc/verify/RESULT.md` §一.2 说是客户端写入的。
 * 如果是后者，那份数据来自**已被代理**的页面请求 —— 也就是播放账号自己的，
 * 拿它当基线会让对比永远显示"没有提升"（静默谎报，见 ADR 0014）。
 *
 * 所以这里的判据不是"有没有数据"，而是**"数据是在页面发 playurl 之前还是之后出现的"**：
 * 主世界会带上 `firstSeen` 与 `playurlBefore`，两者一起才能判定。
 */

import { parsePlayurl } from '@core/playinfo/parse';
import { capabilityOf, diffCapability } from '@core/playinfo/rank';
import type {
  Capability,
  PageTracksView,
  PrimaryBaselineReason,
  PrimaryUser,
} from '@shared/types/playinfo';

/** 主世界 `ssr-playinfo` 消息的载荷 */
export interface SsrPayload {
  /** 第一次看到 `__playinfo__` 的时机 */
  firstSeen: 'initial' | 'set' | 'none';
  /** 那次赋值之前，页面是否已经发出过 playurl 请求 */
  playurlBefore: boolean;
  /** 冻结的第一份 `__playinfo__`（可能是 null） */
  data: unknown;
  /** 主账号显示信息，可能为 null（`__INITIAL_STATE__` 还没就绪） */
  user: PrimaryUser | null;
}

export class PageState {
  private bvid = '';
  private p = 0;

  private primaryCap: Capability | null = null;
  private primaryReason: PrimaryBaselineReason = 'absent';
  private user: PrimaryUser | null = null;

  private playbackCap: Capability | null = null;
  /** 是否收到过播放账号侧的响应（区分"还没来"和"来了但解析不出"） */
  private sawPlayback = false;

  /**
   * 主账号 mid（来自 `document.cookie` 的 `DedeUserID`）。
   *
   * ⚠️ `null` 有两种含义，靠 `midSettled` 区分：
   *   - `midSettled === false`：还没到能读的时候（`document_start` 时 cookie 常为空）
   *   - `midSettled === true` 且 `mid === null`：确实没登录
   */
  private primaryMid: string | null = null;
  private midSettled = false;

  private updatedAt = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * 报到时设定当前页。
   *
   * ⚠️ **bvid 或分 P 变了就清空两侧数据。** 不清的话，切 P 之后
   * 上一 P 的轨道会被当成本 P 的能力 —— 两个视频码率不同时结论直接错。
   */
  setPage(bvid: string, p: number): void {
    if (bvid === this.bvid && p === this.p) return;
    this.bvid = bvid;
    this.p = p;
    this.primaryCap = null;
    this.primaryReason = 'absent';
    this.user = null;
    this.playbackCap = null;
    this.sawPlayback = false;
    this.primaryMid = null;
    this.midSettled = false;
    this.touch();
  }

  /**
   * 记录主账号是否登录。
   *
   * @param mid 从 `DedeUserID` 读到的 mid，读不到就是 `null`
   * @param settled 这次读取是否发生在**能读到 cookie 的时机**（DOM 就绪后）。
   *   `document_start` 那次要传 `false` —— 那时 cookie 常为空，读不到不代表游客。
   *
   * 判定规则：**读到过真实 mid 就永久算已登录**（账号不会在同一页面里变成游客）；
   * 只有在"该读到的时机"仍读不到，才判为未登录。
   */
  setPrimaryMid(mid: string | null, settled: boolean): void {
    if (mid !== null) {
      this.primaryMid = mid;
      this.midSettled = true;
    } else if (settled) {
      this.midSettled = true;
    }
    this.touch();
  }

  /**
   * 应用主世界报来的 SSR 快照。可能被调用多次（hello / ready / 延迟补报）。
   *
   * 合并规则：
   *   - `user` 后到的覆盖先到的（`__INITIAL_STATE__` 往往晚于 `__playinfo__` 就绪）
   *   - 能力**只接受可用基线**；已经拿到可用基线后，后来的坏消息不许把它抹掉
   */
  applySsr(payload: SsrPayload): void {
    if (payload.user) this.user = payload.user;

    const usable = payload.firstSeen !== 'none' && !payload.playurlBefore;

    if (!usable) {
      // 好消息不许被后到的坏消息覆盖
      if (this.primaryReason !== 'ssr') {
        this.primaryReason = payload.firstSeen === 'none' ? 'absent' : 'client-written';
      }
      this.touch();
      return;
    }

    const cap = capabilityOf(parsePlayurl(payload.data));
    if (cap) {
      this.primaryCap = cap;
      this.primaryReason = 'ssr';
    } else if (this.primaryReason !== 'ssr') {
      this.primaryReason = 'unparsable';
    }
    this.touch();
  }

  /** 应用页面自己的 playurl 响应（播放账号身份） */
  applyPlayback(raw: unknown): void {
    this.sawPlayback = true;
    const cap = capabilityOf(parsePlayurl(raw));
    // 解析不出时**不清空**已有能力：多 P / 重复请求里偶发一次坏响应，
    // 不代表之前拿到的轨道不存在
    if (cap) this.playbackCap = cap;
    this.touch();
  }

  /**
   * 给 UI 的快照。
   *
   * @returns `null` 表示"当前不是视频页 / 还没报到" —— UI 该说"打开任意视频页查看效果"
   */
  view(): PageTracksView | null {
    if (!this.bvid) return null;

    return {
      bvid: this.bvid,
      p: this.p,
      updatedAt: this.updatedAt,
      primary: {
        usable: this.primaryReason === 'ssr' && this.primaryCap !== null,
        reason: this.primaryReason,
        capability: this.primaryCap,
        user: this.user,
        loggedIn: this.midSettled ? (this.primaryMid === null ? 'no' : 'yes') : 'unknown',
      },
      playback: this.sawPlayback ? { capability: this.playbackCap } : null,
      diff: diffCapability(this.primaryCap, this.playbackCap),
    };
  }

  private touch(): void {
    this.updatedAt = this.now();
  }
}
