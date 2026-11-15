// 从截图像素里量面板各段宽度
//
// ## 为什么用截图
//   面板是 mode:'closed' shadow，页面侧读不到内部元素
//   bsk snapshot / observe 只给文本，不给尺寸
//   → 唯一能拿到内部几何的自动手段是**截图 + 像素测量**
//
// ## 做法
//   1. 截图 viewport
//   2. 面板 host 在页面里可读 rect（left/top/width/height）
//   3. 在截图里裁剪面板区域，按行扫描非背景像素 → 得到每段的 x 范围
//
// 依赖：Pillow（bundled python 有）
import fs from 'node:fs';

console.log('本脚本需要先截图。请分两步：');
console.log('1) bsk screenshot --session <sid> --tab-id <tab> --out D:/Temp/panel.png');
console.log('2) node poc/probe/s3/measure-png.py');
