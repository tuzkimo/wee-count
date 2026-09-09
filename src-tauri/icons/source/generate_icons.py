#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 WeeCount（一起数钱）应用图标源图。

极简风：纯白底 + 胖胖猪肉体（にくまるフォント）黑字「銭」。
输出 1024x1024 PNG：
  - app-icon.png            完整图标（桌面 / iOS / Android 旧版 mipmap / favicon）
  - app-icon-bg.png         Android 自适应背景层（纯白满铺）
  - app-icon-fg.png         Android 自适应前景层（「銭」，透明底）
  - app-icon-monochrome.png Android 13+ 主题图标蒙版层（字形剪影，透明底）

字体：fonts/PangPangZhu.otf（OFL 免费商用，来源见 fonts/README.md）。
注：该字体为日文字体，无简体「钱」字形，故用日文形「銭」。

重新生成：python generate_icons.py
然后（本目录内）：npx tauri icon manifest.json
"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
FONT_PATH = os.path.join(OUT_DIR, "fonts", "PangPangZhu.otf")

WHITE = (255, 255, 255, 255)
BLACK = (0, 0, 0, 255)
CHAR = "銭"

# 字形最长边占画布比例
GLYPH_FULL = 0.63  # 完整图标（桌面/favicon，留白约 18%）
GLYPH_FG = 0.50    # 自适应前景层（manifest 里 android_fg_scale=85 再缩，
                   # 落在启动器可见区内约 64%，字形角不出 66dp 安全区）
GLYPH_MONO = 0.60  # 主题图标蒙版层


def draw_centered(canvas, glyph_ratio):
    """把「銭」按比例居中画到画布上，返回字形实际像素尺寸。"""
    d = ImageDraw.Draw(canvas)
    probe = ImageFont.truetype(FONT_PATH, 256)
    bbox = d.textbbox((0, 0), CHAR, font=probe)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    font = ImageFont.truetype(FONT_PATH, int(256 * SIZE * glyph_ratio / max(w, h)))
    bbox = d.textbbox((0, 0), CHAR, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((SIZE - w) / 2 - bbox[0], (SIZE - h) / 2 - bbox[1]), CHAR, font=font, fill=BLACK)
    return (w, h)


def make_full_icon():
    img = Image.new("RGBA", (SIZE, SIZE), WHITE)
    draw_centered(img, GLYPH_FULL)
    return img


def make_bg():
    return Image.new("RGBA", (SIZE, SIZE), WHITE)


def make_fg():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_centered(img, GLYPH_FG)
    return img


def make_monochrome():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_centered(img, GLYPH_MONO)
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    outputs = [
        ("app-icon.png", make_full_icon()),
        ("app-icon-bg.png", make_bg()),
        ("app-icon-fg.png", make_fg()),
        ("app-icon-monochrome.png", make_monochrome()),
    ]
    for name, img in outputs:
        path = os.path.join(OUT_DIR, name)
        img.save(path)
        print(f"  {path}  ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
