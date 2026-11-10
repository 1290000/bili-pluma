// @vitest-environment node

/**
 * **画质档位锚点 + 码率档提升**的真机 bug 回归（2026-11-10）。
 *
 * ## 用户报告
 *
 * 画质面板显示 `无提升（源限制）` + `主账号仅可用 720P`，而实际主账号能拿到 1080P、
 * 播放账号拿到了 1080P 高码率。
 *
 * ## 真机取证（`BV1h14n6jEGf`）
 *
 * | | 主账号 | 播放账号 |
 * | --- | --- | --- |
 * | 最高 id | **80**（1080P） | **112**（1080P 高码率） |
 * | height | **900**（1600×900） | **900** |
 * | 码率 | 4.4 Mbps | 6.5 Mbps |
 *
 * ## 两条独立的 bug
 *
 * 1. **锚点错**：`heightLabel(900)` → `>=720` → 「720P」。
 *    B站 的 1080P 档 height 不一定是 1080 —— 竖屏/非常规比例视频可能是
 *    `768 / 816 / 900 / 1024`（verifier 边界扫描全部如此）。
 * 2. **标题错**：`diffCapability().improved` 只看 height / 帧率 / Hi-Res / 杜比，
 *    **不看 quality id**。本例 height 相同 → `false` → 「无提升」。
 *
 * ## 本文件的六场景（源自 verifier 的 `audit-same-class.mjs`）
 *
 * | # | 场景 | 期望 |
 * | --- | --- | --- |
 * | A | 80/900 vs 112/900（用户场景） | 已解锁 · 主账号仅可用 **1080P** |
 * | B | 80/1080 vs 112/1080 | 已解锁 · 主账号仅可用 1080P |
 * | C | 80 vs 80（真源限制） | 无提升（源限制） |
 * | D | 80 vs 64（播放账号更弱） | **没有提升** |
 * | E | 64/720 → 80/900 | 已解锁 · 主账号仅可用 **720P** |
 * | F | 80/30fps vs 116/60fps | 已解锁（1080P60 是真提升） |
 *
 * ⚠️ **场景 D 是我第一版修复引入的回归**：第一版用"播放账号有而主账号没有的 id"
 * 判提升，于是 `64`（720P，更弱）也被判成提升 → 标题说「已解锁」。
 * 正确判据是**比较两侧最高 id**。这条测试就是防它复发的。
 */

import { describe, expect, it } from 'vitest';

import { capabilityOf, diffCapability } from '../../../../src/core/playinfo/rank';
import { describeUnlock } from '../../../../src/core/playinfo/summary-view';
import type { UnlockSummary } from '../../../../src/core/playinfo/summary-view';

/**
 * 测试用的非空包装。
 *
 * `describeUnlock()` 在"总开关关着 / 没有 view"时返回 null，而本文件所有场景
 * 都是播放页 + 有数据，所以它必然非 null。用这个包一下，避免每处都写 `?.`。
 */
function unlock(v: PageTracksView): UnlockSummary {
  const r = describeUnlock(v);
  if (!r) throw new Error('describeUnlock 返回 null —— 本文件的场景都应有数据');
  return r;
}
import { parsePlayurl } from '../../../../src/core/playinfo/parse';
import type { Capability, PageTracksView } from '../../../../src/shared/types/playinfo';
import { heightLabel } from '../../../../src/shared/utils/quality';

/** 造一份真实形状的 playurl 响应 */
function playurl(tracks: { id: number; h: number; bw: number }[]) {
  return {
    data: {
      quality: Math.max(...tracks.map((t) => t.id)),
      dash: {
        video: tracks.map((t) => ({ id: t.id, height: t.h, bandwidth: t.bw, frameRate: 30 })),
        audio: [],
        flac: null,
        dolby: { audio: null, type: 0 },
        dolbyAudio: [],
        dolbyVision: false,
      },
    },
  };
}

function capOf(tracks: { id: number; h: number; bw: number }[]): Capability {
  const c = capabilityOf(parsePlayurl(playurl(tracks)) as never);
  if (!c) throw new Error('capabilityOf 返回 null');
  return c;
}

/** 组一份完整的 PageTracksView */
function view(
  primaryTracks: { id: number; h: number; bw: number }[],
  playbackTracks: { id: number; h: number; bw: number }[],
): PageTracksView {
  const pc = capOf(primaryTracks);
  const bc = capOf(playbackTracks);
  return {
    pageKey: 'BV1h14n6jEGf',
    p: 1,
    updatedAt: 0,
    primary: {
      usable: true,
      reason: 'ssr',
      capability: pc,
      user: null,
      mid: '1',
      loggedIn: 'yes',
    },
    playback: { capability: bc },
    diff: diffCapability(pc, bc),
  };
}

/** 真机观测到的码率 */
const BW_1080 = 4373792;
const BW_1080P_PLUS = 6535129;
const BW_720 = 1861729;

describe('★★ 场景 A：用户报的场景（height 900，锚点曾错成 720P）', () => {
  const v = view(
    [{ id: 80, h: 900, bw: BW_1080 }],
    [
      { id: 112, h: 900, bw: BW_1080P_PLUS },
      { id: 80, h: 900, bw: BW_1080 },
    ],
  );

  it('★★ 锚点用 id 说「1080P」，不再是 heightLabel(900) 的「720P」', () => {
    /**
     * 反例：把 `anchorText` 改回 `heightLabel(cap.maxHeight)` → 本条必红，
     * 拿到「主账号仅可用 720P」。
     */
    const r = unlock(v);
    expect(r.anchor).toBe('主账号仅可用 1080P');
  });

  it('★★ 标题是「已解锁」（码率档提升被识别）', () => {
    /**
     * 反例：把 `improved` 改回不看 quality id → 本条必红，拿到「无提升（源限制）」。
     */
    expect(v.diff?.improved).toBe(true);
    expect(unlock(v).title).toBe('已解锁');
  });
});

describe('★★ 场景 B：标准 1080p（height 1080）', () => {
  const v = view(
    [{ id: 80, h: 1080, bw: BW_1080 }],
    [
      { id: 112, h: 1080, bw: BW_1080P_PLUS },
      { id: 80, h: 1080, bw: BW_1080 },
    ],
  );

  it('锚点 1080P', () => {
    expect(unlock(v).anchor).toBe('主账号仅可用 1080P');
  });

  it('标题已解锁', () => {
    expect(unlock(v).title).toBe('已解锁');
  });
});

describe('★★ 场景 C：两侧完全一样 → 真源限制', () => {
  const v = view([{ id: 80, h: 900, bw: BW_1080 }], [{ id: 80, h: 900, bw: BW_1080 }]);

  it('improved 为 false', () => {
    expect(v.diff?.improved).toBe(false);
  });

  it('标题「无提升（源限制）」（不是「没有提升」）', () => {
    expect(unlock(v).title).toBe('无提升（源限制）');
  });

  it('锚点仍正确（1080P，不是 720P）', () => {
    expect(unlock(v).anchor).toBe('主账号仅可用 1080P');
  });
});

describe('★★ 场景 D：播放账号更弱（80 vs 64）—— 第一版修复的回归', () => {
  const v = view([{ id: 80, h: 900, bw: BW_1080 }], [{ id: 64, h: 720, bw: BW_720 }]);

  it('★★ improved 必须是 false（播放账号只拿到 720P，比主账号更弱）', () => {
    /**
     * ⚠️ 这是本文件最重要的一条。
     *
     * 第一版判据写成「播放账号有而主账号没有的 id」→ `64` 主账号没有 → 判提升。
     * **那是错的**：`64`（720P）比 `80`（1080P）档位更低。
     *
     * 正确判据是「最高 id 变高了」：`max([64]) = 64 < max([80]) = 80` → 不提升。
     */
    expect(v.diff?.improved).toBe(false);
  });

  it('标题「没有提升」（不是「已解锁」，也不是「源限制」）', () => {
    const r = unlock(v);
    expect(r.title).not.toBe('已解锁');
    expect(r.title).toBe('没有提升');
  });
});

describe('★★ 场景 E：高度真实提升（720 → 1080 档）', () => {
  const v = view([{ id: 64, h: 720, bw: BW_720 }], [{ id: 80, h: 900, bw: BW_1080 }]);

  it('锚点 720P（主账号确实只有 720P 档）', () => {
    expect(unlock(v).anchor).toBe('主账号仅可用 720P');
  });

  it('标题已解锁（heightGain > 0）', () => {
    expect(unlock(v).title).toBe('已解锁');
  });
});

describe('★★ 场景 F：1080P60（id 116）相对 1080P 是真提升', () => {
  const v = view([{ id: 80, h: 1080, bw: BW_1080 }], [{ id: 116, h: 1080, bw: BW_1080 }]);

  it('improved 为 true（最高 id 116 > 80）', () => {
    /**
     * `116` 在 `BADGE_QUALITY_NAMES` 里已被删（不出徽章，由 `60fps` 徽章代替），
     * 但它在 `QUALITY_NAMES` 里（`1080P60`），且**是更高的一档**。
     * 帧率没有提升（两条轨都是 30fps），但档位变了 → 提升。
     */
    expect(v.diff?.improved).toBe(true);
  });

  it('标题是「已解锁」，不能因为 same 判据说「源限制」', () => {
    expect(unlock(v).title).toBe('已解锁');
  });
});

describe('★ heightLabel 的已知错位（文档化，不是要修）', () => {
  /**
   * ## 为什么这里断言"错"的行为
   *
   * `heightLabel()` 是**纯像素阈值**函数，它的语义是"这个像素高度叫什么"，
   * **不是"这是 B站 的哪一档"**。
   *
   * B站 的 1080P 档 height 可能是 `768 / 816 / 900 / 1024`（竖屏 / 非常规比例），
   * 这些值按像素算确实落在 720P 区间 —— **函数没错，是调用方用错了地方**。
   *
   * 所以本组测试**锁住现状**，并明确"调用方必须优先用 quality id"。
   * ⚠️ 不要"顺手修阈值"（比如 `>=900 → 1080P`）：那会引入新的错位区间
   * （850 呢？1024 呢？），而 id 才是 B站的权威档位标识。
   */
  it('heightLabel 对 900 / 768 / 816 / 1024 都返回 720P（已知错位）', () => {
    expect(heightLabel(900)).toBe('720P');
    expect(heightLabel(768)).toBe('720P');
    expect(heightLabel(816)).toBe('720P');
    expect(heightLabel(1024)).toBe('720P');
  });

  it('标称高度仍然正确', () => {
    expect(heightLabel(1080)).toBe('1080P');
    expect(heightLabel(720)).toBe('720P');
    expect(heightLabel(2160)).toBe('4K');
    expect(heightLabel(4320)).toBe('8K');
  });

  it('★ 所以 anchorText 必须走 id：主账号 80/900 说 1080P 而不是 720P', () => {
    /**
     * 这条把上面两件事连起来：同一个 900，
     * `heightLabel` 说 720P（像素真相），而锚点必须说 1080P（档位真相）。
     */
    const v = view([{ id: 80, h: 900, bw: BW_1080 }], [{ id: 80, h: 900, bw: BW_1080 }]);
    expect(heightLabel(900)).toBe('720P');
    expect(unlock(v).anchor).toBe('主账号仅可用 1080P');
  });
});

describe('★ diffCapability 的 qualityGained 判据', () => {
  it('最高 id 变高 → 提升', () => {
    const d = diffCapability(
      capOf([{ id: 80, h: 1080, bw: BW_1080 }]),
      capOf([{ id: 112, h: 1080, bw: BW_1080P_PLUS }]),
    );
    expect(d?.improved).toBe(true);
  });

  it('★ 最高 id 变低 → **不**提升（即使播放账号多出别的 id）', () => {
    /**
     * 反例：主账号 `[80]`、播放账号 `[64]` —— 播放账号有主账号没有的 `64`，
     * 但**档位更低**。第一版判据在这里判错。
     */
    const d = diffCapability(
      capOf([{ id: 80, h: 1080, bw: BW_1080 }]),
      capOf([{ id: 64, h: 720, bw: BW_720 }]),
    );
    expect(d?.improved).toBe(false);
  });

  it('最高 id 相同 → 不提升（即使高度或帧率相同）', () => {
    const d = diffCapability(
      capOf([{ id: 80, h: 900, bw: BW_1080 }]),
      capOf([{ id: 80, h: 900, bw: BW_1080 }]),
    );
    expect(d?.improved).toBe(false);
  });
});
