"""Renders the Katana logo (macOS style: a dark glass squircle, a silver sword) to assets/katana.png and assets/katana.ico. Run again after changing it."""
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

assets = Path(__file__).resolve().parent.parent / 'assets'
SCALE = 4  # drawn this much larger, then brought down, for smooth edges


def squircle(size, box):
    """A mask: Apple's continuous corners, approximated by a superellipse."""
    x0, y0, x1, y1 = box
    cx, cy, a, b = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    n = 5.0
    points = []
    for i in range(720):
        t = 2 * math.pi * i / 720
        ct, st = math.cos(t), math.sin(t)
        points.append((cx + a * math.copysign(abs(ct) ** (2 / n), ct), cy + b * math.copysign(abs(st) ** (2 / n), st)))
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def gradient(size, top, bottom):
    """A vertical gradient (RGB tuples) as an image."""
    column = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        column.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return column.resize((size, size))


def sword(size, width_scale=1.0):
    """The sword's shape as a mask: a long blade and a short guard across it, on the logo's diagonal."""
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    u = size / 512
    blade = 27 * u * width_scale
    guard = 25 * u * width_scale
    # (From the old logo's proportions: point at top right, handle at bottom left.)
    d.line([(362 * u, 130 * u), (116 * u, 422 * u)], fill=255, width=round(blade), joint='curve')
    for x, y in [(362 * u, 130 * u), (116 * u, 422 * u)]:
        d.ellipse([x - blade / 2, y - blade / 2, x + blade / 2, y + blade / 2], fill=255)
    d.line([(193 * u, 297 * u), (241 * u, 346 * u)], fill=255, width=round(guard))
    for x, y in [(193 * u, 297 * u), (241 * u, 346 * u)]:
        d.ellipse([x - guard / 2, y - guard / 2, x + guard / 2, y + guard / 2], fill=255)
    return mask


def render(size):
    big = size * SCALE
    u = big / 512
    out = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    # Just room for the shadow, tighter than Apple's grid so it reads large on a taskbar; small icons need every pixel.
    margin = (26 if size >= 64 else 12 if size >= 32 else 3) * u
    box = (margin, margin * 0.9, big - margin, big - margin * 1.1)
    mask = squircle(big, box)

    # A soft shadow under the tile.
    if size >= 48:
        shadow = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        shadow.paste((0, 0, 0, 120), (0, round(10 * u)), mask)
        out = Image.alpha_composite(out, shadow.filter(ImageFilter.GaussianBlur(14 * u)))

    # Dark glass: lit from the top.
    tile = gradient(big, (88, 94, 102), (17, 19, 22)).convert('RGBA')
    glow = Image.new('L', (big, big), 0)
    cx = big / 2
    ImageDraw.Draw(glow).ellipse([cx - 300 * u, -330 * u, cx + 300 * u, 170 * u], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(60 * u))
    tile = Image.composite(Image.new('RGBA', (big, big), (255, 255, 255, 255)), tile, glow)
    tile.putalpha(mask)
    out = Image.alpha_composite(out, tile)

    # The sword, silver, with a small shadow of its own.
    shape = ImageChops.multiply(sword(big), mask)
    if size >= 32:
        drop = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        drop.paste((0, 0, 0, 150), (round(3 * u), round(9 * u)), shape)
        out = Image.alpha_composite(out, drop.filter(ImageFilter.GaussianBlur(9 * u)))
    silver = gradient(big, (255, 255, 255), (190, 196, 204)).convert('RGBA')
    silver.putalpha(shape)
    out = Image.alpha_composite(out, silver)

    # The glass's bright rim along the top, fading down the sides.
    if size >= 32:
        edge = ImageChops.subtract(mask, squircle(big, (box[0] + 3 * u, box[1] + 3 * u, box[2] - 3 * u, box[3] - 3 * u)))
        fade = gradient(big, (150, 150, 150), (30, 30, 30)).convert('L')
        rim = Image.new('RGBA', (big, big), (255, 255, 255, 0))
        rim.putalpha(ImageChops.multiply(edge, fade))
        out = Image.alpha_composite(out, rim)
    return out.resize((size, size), Image.LANCZOS)


render(512).save(assets / 'katana.png')
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
big = render(256)
big.save(assets / 'katana.ico', sizes=[(s, s) for s in sizes], append_images=[render(s) for s in sizes])
print('wrote', assets / 'katana.png', assets / 'katana.ico')
