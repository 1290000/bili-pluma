"""复测终版：量三行文本的横向宽度 + .acct-main 可用宽度。"""
from PIL import Image

img = Image.open('D:/Temp/acct2.png').convert('RGB')
PANEL_L, PANEL_R = 2, 340
SCALE = 339 / 311.0
CARD_BG = (232, 241, 250)
PANEL_CSS = 311.0


def px(x, y):
    return img.getpixel((x, y))


def is_content(c, tol=18):
    return any(abs(c[i] - CARD_BG[i]) > tol for i in range(3))


def extent(y0, y1, x0=10, x1=340):
    xs = [x for x in range(x0, x1 + 1) if any(is_content(px(x, y)) for y in range(y0, y1 + 1))]
    return (min(xs), max(xs)) if xs else None


print('=' * 66)
print('改后：取流卡片三行文本的横向范围')
print('=' * 66)
lines = [
    ('昵称  {{取流账号昵称}}', 609, 618),
    ('副标题 仅取流 · 6 个月后到期', 628, 638),
    ('第三行 1 天前校验', 646, 656),
]
for name, a, b in lines:
    e = extent(a, b, 55, 250)   # 只看 .acct-main 区（x>55 避开头像）
    if e:
        w = e[1] - e[0] + 1
        print(f'  {name}')
        print(f'      x {e[0]:3d}..{e[1]:3d}   宽 {w:3d}px = {w/SCALE:6.1f} CSS')

# 年度大会员（右侧）
print('\n  右侧标签：')
e = extent(609, 638, 250, 340)
if e:
    w = e[1] - e[0] + 1
    print(f'      x {e[0]:3d}..{e[1]:3d}   宽 {w:3d}px = {w/SCALE:6.1f} CSS   (年度大会员)')

# 胶囊（卡片下方）
print('\n  卡片下方胶囊（y 681..691）：')
e = extent(678, 695, 10, 340)
if e:
    w = e[1] - e[0] + 1
    print(f'      x {e[0]:3d}..{e[1]:3d}   宽 {w:3d}px = {w/SCALE:6.1f} CSS   (取流：扩展账号)')

print('\n' + '=' * 66)
print('布局对比')
print('=' * 66)
print(f'  面板宽 = {PANEL_CSS} CSS')
print(f'  行 padding 8*2 = 16  → 内容区 295')
print(f'  avatar 24 + gap 8 = 32')
print()
print('  【改前】行内还有 VIP标签(25.7) + 胶囊(67.0) + 2个gap(16) = 108.7')
print(f'         → .acct-main 可用 = 295 - 32 - 108.7 = 154.3 CSS')
print()
print('  【改后】胶囊移到卡片外 → 行内只剩 VIP标签 + 1个gap')
