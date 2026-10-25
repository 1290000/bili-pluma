import { describe, expect, it } from 'vitest';

/**
 * 主世界脚本的纯逻辑测试。
 *
 * `public/main-world.js` 是纯 JS、不参与 TS 编译，所以这里**复刻**它的
 * 判断函数来测。这不算理想（有漂移风险），但比重写整个文件为 TS 更务实。
 *
 * ⚠️ 改 `public/main-world.js` 里这几个函数时，必须同步改这里。
 */

// ── 复刻自 public/main-world.js ──

function codecFamily(codec: string): string {
  if (!codec || codec === '?') return 'unknown';
  if (/^hev1\./i.test(codec)) return 'HEVC(hev1)';
  if (/^hvc1\./i.test(codec)) return 'HEVC(hvc1)';
  if (/^av01\./i.test(codec)) return 'AV1';
  if (/^avc1\./i.test(codec)) return 'H.264';
  if (/^vp09\./i.test(codec)) return 'VP9';
  return 'other';
}

function hevcProfile(codec: string): string {
  if (!codec) return '?';
  // 注意：是 (?:hvc1|hev1)，不是 hv(?:c1|ev1)——后者对 hev1 会展开成 hvev1
  const m = codec.match(/^(?:hvc1|hev1)\.([0-9A-Za-z.]+)$/i);
  return m?.[1] ? m[1] : '?';
}

function audioFamily(codec: string): string {
  if (!codec || codec === '?') return 'unknown';
  if (/^ec-3|^ac-3/i.test(codec)) return 'Dolby(EC-3)';
  if (/^fLaC/i.test(codec)) return 'FLAC';
  if (/^alac/i.test(codec)) return 'ALAC';
  // 注意用 ($|\.) 收尾：`mp4a.40.2` 会误匹配 `mp4a.40.29` 的前缀
  if (/^mp4a\.40\.5($|\.)/i.test(codec)) return 'HE-AAC';
  if (/^mp4a\.40\.2($|\.)/i.test(codec)) return 'AAC-LC';
  if (/^mp4a/i.test(codec)) return 'AAC';
  if (/^opus/i.test(codec)) return 'Opus';
  return 'other';
}

describe('codecFamily', () => {
  it('B站实际出现的 HEVC 两种 tag 都能识别', () => {
    expect(codecFamily('hev1.1.6.L120.90')).toBe('HEVC(hev1)');
    expect(codecFamily('hvc1.2.4.L153.90')).toBe('HEVC(hvc1)');
    expect(codecFamily('hvc1.2.4.L156.90')).toBe('HEVC(hvc1)');
  });

  it('AV1 能识别（B站默认选的编码）', () => {
    expect(codecFamily('av01.0.00M.10.0.110.01.01.01.0')).toBe('AV1');
    expect(codecFamily('av01.0.10M.12')).toBe('AV1');
  });

  it('H.264 / VP9 能识别', () => {
    expect(codecFamily('avc1.640034')).toBe('H.264');
    expect(codecFamily('vp09.00.50.08')).toBe('VP9');
  });

  it('不重要：不因为 hvc1 就说是杜比视界', () => {
    // 这条是防回归：hvc1 只是封装 tag，HDR Vivid / HDR10 / 杜比视界都用 HEVC
    expect(codecFamily('hvc1.2.4.L153.90')).not.toMatch(/Dolby|dolby|vision/i);
  });

  it('未知编码归到 other', () => {
    expect(codecFamily('weird-codec')).toBe('other');
    expect(codecFamily('?')).toBe('unknown');
    expect(codecFamily('')).toBe('unknown');
  });
});

describe('hevcProfile', () => {
  it('从 hvc1 提取档次', () => {
    expect(hevcProfile('hvc1.2.4.L153.90')).toBe('2.4.L153.90');
    expect(hevcProfile('hvc1.2.4.L156.90')).toBe('2.4.L156.90');
  });

  it('从 hev1 提取档次', () => {
    expect(hevcProfile('hev1.1.6.L120.90')).toBe('1.6.L120.90');
  });

  it('非 HEVC 返回 ?', () => {
    expect(hevcProfile('av01.0.00M.10')).toBe('?');
    expect(hevcProfile('avc1.640034')).toBe('?');
  });

  it('L153 和 L156 是两个不同档次（不能混为一谈）', () => {
    expect(hevcProfile('hvc1.2.4.L153.90')).not.toBe(hevcProfile('hvc1.2.4.L156.90'));
  });
});

describe('audioFamily', () => {
  it('FLAC 能识别（Hi-Res）', () => {
    expect(audioFamily('fLaC')).toBe('FLAC');
    expect(audioFamily('flac')).toBe('FLAC');
  });

  it('杜比 EC-3 能识别', () => {
    expect(audioFamily('ec-3')).toBe('Dolby(EC-3)');
    expect(audioFamily('ac-3')).toBe('Dolby(EC-3)');
  });

  it('AAC 各级能区分', () => {
    expect(audioFamily('mp4a.40.2')).toBe('AAC-LC');
    expect(audioFamily('mp4a.40.5')).toBe('HE-AAC');
    expect(audioFamily('mp4a.40.29')).toBe('AAC');
  });

  it('ALAC / Opus 能识别', () => {
    expect(audioFamily('alac')).toBe('ALAC');
    expect(audioFamily('opus')).toBe('Opus');
  });

  it('未知返回 other', () => {
    expect(audioFamily('xyz')).toBe('other');
    expect(audioFamily('')).toBe('unknown');
  });
});

// ── 活跃轨道选择逻辑 ──

interface SbEntry {
  codec: string;
  lastUpdate: number;
}

/** 复刻 activeCodec / activeAudioCodec：取最近写入的那条 */
function pickActive(list: SbEntry[]): string {
  let best: SbEntry | null = null;
  for (const x of list) {
    if (!x.lastUpdate) continue;
    if (!best || x.lastUpdate > best.lastUpdate) best = x;
  }
  return best ? best.codec : '?';
}

describe('pickActive（按最近写入时间选活跃轨）', () => {
  it('多条时取最近写入的，不取最早', () => {
    const list: SbEntry[] = [
      { codec: 'flac', lastUpdate: 1000 },
      { codec: 'mp4a.40.2', lastUpdate: 3000 },
    ];
    expect(pickActive(list)).toBe('mp4a.40.2');
  });

  it('创建顺序无关，只看写入时间', () => {
    // 先创建的后写入（切回旧轨的场景）
    const list: SbEntry[] = [
      { codec: 'mp4a.40.2', lastUpdate: 3000 },
      { codec: 'flac', lastUpdate: 5000 },
    ];
    expect(pickActive(list)).toBe('flac');
  });

  it('从未写入的轨被忽略', () => {
    const list: SbEntry[] = [
      { codec: 'flac', lastUpdate: 0 },
      { codec: 'mp4a.40.2', lastUpdate: 2000 },
    ];
    expect(pickActive(list)).toBe('mp4a.40.2');
  });

  it('全部未写入返回 ?', () => {
    expect(pickActive([{ codec: 'flac', lastUpdate: 0 }])).toBe('?');
  });

  it('空列表返回 ?', () => {
    expect(pickActive([])).toBe('?');
  });
});
