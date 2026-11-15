"""按精确 y 分带扫描，得到昵称行 / 副标题行各自的横向分布。"""
from PIL import Image

img = Image.open('D:/Temp/acct.png').convert('RGB')
PANEL_L, PANEL_R = 2, 340
SCALE = 339 / 311.0
BG = (232, 241, 250)


def px(x, y):
    return img.getpixel((x, y))


def is_bg(c, tol=14):
    return all(abs(c[i] - BG[i]) <= tol for i in range(3))


def band(y0, y1, label):
    segs, cur = [], None
    for x in range(PANEL_L, PANEL_R + 1):
        cnt = sum(1 for y in range(y0, y1 + 1) if not is_bg(px(x, y)))
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
    total = segs[-1][1] - segs[0][0] + 1 if segs else 0
    print(f'\n=== {label} (y {y0}..{y1}) ===')
    for i, s in enumerate(merged):
        w = s[1] - s[0] + 1
        print(f'  #{i} x {s[0]:3d}..{s[1]:3d}  宽={w:3d}px = {w/SCALE:6.1f} CSS')
    if merged:
        span = merged[-1][1] - merged[0][0] + 1
        print(f'  总跨度 = {span}px = {span/SCALE:.1f} CSS')
    return merged


band(641, 650, '昵称/主文字行')
band(659, 669, '副标题行')

print('\n' + '=' * 64)
print('横向映射（面板左缘 x=2 PNG = CSS 0）')
print('=' * 64)
print('  行 padding-left 8 CSS  = 8.7 PNG → x≈10.7')
print('  avatar 24 CSS          = 26.2 PNG → x 10.7..36.9')
print('  gap 8 CSS              = 8.7 PNG  → x 36.9..45.6')
print('  .acct-main 起点 ≈ x46 PNG')
print('  从实测：x61 起才是文字 → 说明 .acct-main 起点约 x46，文字有内偏移')
