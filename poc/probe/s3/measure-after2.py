"""复测 v2：卡片内部前景元素定位。

问题：y 594..667 整段背景都是 (232,241,250)，背景色判定把整行当成"有内容"。
→ 改为：**前景 = 与卡片背景色不同的像素**，且只统计文本灰/深色，不统计浅色圆角。

同时直接找关键文本的 x 范围：
  - 昵称 bili_85872924924 → 深色文本，在卡片左半
  - 副标题 → 中灰文本
  - 年度大会员 → 侧边标签（信息色 蓝紫）
  - 胶囊（在卡片下方 y~681..691）
"""
from PIL import Image

img = Image.open('D:/Temp/acct2.png').convert('RGB')
PANEL_L, PANEL_R = 2, 340
SCALE = 339 / 311.0
CARD_BG = (232, 241, 250)     # 取流卡片背景


def px(x, y):
    return img.getpixel((x, y))


def is_content(c, tol=18):
    """与卡片背景差异明显 = 有内容"""
    return any(abs(c[i] - CARD_BG[i]) > tol for i in range(3))


def scan_card(y0, y1, label):
    """在卡片区域内逐列找有内容的 x"""
    segs, cur = [], None
    for x in range(PANEL_L, PANEL_R + 1):
        hit = any(is_content(px(x, y)) for y in range(y0, y1 + 1))
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
        if merged and s[0] - merged[-1][1] <= 5:
            merged[-1] = (merged[-1][0], s[1])
        else:
            merged.append(list(s))
    print(f'\n=== {label} (y {y0}..{y1}) ===')
    for i, s in enumerate(merged):
        w = s[1] - s[0] + 1
        print(f'  #{i} x {s[0]:3d}..{s[1]:3d}  宽 {w:3d}px = {w/SCALE:6.1f} CSS')
    return merged


# 取流卡片：找它的真实 y 范围（背景 = CARD_BG 的连续区）
print('=== 找取流卡片的 y 范围 ===')
card_ys = []
for y in range(560, 720):
    cnt = sum(1 for x in range(10, 335, 3) if px(x, y) == CARD_BG)
    if cnt > 60:
        card_ys.append(y)
if card_ys:
    print(f'  卡片 y: {min(card_ys)}..{max(card_ys)}')

y0, y1 = min(card_ys), max(card_ys)
print(f'  卡片高 = {y1-y0+1}px = {(y1-y0+1)/SCALE:.1f} CSS')

scan_card(y0, y1, '取流卡片内横向内容')

# 副标题行 / 昵称行 分开
mid = (y0 + y1) // 2
print(f'\n卡片中线 y={mid}')
scan_card(y0, mid, '卡片上半（昵称行）')
scan_card(mid + 1, y1, '卡片下半（副标题行）')

# 胶囊行（卡片下方）
print('\n=== 卡片下方（胶囊）y 范围 ===')
cap_ys = []
for y in range(y1 + 1, min(y1 + 60, 1189)):
    cnt = sum(1 for x in range(10, 335, 2) if px(x, y) != (255, 255, 255))
    if cnt > 3:
        cap_ys.append(y)
if cap_ys:
    print(f'  胶囊区 y: {min(cap_ys)}..{max(cap_ys)}')
    cy0, cy1 = min(cap_ys), max(cap_ys)
    segs, cur = [], None
    for x in range(PANEL_L, PANEL_R + 1):
        hit = any(px(x, y) != (255, 255, 255) for y in range(cy0, cy1 + 1))
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
        if merged and s[0] - merged[-1][1] <= 5:
            merged[-1] = (merged[-1][0], s[1])
        else:
            merged.append(list(s))
    for i, s in enumerate(merged):
        w = s[1] - s[0] + 1
        print(f'  胶囊段 #{i}: x {s[0]:3d}..{s[1]:3d}  宽 {w:3d}px = {w/SCALE:6.1f} CSS')
