import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parsePlayurl } from '@core/playinfo/parse';

/**
 * 守的是"解析层不许骗人"。
 *
 * ## fixture 来源（重要，别当成随便造的样本）
 *
 * - `playback-4k.json` / `guest-480p.json`：**真实观测值的转录**。
 *   轨道 id / 高度 / codecid / 帧率 / 码率 / flac / dolby 全部来自
 *   `poc/verify/RESULT.md` §一（2026-10-25，真实双账号实测）。直链域名做了脱敏，
 *   轨道条数按 RESULT.md 列出的 9 条（原始响应共 19 条，其余是同档位的编码变体）。
 * - `durl-only.json`：**结构边界样本**，照番剧响应"只有 durl、没有 dash"的形状构造，
 *   用于确认解析层不会把 durl 当 dash、也不会因此返回 null。
 *
 * 仓库里没有原始 playurl 的完整 JSON 落盘（`poc/verify/` 的 result-*.json 已 gitignore）。
 * 将来若能抓到原始响应，应替换上面两个 fixture，本注释随之更新。
 */

function load(name: string): unknown {
  const url = new URL(`../../../fixtures/playinfo/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

const PLAYBACK_4K = load('playback-4k.json');
const GUEST_480P = load('guest-480p.json');
const DURL_ONLY = load('durl-only.json');

describe('真实样本：播放账号（大会员）', () => {
  const info = parsePlayurl(PLAYBACK_4K);

  it('解析出全部轨道', () => {
    expect(info).not.toBeNull();
    expect(info?.dash?.video).toHaveLength(9);
    expect(info?.dash?.audio).toHaveLength(3);
  });

  it('最高轨道是 2160p / 120fps', () => {
    const heights = info?.dash?.video.map((t) => t.height) ?? [];
    expect(Math.max(...heights)).toBe(2160);

    const top = info?.dash?.video.filter((t) => t.height === 2160) ?? [];
    expect(top).toHaveLength(4);
    // 帧率字符串 "120.000" 必须解析成数字 120
    expect(top.every((t) => t.frameRate === 120)).toBe(true);
    // 原始字符串保留给诊断
    expect(top[0]?.frameRateRaw).toBe('120.000');
  });

  it('Hi-Res 与杜比全景声都解析出来', () => {
    expect(info?.dash?.flacAudio?.id).toBe(30251);
    expect(info?.dash?.flacAudio?.bandwidth).toBe(1500000);
    expect(info?.dash?.dolbyAudio).toHaveLength(1);
    expect(info?.dash?.dolbyAudio[0]?.id).toBe(30250);
  });

  it('dolbyVision 是服务端布尔值 false，不是"没解析到"', () => {
    // 这条很关键：false 与 undefined 在 UI 上都是"不提供"，
    // 但类型上必须是布尔，否则 `=== true` 的判断会静默失效
    expect(info?.dash?.dolbyVision).toBe(false);
  });

  it('保留 accept_quality 原文（它不可信，但诊断要看）', () => {
    expect(info?.acceptQuality).toHaveLength(10);
    expect(info?.acceptDescription[0]).toBe('超清 8K');
    expect(info?.durl).toBeNull();
  });
});

describe('真实样本：未登录', () => {
  const info = parsePlayurl(GUEST_480P);

  it('dash 最高只有 480p', () => {
    const heights = info?.dash?.video.map((t) => t.height) ?? [];
    expect(Math.max(...heights)).toBe(480);
  });

  it('⚠️ accept_quality 含 8K 却是假的 —— 这条钉住"不许拿它当判据"', () => {
    // RESULT.md §四：未登录时 accept_quality 返回 [127,120,116,80,64,32,16]，
    // 且 accept_description 里 127 对应"超清 8K"
    expect(info?.acceptQuality).toContain(127);
    expect(info?.acceptDescription[0]).toBe('超清 8K');

    // 而真实轨道最高只有 480。两者同时存在，正是 Q9 结论的证据：
    // "视频支持哪些画质"（accept_*）与"这个身份能拿到什么"（dash）是两件事。
    const heights = info?.dash?.video.map((t) => t.height) ?? [];
    expect(Math.max(...heights)).toBe(480);
  });

  it('没有 Hi-Res、没有杜比', () => {
    expect(info?.dash?.flacAudio).toBeNull();
    expect(info?.dash?.dolbyAudio).toHaveLength(0);
    expect(info?.dash?.dolbyVision).toBe(false);
  });
});

describe('结构边界：番剧只有 durl', () => {
  it('dash 为 null，durl 保留', () => {
    const info = parsePlayurl(DURL_ONLY);
    expect(info).not.toBeNull();
    expect(info?.dash).toBeNull();
    expect(info?.durl).toHaveLength(1);
  });
});

describe('容错：形状不对时返回 null，不抛异常', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'not json'],
    ['数组', []],
    ['数字', 42],
    ['空对象', {}],
    ['data 不是对象', { data: 'x' }],
  ])('%s → null', (_label, input) => {
    expect(parsePlayurl(input)).toBeNull();
  });

  it('data 是对象但什么都没有 → 返回对象，dash/durl 都是 null', () => {
    const info = parsePlayurl({ code: 0, data: {} });
    expect(info).not.toBeNull();
    expect(info?.dash).toBeNull();
    expect(info?.durl).toBeNull();
  });
});

describe('容错：字段缺失不补假值', () => {
  it('没有 frame_rate 时是 0，不是 30', () => {
    const info = parsePlayurl({
      data: { dash: { video: [{ id: 80, height: 1080, codecid: 7 }] } },
    });
    // 补 30 会在 UI 上凭空造出"30fps"
    expect(info?.dash?.video[0]?.frameRate).toBe(0);
    expect(info?.dash?.video[0]?.frameRateRaw).toBe('');
  });

  it('camelCase 的 frameRate 也能解析（wbi / 旧版字段名不一致）', () => {
    const info = parsePlayurl({
      data: { dash: { video: [{ id: 80, height: 1080, frameRate: '60.000' }] } },
    });
    expect(info?.dash?.video[0]?.frameRate).toBe(60);
  });

  it('flac 是空对象 → null（不能当成有 Hi-Res）', () => {
    const info = parsePlayurl({ data: { dash: { video: [], flac: {} } } });
    expect(info?.dash?.flacAudio).toBeNull();
  });

  it('flac 为 null → null', () => {
    const info = parsePlayurl({ data: { dash: { video: [], flac: null } } });
    expect(info?.dash?.flacAudio).toBeNull();
  });

  it('dolby.vision 只认布尔 true', () => {
    const truthy = parsePlayurl({ data: { dash: { video: [], dolby: { vision: 'true' } } } });
    expect(truthy?.dash?.dolbyVision).toBe(false);

    const real = parsePlayurl({ data: { dash: { video: [], dolby: { vision: true } } } });
    expect(real?.dash?.dolbyVision).toBe(true);
  });

  it('缺 base_url 的轨道仍然保留（能力统计只看 height）', () => {
    const info = parsePlayurl({ data: { dash: { video: [{ id: 120, height: 2160 }] } } });
    expect(info?.dash?.video).toHaveLength(1);
    expect(info?.dash?.video[0]?.baseUrl).toBe('');
    expect(info?.dash?.video[0]?.height).toBe(2160);
  });

  it('accept_quality 里的非数字被过滤', () => {
    const info = parsePlayurl({ data: { accept_quality: [120, 'abc', null, 80, -1, 0] } });
    expect(info?.acceptQuality).toEqual([120, 80]);
  });

  it('backup_url 里的非字符串被过滤', () => {
    const info = parsePlayurl({
      data: { dash: { video: [{ id: 1, height: 1, backup_url: ['https://a', 3, null] }] } },
    });
    expect(info?.dash?.video[0]?.backupUrl).toEqual(['https://a']);
  });
});
