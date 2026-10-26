import { describe, expect, it } from 'vitest';

import {
  audioChip,
  buildBadge,
  heightLabel,
  hevcBitDepth,
  hevcHdrLevel,
  type BadgeInput,
} from '../../../src/content/isolated/badge-content';

/**
 * 角标守的核心原则：**只说自己确认过的**。
 *
 * 这个角标贴在播放器上，用户会直接信它。写"4K"就必须真的在播 4K，
 * 写"Hi-Res"就必须真的在解 FLAC。一旦开始推测，它就从"证据"变成"装饰"。
 */

const base: BadgeInput = {
  proxying: true,
  playingHeight: 0,
  videoFamily: '',
  audioFamily: '',
  frameRate: 0,
};

describe('heightLabel', () => {
  it('按实际高度分档', () => {
    expect(heightLabel(2160)).toBe('4K');
    expect(heightLabel(1440)).toBe('2K');
    expect(heightLabel(1080)).toBe('1080P');
    expect(heightLabel(720)).toBe('720P');
  });

  it('4320（8K）必须是 8K —— 曾经误写成 4K', () => {
    // 这条曾经断言返回 '4K'，等于把 bug 当成预期行为锁住了
    expect(heightLabel(4320)).toBe('8K');
  });

  it('非常规高度照实写，不四舍五入到常见档位', () => {
    expect(heightLabel(540)).toBe('540P');
  });

  it('0 返回空串（还没开始播）', () => {
    expect(heightLabel(0)).toBe('');
  });
});

describe('audioChip', () => {
  it('只有 FLAC 才标 Hi-Res', () => {
    expect(audioChip('FLAC')).toBe('Hi-Res');
  });

  it('AAC 不标任何徽章，哪怕 playurl 里带了 FLAC 轨', () => {
    // 关键：decoding 是 AAC 就不该说 Hi-Res
    expect(audioChip('AAC-LC')).toBeNull();
    expect(audioChip('AAC')).toBeNull();
  });

  it('杜比 EC-3 标杜比', () => {
    expect(audioChip('Dolby(EC-3)')).toBe('杜比');
  });

  it('unknown 不标', () => {
    expect(audioChip('unknown')).toBeNull();
    expect(audioChip('')).toBeNull();
  });
});

describe('buildBadge —— 不许谎报', () => {
  it('没在代理 → 完全不显示', () => {
    const r = buildBadge({ ...base, proxying: false, playingHeight: 2160 });
    expect(r.visible).toBe(false);
    // 就算观测到 2160 也不能显示——没代理就不是我们做的事
    expect(r.label).toBe('');
  });

  it('代理了但还没开播 → 只说"已接管"，绝不猜画质', () => {
    const r = buildBadge(base);
    expect(r.visible).toBe(true);
    expect(r.label).toBe('已接管');
    // 这条是核心：没播就说 4K 等于作弊
    expect(r.label).not.toBe('4K');
  });

  it('在播 2160p → 显示 4K', () => {
    const r = buildBadge({ ...base, playingHeight: 2160 });
    expect(r.label).toBe('4K');
  });

  it('60fps 单独作为徽章', () => {
    const r = buildBadge({ ...base, playingHeight: 1080, frameRate: 60 });
    expect(r.chips).toContain('60fps');
  });

  it('FLAC 时 Hi-Res 作为徽章出现', () => {
    const r = buildBadge({ ...base, playingHeight: 2160, audioFamily: 'FLAC' });
    expect(r.chips).toContain('Hi-Res');
  });

  it('AAC 时没有 Hi-Res 徽章', () => {
    const r = buildBadge({ ...base, playingHeight: 2160, audioFamily: 'AAC-LC' });
    expect(r.chips).not.toContain('Hi-Res');
  });

  it('多个徽章可以同时出现', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      frameRate: 60,
      audioFamily: 'FLAC',
    });
    expect(r.chips).toEqual(['60fps', 'Hi-Res']);
  });

  it('详情里带上编码家族，方便排查', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      videoFamily: 'HEVC(hvc1)',
      audioFamily: 'FLAC',
    });
    expect(r.detail).toContain('2160p');
    expect(r.detail).toContain('HEVC(hvc1)');
    expect(r.detail).toContain('FLAC');
  });

  it('编码未知时详情里省略该段，不写 "unknown"', () => {
    const r = buildBadge({ ...base, playingHeight: 1080, videoFamily: 'unknown' });
    expect(r.detail).not.toContain('unknown');
  });
});

describe('8K 不能显示成 4K（用户报过的 bug）', () => {
  it('4320p → 8K', () => {
    expect(heightLabel(4320)).toBe('8K');
  });

  it('2160p 仍是 4K，不越级', () => {
    expect(heightLabel(2160)).toBe('4K');
  });
});

describe('画质只按高度判断（不猜 dash 轨）', () => {
  /**
   * 曾试图用 B站 quality id 判断 HDR / 杜比视界，已撤掉：
   * `<video>` 只给宽高，无法知道自己在放哪条 dash 轨。
   * 强行反查会匹配到同高度的另一条轨 →
   * 「播 4K SDR 却显示杜比视界」这种谎报。
   */
  it('2160p 就显示 4K，不因为服务端有杜比视界轨就说杜比视界', () => {
    const r = buildBadge({ ...base, playingHeight: 2160 });
    expect(r.label).toBe('4K');
  });

  it('1080p 显示 1080P', () => {
    expect(buildBadge({ ...base, playingHeight: 1080 }).label).toBe('1080P');
  });
});

describe('HDR 徽章只信浏览器判断（消除误标）', () => {
  /**
   * 风险来源有两个：
   *   1. B站会给普通 4K 转 HEVC 省码率，那种轨也是 HEVC + 2160p，但是 SDR
   *   2. `(video-dynamic-range: high)` 偶发在 1080P 上误报
   *
   * 所以 HDR 徽章必须**同时**满足：
   *   - 浏览器确认是 HDR（`videoDynamicRange === true`）
   *   - 且画面够格（2160p 以上，或编码是 HEVC）
   *
   * 宁可不显示，也不能谎报。
   */

  it('浏览器信号未知 → 不标（宁可不说）', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      videoFamily: 'HEVC(hvc1)',
      videoDynamicRange: null,
    });
    expect(r.chips).not.toContain('HDR');
  });

  it('播放 4K SDR 时不会显示杜比视界（用户实测的谎报场景）', () => {
    // 用户实测：最高画质是杜比视界，但当前播的是 4K SDR + Hi-Res，
    // 角标却显示「杜比视界 HDR」。撤掉 quality id 反查后不该再发生。
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      videoFamily: 'AV1',
      audioFamily: 'FLAC',
      videoDynamicRange: false,
    });
    expect(r.label).toBe('4K');
    expect(r.label).not.toBe('杜比视界');
    expect(r.chips).toContain('Hi-Res');
    expect(r.chips).not.toContain('HDR');
  });
});

describe('hevcBitDepth —— 从 profile 推断位深（弱信号）', () => {
  /**
   * 用户提供的实测 profile：`hvc1.2.4.L153.90` → `2.4.L153.90`
   * 第一段 `2` 是 profile_idc = Main10 = 10bit。
   *
   * ⚠️ 这只是**线索**，不是画质结论：
   *   - B站有些 SDR 视频也用 Main10 转码（避免色带）
   *   - 但 HDR 一定用 Main10，所以"不是 10bit"能否定 HDR
   * 因此只放详情，不进主文案。
   */
  it('实测 L153 的 profile 识别为 10bit', () => {
    expect(hevcBitDepth('2.4.L153.90')).toBe('10bit');
  });

  it('Main（profile_idc=1）是 8bit，不标', () => {
    expect(hevcBitDepth('1.6.L120.90')).toBeNull();
  });

  it('Main Still Picture（profile_idc=3）也是 10bit 能力', () => {
    expect(hevcBitDepth('3.4.L150.90')).toBe('10bit');
  });

  it('非 HEVC 的 "?" 返回 null', () => {
    expect(hevcBitDepth('?')).toBeNull();
    expect(hevcBitDepth('')).toBeNull();
    expect(hevcBitDepth(null)).toBeNull();
  });

  it('格式不对时不瞎猜', () => {
    expect(hevcBitDepth('garbage')).toBeNull();
  });

  it('8bit 时不出现 10bit 字样', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      videoFamily: 'HEVC(hvc1)',
      hevcProfile: '1.6.L120.90',
    });
    expect(r.detail).not.toContain('10bit');
  });
});

describe('1080P 与 1080P60 能区分', () => {
  it('1080p 普通帧率 → 只有 1080P，无 60fps', () => {
    const r = buildBadge({ ...base, playingHeight: 1080, frameRate: 30 });
    expect(r.label).toBe('1080P');
    expect(r.chips).not.toContain('60fps');
  });

  it('1080p 高帧率 → 1080P + 60fps 徽章', () => {
    const r = buildBadge({ ...base, playingHeight: 1080, frameRate: 60 });
    expect(r.label).toBe('1080P');
    expect(r.chips).toContain('60fps');
  });

  it('2160p60 同样带 60fps', () => {
    const r = buildBadge({ ...base, playingHeight: 2160, frameRate: 60 });
    expect(r.label).toBe('4K');
    expect(r.chips).toContain('60fps');
  });
});

describe('切画质瞬间不闪回「已接管」', () => {
  /**
   * 用户报的 bug：视频明显在播，角标却只显示「已接管」，
   * 过几秒才恢复正常画质。
   *
   * 根因：切画质时 `<video>.videoHeight` 会短暂变成 0，
   * 旧逻辑一看到 0 就把 label 和 chips 全清空。
   */
  it('首次加载（从没拿到高度）→ 才说「已接管」', () => {
    const r = buildBadge({ ...base, playingHeight: 0, lastKnownHeight: 0 });
    expect(r.label).toBe('已接管');
    expect(r.chips).toEqual([]);
  });

  it('曾经是 4K、本次读到 0 → 保留 4K，不闪回', () => {
    const r = buildBadge({ ...base, playingHeight: 0, lastKnownHeight: 2160 });
    expect(r.label).toBe('4K');
    // 详情说明正在切换，不假装一切正常
    expect(r.detail).toContain('正在切换');
  });

  it('曾经是 1080P、本次读到 0 → 保留 1080P', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 0,
      lastKnownHeight: 1080,
      audioFamily: 'FLAC',
    });
    expect(r.label).toBe('1080P');
    // 音频徽章也不该丢
    expect(r.chips).toContain('Hi-Res');
  });

  it('未传 lastKnownHeight 时退化为「已接管」（兼容旧调用）', () => {
    const r = buildBadge({ ...base, playingHeight: 0 });
    expect(r.label).toBe('已接管');
  });
});

describe('帧率必须显示真实数值（BV1beNcz2ECq 的教训）', () => {
  /**
   * 用户实测视频 BV1beNcz2ECq：所有 4K 轨都是 **120fps**（见
   * poc/verify/RESULT.md 的实测轨道表），角标却显示 "60fps"。
   *
   * 根因：`resolveHighFrameRate` 返回布尔 `best >= 50`，
   * 而角标文案写死 `'60fps'`。120fps 被降级成 60。
   *
   * 修法：传真实帧率数值，徽章按实际值渲染。
   */
  it('120fps → 显示 120fps，不是 60fps', () => {
    const r = buildBadge({ ...base, playingHeight: 2160, frameRate: 120 });
    expect(r.chips).toContain('120fps');
    expect(r.chips).not.toContain('60fps');
  });

  it('60fps → 显示 60fps', () => {
    const r = buildBadge({ ...base, playingHeight: 1080, frameRate: 60 });
    expect(r.chips).toContain('60fps');
  });

  it('30fps → 不出帧率徽章（常规值，标出来是噪音）', () => {
    const r = buildBadge({ ...base, playingHeight: 1080, frameRate: 30 });
    expect(r.chips.some((c) => c.endsWith('fps'))).toBe(false);
  });

  it('未知帧率（0）→ 不出徽章，但详情里也不写', () => {
    const r = buildBadge({ ...base, playingHeight: 1080, frameRate: 0 });
    expect(r.chips.some((c) => c.endsWith('fps'))).toBe(false);
    expect(r.detail).not.toContain('fps');
  });

  it('详情里始终带真实帧率，即便低于 50', () => {
    const r = buildBadge({ ...base, playingHeight: 1080, frameRate: 30 });
    expect(r.detail).toContain('30fps');
  });
});

describe('HDR 判定取两条证据的并集（屏幕开着 HDR 必须认）', () => {
  /**
   * 用户实测：显示器和系统都开了 HDR，画面也确实是 HDR / 杜比视界效果，
   * 但角标不显示 HDR。
   *
   * 根因：只看 `(video-dynamic-range: high)`，而这个信号在
   * AV1 编码的 HDR 轨上会返回 standard（漏报）。
   *
   * 两条信号含义不同：
   *   - `(dynamic-range: high)`      → 屏幕/系统在 HDR 模式
   *   - `(video-dynamic-range: high)` → 视频通道以 HDR 呈现
   * 任一为真 + 画面够格，就标 HDR。
   */

  it('两条都为 false → 不标', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      videoFamily: 'HEVC(hvc1)',
      displayDynamicRange: false,
      videoDynamicRange: false,
    });
    expect(r.chips).not.toContain('HDR');
  });

  it('HDR 徽章已移除：videoDynamicRange=true 也不再出 HDR', () => {
    // 四个 HDR 信号全部实测证伪（见 badge-content.ts 的说明），
    // 角标只报 100% 确定的分辨率/帧率/音频。
    const r = buildBadge({
      ...base,
      playingHeight: 1080,
      videoFamily: 'AV1',
      displayDynamicRange: true,
      videoDynamicRange: true,
    });
    expect(r.chips).not.toContain('HDR');
  });
});

describe('杜比视界：只能说明"视频提供"，不能说"正在播"', () => {
  /**
   * 用户实测 BV1beNcz2ECq P3：B站画质菜单标的是杜比视界，
   * 但角标显示 HDR。
   *
   * 事实核对：`dash.dolby.vision` 是服务端标注的"本视频提供杜比视界版本"，
   * **不等于播放器当前选中的就是它**。
   *
   * 所以正确处理是：
   *   - 主文案：仍然按实际分辨率/帧率（4K + 120fps）
   *   - 详情：补一句「本视频提供杜比视界版本」
   *
   * 绝不把主文案改成"杜比视界"——那是把"有这个版本"谎报成"你在看这个版本"。
   */
  it('视频提供杜比视界时，详情里出现提示', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      frameRate: 120,
      dolbyVisionAvailable: true,
    });
    expect(r.detail).toContain('本视频提供杜比视界');
  });

  it('主文案仍是实际画质，不变成"杜比视界"', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      frameRate: 120,
      dolbyVisionAvailable: true,
    });
    expect(r.label).toBe('4K');
    expect(r.label).not.toBe('杜比视界');
  });

  it('不提供杜比视界时不加提示', () => {
    const r = buildBadge({ ...base, playingHeight: 2160, dolbyVisionAvailable: false });
    expect(r.detail).not.toContain('杜比视界');
  });

  it('未传该字段时也不加提示', () => {
    const r = buildBadge({ ...base, playingHeight: 2160 });
    expect(r.detail).not.toContain('杜比视界');
  });
});

describe('杜比视界主文案：三个条件缺一不可', () => {
  /**
   * 用户提出的关键场景：如果只看 `dolby.vision`（视频有 DV 版本），
   * 那么切到 1080P 时也会显示「杜比视界」——那是谎报。
   *
   * 所以三个条件必须同时成立：
   *   1. 服务端说这个视频提供 DV 版本
   *   2. 当前高度 >= 2160（DV 只在 4K 及以上）
   *   3. 当前编码是 HEVC（**DV 必须走 HEVC，AV1 不承载**）
   */
  it('4K + HEVC + 视频有 DV → 主文案写杜比视界', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      videoFamily: 'HEVC(hvc1)',
      dolbyVisionAvailable: true,
    });
    expect(r.label).toBe('杜比视界');
  });

  it('切到 1080P 时**不能**显示杜比视界（用户提出的场景）', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 1080,
      videoFamily: 'HEVC(hvc1)',
      dolbyVisionAvailable: true,
    });
    expect(r.label).toBe('1080P');
    expect(r.label).not.toBe('杜比视界');
  });

  it('4K 但编码是 AV1 → 不写杜比视界（AV1 不承载 DV）', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      videoFamily: 'AV1',
      dolbyVisionAvailable: true,
    });
    expect(r.label).toBe('4K');
  });

  it('视频没有 DV 版本时，4K HEVC 也不写杜比视界', () => {
    const r = buildBadge({
      ...base,
      playingHeight: 2160,
      videoFamily: 'HEVC(hvc1)',
      dolbyVisionAvailable: false,
    });
    expect(r.label).toBe('4K');
  });

  it('详情区分"正在播 DV" 与 "只是有这个版本"', () => {
    const playing = buildBadge({
      ...base,
      playingHeight: 2160,
      videoFamily: 'HEVC(hvc1)',
      dolbyVisionAvailable: true,
    });
    expect(playing.detail).toContain('当前播放杜比视界');

    const notPlaying = buildBadge({
      ...base,
      playingHeight: 1080,
      videoFamily: 'HEVC(hvc1)',
      dolbyVisionAvailable: true,
    });
    expect(notPlaying.detail).toContain('当前未播放该版本');
  });
});

describe('hevcHdrLevel —— 用真实日志里的 Level 判断 HDR', () => {
  /**
   * 用户实测日志（P3，4K HDR 视频）：
   *   addSourceBuffer 收到 `hvc1.2.4.L156.90`
   *   同视频普通档是 `hev1.1.6.L120.90`
   *   matchMedia: display=true video=false   ← 视频通道信号恒为 false
   *
   * 也就是说：**只信 (video-dynamic-range) 就永远标不出 HDR**。
   * 必须补一条基于 HEVC Level 的证据。
   */

  it('L153 也够（Level 5.1）', () => {
    expect(hevcHdrLevel('2.4.L153.90')).toBe('L153');
  });

  it('L150 是分界线', () => {
    expect(hevcHdrLevel('2.4.L150.90')).toBe('L150');
  });

  it('L123 也不够', () => {
    expect(hevcHdrLevel('2.4.L123.90')).toBeNull();
  });

  it('非 HEVC 或空值 → null', () => {
    expect(hevcHdrLevel('?')).toBeNull();
    expect(hevcHdrLevel('')).toBeNull();
    expect(hevcHdrLevel(null)).toBeNull();
  });
});

describe('「已接管」乱跳：穷举所有可能路径（第三轮修复）', () => {
  /**
   * 用户报"已接管和正常画质之间乱跳"，我改了三轮才对。
   * 这次把**所有可能产生「已接管」的路径**都列出来。
   *
   * `buildBadge` 里只有一处会输出「已接管」：
   *   `playingHeight <= 0 && lastKnownHeight <= 0`
   *
   * 所以只要保证「至少一个不为 0」，就永远不会闪。
   * 下面逐个场景验证。
   */
  it('正常播放：4K', () => {
    const r = buildBadge({ ...base, playingHeight: 2160, lastKnownHeight: 2160 });
    expect(r.label).toBe('4K');
  });

  it('切画质瞬间 h=0，但缓存有 2160 → 保持 4K', () => {
    const r = buildBadge({ ...base, playingHeight: 0, lastKnownHeight: 2160 });
    expect(r.label).toBe('4K');
    expect(r.label).not.toBe('已接管');
  });

  it('h=0 且缓存是 1080 → 保持 1080P', () => {
    const r = buildBadge({ ...base, playingHeight: 0, lastKnownHeight: 1080 });
    expect(r.label).toBe('1080P');
  });

  it('只有 h=0 且缓存也 0 才显示「已接管」', () => {
    const r = buildBadge({ ...base, playingHeight: 0, lastKnownHeight: 0 });
    expect(r.label).toBe('已接管');
  });

  it('代理未生效时角标不显示（不是显示已接管）', () => {
    const r = buildBadge({ ...base, proxying: false, playingHeight: 2160 });
    expect(r.visible).toBe(false);
  });

  it('从 4K 切到 1080P，缓存必须跟着降（不能只升不降）', () => {
    // 模拟 badge.ts 的逻辑：playingHeight > 0 就更新缓存
    const r = buildBadge({ ...base, playingHeight: 1080, lastKnownHeight: 2160 });
    // buildBadge 用的是入参 lastKnownHeight，只在 h=0 时才用它
    // 这里 h=1080 > 0，所以直接用 1080
    expect(r.label).toBe('1080P');
  });
});
