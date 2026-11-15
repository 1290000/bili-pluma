"""精确测量取流账号行（.acct-row.playback）内各段宽度。

坐标系：
  host rect（CSS px，页面可读）→ PNG 像素 = CSS * DPR
  DPR 实测 1.1，面板 CSS 宽 311 → PNG 宽应 ≈ 342（实测 339，吻合）
"""
import sys
from PIL import Image

path = 'D:/Temp/acct.png'
img = Image.open(path).convert('RGB')
W, H = img.size

# 面板在 PNG 里的边界（上行扫描已测）
PANEL_L, PANEL_R = 2, 340
PANEL_W_PNG = PANEL_R - PANEL_L + 1   # 339
CSS_W = 311.0
SCALE = PANEL_W_PNG / CSS_W
print(f'PNG panel width = {PANEL_W_PNG}px, CSS = {CSS_W}px, scale = {SCALE:.3f}')

# ── 找取流账号行的垂直范围 ──
# 该行背景是 accent-bg（淡蓝紫），与主账号行（灰）不同
# 从截图看：主账号行约 y=540..590，取流行约 y=595..680
def px(x, y):
    return img.getpixel((x, y))

print('\n=== 垂直扫描：找两行账号卡的分界 ===')
prev = None
for y in range(530, 700):
    c = px(PANEL_L + 60, y)   # 面板左侧内一点
    if c != prev:
        print(f'  y={y}: rgb={c}')
        prev = c
