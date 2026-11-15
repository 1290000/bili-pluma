"""核对：.acct-main 可用 154 CSS，为何昵称只占 80 / 副标题只占 56？

可能原因：.acct-name / .acct-sub 是 .acct-main（flex column）的子项，
默认 align-items: stretch 应该拉满 154。截断到 80/56 说明**另有约束**。

检查：.acct-tag 与胶囊是否真的占 25.7 / 67 CSS，
或截图里 x162..222 与 x232..259 其实**属于 .acct-main 的第二列**？

→ 关键：y=636..653 这一带扫到的 5 段，可能同时包含 .acct-name（上行）和
   .acct-sub（下行）的像素，因为两行在竖直方向**有重叠的 y 范围**。
"""
from PIL import Image

img = Image.open('D:/Temp/acct.png').convert('RGB')
PANEL_L, PANEL_R = 2, 340
SCALE = 339 / 311.0
BG = (232, 241, 250)


def px(x, y):
    return img.getpixel((x, y))


def is_bg(c, tol=12):
    return all(abs(c[i] - BG[i]) <= tol for i in range(3))


# 找精确的文字行 y 边界：逐行统计，行内空白处 cnt 会骤降
print('=== 取流行 y=609..681 逐行像素数（步长 1）===')
rows = []
for y in range(609, 682):
    cnt = sum(1 for x in range(PANEL_L, PANEL_R + 1) if not is_bg(px(x, y)))
    rows.append((y, cnt))

# 找 cnt 的局部低谷 → 行分隔
print('y: cnt')
for y, c in rows:
    bar = '#' * min(c // 4, 40)
    print(f'  {y}: {c:3d} {bar}')
