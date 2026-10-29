# Traces Katana's picture (src/renderer/img/katana-face.png) into the dot map
# the app draws her face from (src/renderer/js/katanaface.js): each dot's
# brightness, with the background's grey taken out. Run it again after
# changing the picture; the eye and mouth positions are set by hand there.
import base64, re
from PIL import Image

im = Image.open('src/renderer/img/katana-face.png').convert('L')
w, h = im.size
px = list(im.tobytes())
edge = sorted([px[x] for x in range(w)] + [px[(h - 1) * w + x] for x in range(w)] + [px[y * w] for y in range(h)] + [px[y * w + w - 1] for y in range(h)])
bg = min(0.35 * 255, edge[int(len(edge) * 0.6)] + 0.02 * 255)
dots = bytes(max(0, min(255, round((v - bg) / (255 - bg) * 255))) for v in px)
path = 'src/renderer/js/katanaface.js'
src = open(path, encoding='utf8').read()
src = re.sub(r"dots: '[^']*'", f"dots: '{base64.b64encode(dots).decode()}'", src)
src = re.sub(r'width: \d+', f'width: {w}', src, count=1)
src = re.sub(r'height: \d+', f'height: {h}', src, count=1)
open(path, 'w', encoding='utf8', newline='\n').write(src)
print('traced', w, 'x', h)
