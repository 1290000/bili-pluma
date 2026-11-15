"""水平扫描取流账号行，定位头像 / 昵称 / 副标题 / VIP标签 / 胶囊 的 x 范围。"""
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


print(f'=== 取流账号行 y={ROW_TOP}..{ROW_BOT}（高 {ROW_BOT-ROW_TOP}px = {(ROW_BOT-ROW_TOP)/SCALE:.0f} CSS）===')
print()

# 逐列统计：该列在行内有几个"非背景"像素
cols = []
for x in range(PANEL_L, PANEL_R + 1):
    cnt = sum(1 for y in range(ROW_TOP, ROW_BOT) if not is_bg(px(x, y)))
    cols.append((x, cnt))

# 找连续的非空区段（cnt > 0）
segs = []
cur = None
for x, cnt in cols:
    if cnt > 0:
        if cur is None:
            cur = [x, x]
        else:
            cur[1] = x
    else:
        if cur is not None and cur[1] - cur[0] >= 1:
            segs.append(tuple(cur))
        cur = None
if cur is not None:
    segs.append(tuple(cur))

# 合并间距 < 3px 的相邻段（同一"元素"内的字距）
merged = []
for s in segs:
    if merged and s[0] - merged[-1][1] <= 3:
        merged[-1] = (merged[-1][0], s[1])
    else:
        merged.append(list(s))

print('=== 行内非背景区段（PNG px）===')
for i, s in enumerate(merged):
    w_png = s[1] - s[0] + 1
    print(f'  #{i}: x {s[0]:3d}..{s[1]:3d}  宽={w_png:3d}px  = {w_png/SCALE:6.1f} CSS')

print()
print(f'面板内宽（CSS）= {311}px，行 padding 7px 8px → 内容区宽 = {311 - 16}px = {311-16}')
print()

# 右侧区段（标签 + 胶囊）：从右往左看
print('=== 从右往左前 3 段（应为 胶囊 / VIP标签 / 其余）===')
for i, s in enumerate(reversed(merged[-4:])):
    w_png = s[1] - s[0] + 1
    print(f'  右#{i}: x {s[0]:3d}..{s[1]:3d}  宽={w_png:3d}px = {w_png/SCALE:6.1f} CSS')
