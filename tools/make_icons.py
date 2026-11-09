"""Generate SelectEnglish extension icons (kraft paper look)."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
os.makedirs(OUT, exist_ok=True)

FONTS = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]

SCALE = 8
SIZE = 128


def font(size):
    for path in FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return None


def make(size):
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # kraft paper gradient
    for y in range(s):
        t = y / max(1, s - 1)
        r = int(248 + (233 - 248) * t)
        g = int(239 + (214 - 239) * t)
        b = int(221 + (178 - 221) * t)
        d.line([(0, y), (s, y)], fill=(r, g, b, 255))

    # subtle diagonal fibers
    for i in range(0, s * 2, max(2, s // 40)):
        d.line([(i, 0), (0, i)], fill=(150, 120, 80, 12), width=max(1, s // 160))

    # rounded mask
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.24), fill=255)
    img.putalpha(mask)

    # border
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.24),
                        outline=(186, 158, 116, 255), width=max(2, s // 32))

    f = font(int(s * 0.62))
    text = "译"
    if f is not None:
        box = d.textbbox((0, 0), text, font=f)
        x = (s - (box[2] - box[0])) / 2 - box[0]
        y = (s - (box[3] - box[1])) / 2 - box[1]
    else:
        f = ImageFont.load_default()
        x = y = s * 0.3
    d.text((x, y), text, font=f, fill=(59, 42, 26, 255))

    return img.resize((size, size), Image.LANCZOS)


for px in (16, 32, 48, 128):
    make(px).save(os.path.join(OUT, f"icon{px}.png"))
    print("wrote", os.path.join(OUT, f"icon{px}.png"))
