"""复测：按 find-lines 给出的行区间，量各段的横向宽度与位置。

与改前 measure-bands.py 同口径，只是 y 参数换成新找到的。
"""
import sys
from PIL import Image

img = Image.open('D:/Temp/acct2.png').convert('RGB')
PANEL_L, PANEL_R = 2, 340
SCALE = 339 / 311.0


def px(x, y):
    return img.getpixel((x, y))


def band_bg(y0, y1, x0=PANEL_L, x1=PANEL_R):
    colors = {}
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            c = px(x, y)
            colors[c] = colors.get(c, 0) + 1
    return max(colors, key=colors.get)


def scan(y0, y1, label, merge_gap=4):
    bg = band_bg(y0, y1)
    segs, cur = [], None
    for x in range(PANEL_L, PANEL_R + 1):
        hit = any(px(x, y) != bg for y in range(y0, y1 + 1))
        if hit:
            cur = [x, x] if cur is None else [cur[0], x]
        else:
            if cur is not None and cur[1] - cur[0] >= 1:
                segs.append(tuple(cur))
            cur = None
    if cur is not None:
        segs.append(tuple(cur))
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] <= merge_gap:
            merged[-1] = (merged[-1][0], s[1])
        else:
            merged.append(list(s))
    print(f'\n=== {label}  (y {y0}..{y1})  bg={bg} ===')
    for i, s in enumerate(merged):
        w = s[1] - s[0] + 1
        print(f'  #{i} x {s[0]:3d}..{s[1]:3d}  宽 {w:3d}px = {w/SCALE:6.1f} CSS')
    return merged


# find-lines 给出的行：
#   主账号卡 y 532..587
#   取流账号卡 y 594..667  ← 卡片本体（含昵称/副标题/VIP标签）
#   y 681..691  ← 可能是胶囊行
print('=' * 66)
print('复测扫描（改后）')
print('=' * 66)

scan(532, 587, '主账号卡')
scan(594, 667, '取流账号卡（卡片本体）')
scan(675, 700, '卡片下方区域（找胶囊）')
scan(700, 730, '按钮区')

# 精确找胶囊：在 x 60..200 一带扫 y
print('\n' + '=' * 66)
print('找胶囊所在的竖直位置（x 60..250 内扫）')
print('=' * 66)
for y in range(660, 720):
    bg = band_bg(y, y)
    xs = [x for x in range(60, 260) if px(x, y) != bg]
    if xs:
        print(f'  y={y}: x {min(xs)}..{max(xs)} ({len(xs)} px)')
