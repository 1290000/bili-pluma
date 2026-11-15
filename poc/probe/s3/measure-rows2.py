"""复测 v3：精确分离昵称行 / 副标题行，确认是否截断。

改后结构（从截图确认）：
  取流卡片 y 595..666（高 72px = 66 CSS）
    ├ 头像「取」
    ├ 昵称 {{取流账号昵称}}（完整）
    ├ 副标题 仅取流 · 6 个月后到期（完整）
    └ ...
   右：年度大会员
  卡片下方 y ~681..691：取流：扩展账号（胶囊单独一行）

判据：
  - 昵称文本实际宽度 vs .acct-main 可用宽度
  - 副标题文本实际宽度 vs 同上
  - 是否出现省略号（...）
"""
from PIL import Image

img = Image.open('D:/Temp/acct2.png').convert('RGB')
PANEL_L, PANEL_R = 2, 340
SCALE = 339 / 311.0
CARD_BG = (232, 241, 250)


def px(x, y):
    return img.getpixel((x, y))


def is_content(c, tol=18):
    return any(abs(c[i] - CARD_BG[i]) > tol for i in range(3))


# ── 逐行找文本行（卡片内）──
print('=== 卡片内逐行像素（找两行文本 y 区间）===')
rows = []
for y in range(595, 667):
    cnt = sum(1 for x in range(55, 250) if is_content(px(x, y)))
    rows.append((y, cnt))
    bar = '#' * min(cnt, 30)
    print(f'  y={y}: {cnt:3d} {bar}')
