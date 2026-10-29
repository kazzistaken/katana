"""Renders the Katana logo (crimson tile, white sword) to assets/katana.png and assets/katana.ico.
Geometry is traced from the reference logo on a 0..100 tile; run: python scripts/build-logo.py"""
from pathlib import Path
from PIL import Image, ImageDraw

RED, WHITE = (163, 21, 58, 255), (230, 233, 235, 255)
MARGIN, RADIUS, STROKE = 4, 13.5, 6.4          # in tile units (tile = 100)
BLADE = ((72.4, 23.4), (20.6, 85.2))
GUARD = ((37.0, 59.0), (47.0, 69.0))

def render(size, ss=8):
    n = size * ss
    k = n / (100 + 2 * MARGIN)
    p = lambda x, y: ((x + MARGIN) * k, (y + MARGIN) * k)
    im = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([p(0, 0), p(100, 100)], radius=RADIUS * k, fill=RED)
    w = STROKE * k
    for a, b in (BLADE, GUARD):
        d.line([p(*a), p(*b)], fill=WHITE, width=round(w))
        for x, y in (a, b):
            cx, cy = p(x, y)
            d.ellipse([cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2], fill=WHITE)
    return im.resize((size, size), Image.LANCZOS)

assets = Path(__file__).resolve().parent.parent / 'assets'
render(512).save(assets / 'katana.png')
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
big = render(256)
big.save(assets / 'katana.ico', sizes=[(s, s) for s in sizes], append_images=[render(s) for s in sizes[:-1]])
print('wrote', assets / 'katana.png', assets / 'katana.ico')
