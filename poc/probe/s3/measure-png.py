"""从截图测量面板账号行的各段宽度。

面板 host 在页面里可读 rect（left/top/width/height），截图是 viewport 的 1:1 像素。
所以面板在 PNG 里的区域 = host rect * 缩放。
"""
import sys
from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else 'D:/Temp/acct.png'
img = Image.open(path).convert('RGB')
W, H = img.size
print(f'PNG size = {W} x {H}')

# 面板区域（从截图肉眼定位，之后用 host rect 校准）
# host rect 在 CSS px，PNG 是 device pixels。devicePixelRatio=1.1
# 但 bsk 截图是否按 DPR 放大？先按 1:1 试，再用边框定位校准。
# 面板左上角在截图里约 (8, 438)，右下角约 (338, 730)
left, top, right, bottom = 0, 420, 345, 740

crop = img.crop((left, top, right, bottom))
crop.save('D:/Temp/panel-crop.png')
print(f'crop = {crop.size}')

# 逐行扫描：找出面板的左右边界（白底 vs 页面背景）
def row_extent(y):
    """返回该行上"面板白底"的 x 范围"""
    xs = [x for x in range(left, right) if img.getpixel((x, y))[0] > 240 and img.getpixel((x, y))[1] > 240 and img.getpixel((x, y))[2] > 240]
    if not xs:
        return None
    return min(xs), max(xs)

print('\n=== 面板左右边界（若干行）===')
for y in range(440, 740, 20):
    e = row_extent(y)
    if e:
        print(f'  y={y}: x {e[0]} .. {e[1]}  宽={e[1]-e[0]+1}')
