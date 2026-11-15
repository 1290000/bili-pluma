"""分上下两行扫描 .acct-main 内内容，并计算截断量。"""
from PIL import Image

img = Image.open('D:/Temp/acct.png').convert('RGB')
PANEL_L, PANEL_R = 2, 340
SCALE = 339 / 311.0
BG = (232, 241, 250)


def px(x, y):
    return img.getpixel((x, y))


def is_bg(c, tol=12):
    return all(abs(c[i] - BG[i]) <= tol for i in range(3))


def scan_band(y0, y1, label, x0=PANEL_L, x1=PANEL_R):
    segs, cur = [], None
    for x in range(x0, x1 + 1):
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
        if merged and s[0] - merged[-1][1] <= 4:
            merged[-1] = (merged[-1][0], s[1])
        else:
            merged.append(list(s))
    print(f'\n=== {label} (y {y0}..{y1}) ===')
    for i, s in enumerate(merged):
        w = s[1] - s[0] + 1
        print(f'  x {s[0]:3d}..{s[1]:3d}  宽={w:3d}px = {w/SCALE:6.1f} CSS')
    return merged


# 昵称行（大字）：约 y=636..652
scan_band(636, 653, '昵称行 .acct-name 区域')
# 副标题行（小字）：约 y=655..672
scan_band(655, 673, '副标题行 .acct-sub 区域')

print('\n' + '=' * 60)
print('结论计算')
print('=' * 60)
print(f'面板 CSS 宽      = 311')
print(f'行 padding 8*2   = 16')
print(f'内容区宽         = {311-16} CSS')
print(f'avatar 24 + gap 8 = 32')
print(f'.acct-main 可分配 = {311-16-32} = {311-16-32} CSS')
print(f'.acct-tag(年度大会员) + gap 8 + 胶囊')
