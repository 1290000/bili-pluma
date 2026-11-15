"""区分 .acct-main 内上下两行（昵称行 vs 副标题行），并算出真实截断量。

取流行 y=609..681，高 66 CSS。.acct-main 是 flex column：
  上：.acct-name（body 字号）
  下：.acct-sub（caption 字号）
所以按 y 分上半 / 下半分别扫描。
"""
from PIL import Image

img = Image.open('D:/Temp/acct.png').convert('RGB')
PANEL_L, PANEL_R = 2, 340
SCALE = 339 / 311.0
ROW_TOP, ROW_BOT = 609, 681
BG = (232, 241, 250)


def px(x, y):
    return img.getpixel((x, y))


def is_bg(c, tol=12):
    return all(abs(c[i] - BG[i]) <= tol for i in range(3))


def scan(y0, y1, label):
    print(f'\n=== {label}  y={y0}..{y1} ===')
    segs, cur = [], None
    for x in range(PANEL_L, PANEL_R + 1):
        cnt = sum(1 for y in range(y0, y1) if not is_bg(px(x, y)))
        if cnt > 0:
            cur = [x, x] if cur is None else [cur[0], x]
        else:
            if cur is not None and cur[1] - cur[0] >= 1:
                segs.append(tuple(cur))
            cur = None
    if cur is not None:
        segs.append(tuple(cur))
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] <= 3:
            merged[-1] = (merged[-1][0], s[1])
        else:
            merged.append(list(s))
    for i, s in enumerate(merged):
        w = s[1] - s[0] + 1
        print(f'  #{i}: x {s[0]:3d}..{s[1]:3d}  宽={w:3d}px = {w/SCALE:6.1f} CSS')
    return merged


# 竖直方向找文字行：统计每行非背景像素
print('=== 取流行内每行非背景像素数（找文字行）===')
for y in range(ROW_TOP, ROW_BOT, 2):
    cnt = sum(1 for x in range(PANEL_L, PANEL_R + 1) if not is_bg(px(x, y)))
    if cnt > 3:
        print(f'  y={y}: {cnt} px')
