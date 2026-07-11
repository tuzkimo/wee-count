#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 WeeCount（一起数钱）应用图标源图。

可爱漫画风：暖白底 + 金色硬币小角色（眼睛/腮红/笑脸）+ ¥ 符号 + 闪光。
输出三张 1024x1024 PNG：
  - app-icon.png   完整图标（桌面 / iOS / Android 旧版 mipmap）
  - app-icon-bg.png  Android 自适应背景层（满铺暖白）
  - app-icon-fg.png  Android 自适应前景层（硬币角色，透明底）

重新生成：python generate_icons.py  然后：npx tauri icon manifest.json
"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# 配色（暖系漫画风，不依赖主题色）
BG = (255, 249, 240, 255)            # #FFF9F0 暖白
GOLD_TOP = (255, 224, 130, 255)      # #FFE082
GOLD_BOTTOM = (255, 202, 40, 255)    # #FFCA28
GOLD_LIGHT = (255, 236, 179, 255)    # #FFECB3 高光
INK = (61, 46, 31, 255)             # #3D2E1F 描线/五官（暖深棕）
PINK = (255, 143, 163, 255)         # #FF8FA3 腮红
SPARKLE = (255, 213, 79, 255)       # #FFD54F 闪光


def find_font(size_px):
    for path in ("C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyh.ttc",
                 "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/arialbd.ttf",
                 "C:/Windows/Fonts/arial.ttf"):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size_px)
            except Exception:
                continue
    return ImageFont.load_default()


def draw_sparkle(draw, cx, cy, r, outline_w):
    """四角星（漫画闪光）。"""
    import math
    pts = []
    for i in range(8):
        ang = math.pi / 2 + i * (math.pi / 4)  # 从顶点开始
        rad = r if i % 2 == 0 else r * 0.38
        pts.append((cx + rad * math.cos(ang), cy - rad * math.sin(ang)))
    draw.polygon(pts, fill=SPARKLE, outline=INK)
    # 描边加粗（polygon outline 较细，再补一圈线段）
    for i in range(len(pts)):
        draw.line([pts[i], pts[(i + 1) % len(pts)]], fill=INK, width=outline_w)


def draw_coin_char(draw, center, radius, font, with_sparkle=True):
    """金色硬币小角色：描边 + 渐变填充 + 高光 + 五官 + ¥ + 闪光。"""
    cx, cy = center
    r = radius
    ow = max(4, int(r * 0.055))  # 描线宽度

    # 1. 硬币主体：底色 + 横向条带模拟竖直渐变（上亮下深）
    inner = int(r * 0.90)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD_TOP)
    # 用横向条带模拟竖直渐变（一段段半透明椭圆切片）
    steps = 40
    for i in range(steps):
        t0 = i / steps
        t1 = (i + 1) / steps
        y0 = cy - r + int(2 * r * t0)
        y1 = cy - r + int(2 * r * t1)
        tc = t0
        rr = int(GOLD_TOP[0] + (GOLD_BOTTOM[0] - GOLD_TOP[0]) * tc)
        gg = int(GOLD_TOP[1] + (GOLD_BOTTOM[1] - GOLD_TOP[1]) * tc)
        bb = int(GOLD_TOP[2] + (GOLD_BOTTOM[2] - GOLD_TOP[2]) * tc)
        # 只画在该高度圆的宽度内
        dy = (y0 + y1) / 2 - cy
        if -r < dy < r:
            w = int((r * r - dy * dy) ** 0.5)
            draw.rectangle([cx - w, y0, cx + w, y1], fill=(rr, gg, bb, 255))

    # 顶部高光弧
    hl_r = int(r * 0.62)
    draw.arc([cx - hl_r, cy - r + int(r * 0.18), cx + hl_r, cy - r + int(r * 0.18) + hl_r * 2],
             start=200, end=340, fill=GOLD_LIGHT, width=max(3, int(r * 0.04)))

    # 3. 外描边（粗，漫画风）
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=INK, width=ow)
    # 内圈细描边
    draw.ellipse([cx - inner, cy - inner, cx + inner, cy + inner],
                 outline=INK, width=max(1, int(r * 0.015)))

    # 4. 五官
    eye_dy = cy - int(r * 0.22)
    eye_dx = int(r * 0.34)
    eye_r = max(4, int(r * 0.085))
    for sx in (-1, 1):
        ex, ey = cx + sx * eye_dx, eye_dy
        draw.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r], fill=INK)
        # 高光小白点
        hr = max(2, int(eye_r * 0.38))
        draw.ellipse([ex + int(eye_r * 0.25) - hr, ey - int(eye_r * 0.30) - hr,
                      ex + int(eye_r * 0.25) + hr, ey - int(eye_r * 0.30) + hr], fill=(255, 255, 255, 255))

    # 腮红（位于笑脸两侧）
    blush_dy = cy + int(r * 0.10)
    blush_dx = int(r * 0.46)
    br_w, br_h = max(3, int(r * 0.12)), max(2, int(r * 0.07))
    for sx in (-1, 1):
        bx = cx + sx * blush_dx
        draw.ellipse([bx - br_w, blush_dy - br_h, bx + br_w, blush_dy + br_h], fill=PINK)

    # 大笑（宽而浅的 ∪，左右拉长，更开心）
    # Pillow arc: 0=东、角度顺时针递增，90=南(底)；30→150 经过南即 ∪
    smile_hw = int(r * 0.40)   # 半宽（左右拉长）
    smile_hh = int(r * 0.24)   # 半高（弧深）
    smile_cy = cy + int(r * 0.30)
    sw = max(3, int(r * 0.06))
    draw.arc([cx - smile_hw, smile_cy - smile_hh, cx + smile_hw, smile_cy + smile_hh],
             start=30, end=150, fill=INK, width=sw)

    # 5. ¥ 符号（下移到中央，像鼻子一样位于眼睛与笑弧之间）
    text = "¥"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = cx - tw / 2 - bbox[0]
    ty = cy + int(r * 0.03) - th / 2 - bbox[1]
    draw.text((tx, ty), text, font=font, fill=INK)

    # 6. 闪光（右上角）
    if with_sparkle:
        draw_sparkle(draw, cx + int(r * 0.78), cy - int(r * 0.82), int(r * 0.16), max(2, int(r * 0.03)))


def make_full_icon():
    img = Image.new("RGBA", (SIZE, SIZE), BG)
    draw = ImageDraw.Draw(img)
    coin_r = int(SIZE * 0.32)
    coin_c = (SIZE // 2, int(SIZE * 0.52))
    font = find_font(int(coin_r * 0.50))
    draw_coin_char(draw, coin_c, coin_r, font, with_sparkle=True)
    return img


def make_bg():
    img = Image.new("RGBA", (SIZE, SIZE), BG)
    return img


def make_fg():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    scale = 0.78
    offset = int(SIZE * (1 - scale) / 2)
    coin_r = int(SIZE * 0.32 * scale)
    coin_c = (int(SIZE * 0.52 * scale) + offset, int(SIZE * 0.52 * scale) + offset)
    font = find_font(int(coin_r * 0.50))
    draw_coin_char(draw, coin_c, coin_r, font, with_sparkle=True)
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    make_full_icon().save(os.path.join(OUT_DIR, "app-icon.png"))
    make_bg().save(os.path.join(OUT_DIR, "app-icon-bg.png"))
    make_fg().save(os.path.join(OUT_DIR, "app-icon-fg.png"))
    print("generated:")
    for f in ("app-icon.png", "app-icon-bg.png", "app-icon-fg.png"):
        p = os.path.join(OUT_DIR, f)
        print(f"  {p}  ({os.path.getsize(p)} bytes)")


if __name__ == "__main__":
    main()
