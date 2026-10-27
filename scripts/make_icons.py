"""Renders the PerDev logo (same geometry as media/logo.svg) to PNG and ICO.
  python scripts/make_icons.py      (needs Pillow)
Outputs media/perdev.ico (16-256 px) and media/perdev-{128,256,512}.png."""

from pathlib import Path
from PIL import Image, ImageDraw

MEDIA = Path(__file__).resolve().parent.parent / "media"
BG = (11, 13, 20, 255)
BLUE = (45, 91, 255, 255)
S = 8  # supersampling factor over the 256-unit design grid


def cubic(p0, p1, p2, p3, n=64):
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        yield (u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
               u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1])


def line(a, b, n=64):
    for i in range(n + 1):
        t = i / n
        yield (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


# Paths from media/logo.svg
STEM = list(line((84, 48), (84, 212)))
BOWL = [*line((84, 48), (146, 48)), *cubic((146, 48), (190, 48), (206, 76), (206, 104)),
        *cubic((206, 104), (206, 134), (184, 150), (150, 150)), *line((150, 150), (92, 150))]
R = [*cubic((90, 140), (98, 104), (118, 88), (140, 88)), *cubic((140, 88), (150, 88), (157, 92), (162, 100))]


def stroke(draw, pts, width):
    # Dense round dabs give round caps and joins, like stroke-linecap="round".
    r = width * S / 2
    for x, y in pts:
        draw.ellipse([x * S - r, y * S - r, x * S + r, y * S + r], fill=BLUE)


def render(background=True) -> Image.Image:
    img = Image.new("RGBA", (256 * S, 256 * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if background:
        d.rounded_rectangle([0, 0, 256 * S - 1, 256 * S - 1], radius=56 * S, fill=BG)
    stroke(d, STEM, 22)
    stroke(d, BOWL, 20)
    stroke(d, R, 16)
    return img


big = render()
for size in (128, 256, 512):
    big.resize((size, size), Image.LANCZOS).save(MEDIA / f"perdev-{size}.png")
big.resize((256, 256), Image.LANCZOS).save(
    MEDIA / "perdev.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", ", ".join(p.name for p in sorted(MEDIA.glob("perdev*"))))
