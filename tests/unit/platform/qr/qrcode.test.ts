import { describe, expect, it } from 'vitest';

import { buildQrMatrix } from '@platform/qr/qrcode';

describe('buildQrMatrix', () => {
  it('输出方阵，边长符合 QR 规范（21 + 4n）', () => {
    const { size, cells } = buildQrMatrix('https://example.com');
    expect(cells).toHaveLength(size);
    expect(cells.every((row) => row.length === size)).toBe(true);
    expect((size - 21) % 4).toBe(0);
  });

  it('三个角落有定位图案（外框为深色）', () => {
    const { size, cells } = buildQrMatrix('https://example.com');
    expect(cells[0]?.[0]).toBe(true);
    expect(cells[0]?.[size - 1]).toBe(true);
    expect(cells[size - 1]?.[0]).toBe(true);
  });

  it('定位图案中心是 3×3 深色块', () => {
    const { cells } = buildQrMatrix('https://example.com');
    for (let r = 2; r <= 4; r += 1) {
      for (let c = 2; c <= 4; c += 1) {
        expect(cells[r]?.[c]).toBe(true);
      }
    }
  });

  it('定位图案与数据区之间有白色分隔带', () => {
    const { cells } = buildQrMatrix('https://example.com');
    // 左上定位图案占 0..6，第 7 行/列应为浅色分隔带
    for (let i = 0; i <= 7; i += 1) {
      expect(cells[7]?.[i]).toBe(false);
      expect(cells[i]?.[7]).toBe(false);
    }
  });

  it('内容不同则矩阵不同', () => {
    const a = buildQrMatrix('https://example.com/a');
    const b = buildQrMatrix('https://example.com/b');
    expect(JSON.stringify(a.cells)).not.toBe(JSON.stringify(b.cells));
  });

  it('内容相同则矩阵完全一致（可复现）', () => {
    const a = buildQrMatrix('https://example.com/same');
    const b = buildQrMatrix('https://example.com/same');
    expect(a).toEqual(b);
  });

  it('内容变长时版本号上升（边长变大或不变）', () => {
    const short = buildQrMatrix('a');
    const long = buildQrMatrix('x'.repeat(300));
    expect(long.size).toBeGreaterThan(short.size);
  });

  it('空内容抛错', () => {
    expect(() => buildQrMatrix('')).toThrow(/不能为空/);
  });
});
