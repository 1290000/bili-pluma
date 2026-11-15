"""复测专用：重新找取流账号行的 y 边界（不写死坐标）。

## 为什么单独写这个
   改前用 measure-lines.py 手工看像素密度定了 y=641..650 / y=659..669。
   胶囊挪行后行高变化 → 必须重新找。

## 做法
   1. 面板 x 边界沿用改前的检测逻辑（measure-png.py 同款：白底扫描）
   2. 在面板竖直范围内逐行统计非背景像素
   3. 找"高密度连续区" = 文字行；行间低谷 = 分隔
   4. 输出所有文字行的 y 区间，供 measure-bands 复用

用法：
   $env:PYTHONIOENCODING="utf-8"
   & $py find-lines.py D:/Temp/acct2.png
"""
import sys
from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else 'D:/Temp/acct2.png'
img = Image.open(path).convert('RGB')
W, H = img.size
print(f'PNG = {W} x {H}')


def px(x, y):
    return img.getpixel((x, y))


# ── 面板 x 边界（与改前同款：白底扫描）──
PL, PR = 2, 340
for y in range(440, min(H, 900), 20):
    xs = [x for x in range(0, min(W, 400)) if all(v > 240 for v in px(x, y))]
    if xs and len(xs) > 100:
        PL, PR = min(xs), max(xs)
        break
print(f'面板 x: {PL}..{PR}  宽 {PR - PL + 1}px')

# ── 逐行非背景像素数 ──
print('\n=== 逐行非背景像素（y : count）===')
rows = []
for y in range(430, min(H, 760)):
    colors = {}
    for x in range(PL, PR + 1):
        c = px(x, y)
        colors[c] = colors.get(c, 0) + 1
    bg = max(colors, key=colors.get)
    cnt = sum(1 for x in range(PL, PR + 1) if px(x, y) != bg)
    rows.append((y, cnt, bg))

maxc = max(c for _, c, _ in rows)
thr = max(8, maxc // 10)
print(f'最大密度 {maxc}，高密度阈值 {thr}')

bands, cur = [], None
for y, c, bg in rows:
    if c >= thr:
        cur = [y, y] if cur is None else [cur[0], y]
    else:
        if cur is not None and cur[1] - cur[0] >= 2:
            bands.append(tuple(cur))
        cur = None
if cur is not None and cur[1] - cur[0] >= 2:
    bands.append(tuple(cur))

print(f'\n=== 检测到 {len(bands)} 个文字行 ===')
for i, (a, b) in enumerate(bands):
    print(f'  #{i}: y {a}..{b}   高 {b - a + 1}px')

print('\n（把需要的行区间填给 measure-bands.py）')
