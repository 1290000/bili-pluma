"""按 CSS 规则 + 实测像素，算出 .acct-main 的真实可用宽度与截断量。"""

PANEL_CSS = 311.0
ROW_PAD = 8          # .acct-row padding 7px 8px
GAP = 8              # .acct-row gap 8px
AVATAR = 24          # .acct-avatar 24x24

# 实测（PNG px → CSS，scale 1.090）
SCALE = 339 / 311.0

def to_css(px):
    return px / SCALE

# 从"昵称行"扫描得到的横向条带（x 是 PNG 绝对坐标，面板起点 2）
# x 2..52   → 行左 padding + avatar 区
# x 61..148 → 昵称（两段 61..102, 107..148，中间是字符间隙）
# x 162..222→ 副标题列（这一带在昵称行也有内容？其实是 .acct-sub 的第二行在更下方）
# x 232..259→ 年度大会员
# x 268..340→ 胶囊

print('=' * 64)
print('横向分段（换算成 CSS px，面板左边缘 = x2 PNG）')
print('=' * 64)
segs = {
    '行左padding+avatar区': (2, 52),
    '昵称 bili_8587292...': (61, 148),
    '副标题 仅取流·6个月...': (162, 222),
    '年度大会员': (232, 259),
    '胶囊 取流：扩展账号': (268, 340),
}
for k, (a, b) in segs.items():
    print(f'  {k:<24} PNG x{a:3d}..{b:3d}  宽 {to_css(b-a+1):6.1f} CSS')

print()
print('=' * 64)
print('flex 布局可用宽计算')
print('=' * 64)
content = PANEL_CSS - ROW_PAD * 2
print(f'  面板           = {PANEL_CSS}')
print(f'  行内 padding   = {ROW_PAD}*2 = {ROW_PAD*2}  → 内容区 {content}')
# flex items: avatar, acct-main, tag(年度大会员), pill
# gaps between 4 items = 3 gaps
n_items = 4
total_gap = GAP * (n_items - 1)
print(f'  gap {GAP} x {n_items-1}     = {total_gap}')
print(f'  avatar         = {AVATAR}')
fixed = AVATAR + total_gap
print(f'  固定占用       = {fixed}')
remain = content - fixed
print(f'  剩余给 [.acct-main + 年度大会员 + 胶囊] = {remain:.1f} CSS')

# 实测两标签宽
tag_w = to_css(28)
pill_w = to_css(73)
print(f'  其中 年度大会员 实测 = {tag_w:.1f} CSS')
print(f'  其中 胶囊       实测 = {pill_w:.1f} CSS')
main_w = remain - tag_w - pill_w
print(f'  → .acct-main 理论可用 = {remain:.1f} - {tag_w:.1f} - {pill_w:.1f} = {main_w:.1f} CSS')

print()
print('=' * 64)
print('标签合计占比')
print('=' * 64)
tags = tag_w + pill_w
print(f'  年度大会员 + 胶囊 = {tag_w:.1f} + {pill_w:.1f} = {tags:.1f} CSS')
print(f'  占行内容区({content:.0f}) 的 {tags/content*100:.1f}%')
print(f'  占面板({PANEL_CSS}) 的 {tags/PANEL_CSS*100:.1f}%')
print(f'  判据「⑥+⑦ 超过 ② 的一半」：②=行宽 {content:.0f}，一半={content/2:.1f}')
print(f'    → {tags:.1f} vs {content/2:.1f}  = {"超过 ✅" if tags > content/2 else "未超过"}')
print(f'  判据「超过 .acct-row.playback 的一半」：② 行宽 {content:.0f}，一半 {content/2:.1f}')
print(f'    → {tags:.1f} > {content/2:.1f} ? {tags > content/2}')

print()
print('=' * 64)
print('昵称/副标题截断判断')
print('=' * 64)
nickname_full = '{{取流账号昵称}}'
nickname_shown = 'bili_8587292...'
sub_full = '仅取流 · 6 个月后到期'
sub_shown = '仅取流 · 6 个月...'
print(f'  昵称完整 = {nickname_full}  ({len(nickname_full)} 字符)')
print(f'  昵称显示 = {nickname_shown}   → 截断了 {len(nickname_full)-len("bili_8587292")} 个字符')
print(f'  副标题完整 = {sub_full} ({len(sub_full)} 字符)')
print(f'  副标题显示 = {sub_shown}  → 截断')
print(f'  .acct-main 可用 {main_w:.1f} CSS，要放 15 字符昵称 + 副标题 → 必然截断')
