/**
 * 二维码矩阵生成 —— 唯一引入外部依赖的地方，所以放在 platform 而不是 core。
 *
 * 只输出模块矩阵，不输出图片：渲染由 UI 层用 canvas 自己做。
 * 这和"页内角标不上框架"是同一个取向——不引入我们不需要的渲染器。
 */

import qrcode from 'qrcode-generator';

export interface QrMatrix {
  /** 边长（模块数，不含静区） */
  size: number;
  /** cells[row][col] = true 表示深色模块 */
  cells: boolean[][];
}

/**
 * @param text 要编码的内容（B站给的是一个 URL）
 * @param errorCorrection 'L' | 'M' | 'Q' | 'H'，默认 M（约 15% 容错，屏幕扫码够用）
 */
export function buildQrMatrix(text: string, errorCorrection: 'L' | 'M' | 'Q' | 'H' = 'M'): QrMatrix {
  if (text.length === 0) throw new Error('二维码内容不能为空');

  // typeNumber = 0 表示按内容长度自动选版本
  const qr = qrcode(0, errorCorrection);
  qr.addData(text);
  qr.make();

  const size = qr.getModuleCount();
  const cells: boolean[][] = [];

  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col += 1) {
      line.push(qr.isDark(row, col));
    }
    cells.push(line);
  }

  return { size, cells };
}
