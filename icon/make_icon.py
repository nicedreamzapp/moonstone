# Moonstone icon: a pearly crescent moon cut from moonstone (blue glow inside the stone) on a night-sky
# squircle with the app's own aurora colors. Rendered at 4x and scaled down for clean edges.
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import math, random
S = 4096; M = S // 1024
def squircle(size, inset, n=5.0):
    m = Image.new("L", (size, size), 0); d = ImageDraw.Draw(m)
    a = (size - 2*inset) / 2; c = size / 2; pts = []
    for i in range(2000):
        t = 2*math.pi*i/2000; ct, st = math.cos(t), math.sin(t)
        pts.append((c + a*math.copysign(abs(ct)**(2/n), ct), c + a*math.copysign(abs(st)**(2/n), st)))
    d.polygon(pts, fill=255); return m
mask = squircle(S, 100*M)
# night sky
bg = Image.new("RGB", (S, S)); px = bg.load()
top, bot = (12, 14, 40), (30, 16, 62)
grad = Image.linear_gradient("L").resize((S, S))
bg = Image.composite(Image.new("RGB", (S, S), bot), Image.new("RGB", (S, S), top), grad)
# aurora blobs
aur = Image.new("RGB", (S, S), (0, 0, 0)); ad = ImageDraw.Draw(aur)
for (x, y, r, col) in [(260, 300, 330, (120, 80, 255)), (760, 260, 300, (40, 200, 190)), (520, 820, 380, (190, 70, 200))]:
    ad.ellipse([(x-r)*M, (y-r)*M, (x+r)*M, (y+r)*M], fill=col)
aur = aur.filter(ImageFilter.GaussianBlur(170*M))
bg = ImageChops.add(bg, ImageChops.multiply(aur, Image.new("RGB", (S, S), (150, 150, 150))))
# stars
random.seed(7); sd = ImageDraw.Draw(bg)
for _ in range(38):
    x, y, r = random.uniform(140, 884), random.uniform(140, 884), random.choice([2, 2, 3, 4])
    if math.hypot(x-560, y-500) < 330: continue
    b = random.randint(170, 255); sd.ellipse([(x-r)*M, (y-r)*M, (x+r)*M, (y+r)*M], fill=(b, b, 255))
# crescent shape
cx, cy, R = 540*M, 512*M, 300*M; ox, oy, r2 = cx + 150*M, cy - 95*M, 262*M
cres = Image.new("L", (S, S), 0); cd = ImageDraw.Draw(cres)
cd.ellipse([cx-R, cy-R, cx+R, cy+R], fill=255); cd.ellipse([ox-r2, oy-r2, ox+r2, oy+r2], fill=0)
# outer glow
glow = Image.new("RGB", (S, S), (0, 0, 0)); glow.paste((110, 170, 255), mask=cres.filter(ImageFilter.GaussianBlur(60*M)))
bg = ImageChops.add(bg, glow.filter(ImageFilter.GaussianBlur(40*M)))
# the stone: milky pearl with blue light drifting through it (adularescence)
stone = Image.new("RGB", (S, S), (226, 232, 246))
sheen = Image.new("RGB", (S, S), (0, 0, 0)); shd = ImageDraw.Draw(sheen)
for (x, y, r, col) in [(390, 470, 150, (60, 120, 255)), (470, 690, 120, (120, 90, 255)), (330, 600, 90, (80, 220, 255))]:
    shd.ellipse([(x-r)*M, (y-r)*M, (x+r)*M, (y+r)*M], fill=col)
sheen = sheen.filter(ImageFilter.GaussianBlur(70*M))
stone = ImageChops.subtract(stone, ImageChops.invert(ImageChops.add(Image.new("RGB",(S,S),(105,105,105)), sheen)).point(lambda v: int(v*0.55)))
# soft shading toward the inner edge, bright rim highlight on the outer edge
inner = Image.new("L", (S, S), 0); ImageDraw.Draw(inner).ellipse([ox-r2-40*M, oy-r2-40*M, ox+r2+40*M, oy+r2+40*M], fill=255)
inner = inner.filter(ImageFilter.GaussianBlur(70*M))
stone = Image.composite(Image.new("RGB", (S, S), (130, 150, 215)), stone, inner.point(lambda v: int(v*0.6)))
rim = Image.new("L", (S, S), 0); rd = ImageDraw.Draw(rim)
rd.ellipse([cx-R, cy-R, cx+R, cy+R], outline=255, width=14*M)
rim = ImageChops.multiply(rim, cres).filter(ImageFilter.GaussianBlur(6*M))
stone = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), stone, rim)
bg.paste(stone, mask=cres)
# a small glint
gl = Image.new("L", (S, S), 0); gd = ImageDraw.Draw(gl)
gd.ellipse([300*M, 380*M, 352*M, 432*M], fill=230); gl = gl.filter(ImageFilter.GaussianBlur(14*M))
bg = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), bg, ImageChops.multiply(gl, cres))
out = Image.new("RGBA", (S, S), (0, 0, 0, 0)); out.paste(bg, mask=mask)
# thin bright edge on the plate so it pops in a dark Dock
edge = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(9))).filter(ImageFilter.GaussianBlur(2*M))
out = Image.alpha_composite(out, Image.merge("RGBA", [Image.new("L",(S,S),180)]*3 + [edge.point(lambda v: int(v*0.35))]))
out.resize((1024, 1024), Image.LANCZOS).save("moonstone-1024.png")
print("ok")
