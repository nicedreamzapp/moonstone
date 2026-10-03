# Moonstone icon, shaped: no square plate — the icon IS the crescent, a pearly moonstone with blue
# light drifting inside it, a soft violet halo and two sparkles, so it stands out from every square icon.
from PIL import Image, ImageDraw, ImageFilter, ImageChops
S = 4096; M = S // 1024
cx, cy, R = 480*M, 530*M, 360*M; ox, oy, r2 = cx + 185*M, cy - 117*M, 315*M
cres = Image.new("L", (S, S), 0); cd = ImageDraw.Draw(cres)
cd.ellipse([cx-R, cy-R, cx+R, cy+R], fill=255); cd.ellipse([ox-r2, oy-r2, ox+r2, oy+r2], fill=0)
out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# halo
halo = cres.filter(ImageFilter.MaxFilter(1)).filter(ImageFilter.GaussianBlur(55*M)).point(lambda v: int(v*0.85))
out = Image.alpha_composite(out, Image.merge("RGBA", [Image.new("L",(S,S),c) for c in (150,120,255)] + [halo]))
# the stone
stone = Image.new("RGB", (S, S), (244, 246, 253))
sheen = Image.new("RGB", (S, S), (0, 0, 0)); sd = ImageDraw.Draw(sheen)
for (x, y, r, col) in [(250, 520, 170, (40, 110, 255)), (360, 790, 150, (130, 80, 255)), (210, 700, 110, (40, 210, 255)), (560, 900, 90, (90, 140, 255))]:
    sd.ellipse([(x-r)*M, (y-r)*M, (x+r)*M, (y+r)*M], fill=col)
sheen = sheen.filter(ImageFilter.GaussianBlur(85*M))
blue = Image.new("RGB", (S, S), (70, 120, 245))
stone = Image.composite(blue, stone, sheen.convert("L").point(lambda v: min(255, int(v*1.25))))
inner = Image.new("L", (S, S), 0); ImageDraw.Draw(inner).ellipse([ox-r2-50*M, oy-r2-50*M, ox+r2+50*M, oy+r2+50*M], fill=255)
stone = Image.composite(Image.new("RGB", (S, S), (110, 105, 220)), stone, inner.filter(ImageFilter.GaussianBlur(80*M)).point(lambda v: int(v*0.5)))
rim = Image.new("L", (S, S), 0); ImageDraw.Draw(rim).ellipse([cx-R, cy-R, cx+R, cy+R], outline=255, width=16*M)
rim = ImageChops.multiply(rim, cres).filter(ImageFilter.GaussianBlur(7*M))
stone = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), stone, rim)
gl = Image.new("L", (S, S), 0); ImageDraw.Draw(gl).ellipse([175*M, 395*M, 245*M, 465*M], fill=235)
stone = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), stone, gl.filter(ImageFilter.GaussianBlur(18*M)))
out.paste(stone, mask=cres)
# sparkles (four-point stars) in the open side of the crescent
sp = Image.new("L", (S, S), 0); spd = ImageDraw.Draw(sp)
for (x, y, s) in [(760, 330, 66), (850, 545, 40), (690, 700, 28)]:
    X, Y, L, W = x*M, y*M, s*M, s*M*0.18
    spd.polygon([(X, Y-L), (X+W, Y-W), (X+L, Y), (X+W, Y+W), (X, Y+L), (X-W, Y+W), (X-L, Y), (X-W, Y-W)], fill=255)
spg = sp.filter(ImageFilter.GaussianBlur(10*M))
out = Image.alpha_composite(out, Image.merge("RGBA", [Image.new("L",(S,S),c) for c in (190,170,255)] + [spg]))
out = Image.alpha_composite(out, Image.merge("RGBA", [Image.new("L",(S,S),c) for c in (140,110,250)] + [sp]))
core = sp.filter(ImageFilter.MinFilter(9))
out = Image.alpha_composite(out, Image.merge("RGBA", [Image.new("L",(S,S),255)]*3 + [core]))
out.resize((1024, 1024), Image.LANCZOS).save("moonstone-shaped-1024.png")
# preview on light and dark backgrounds, at Dock size too
prev = Image.new("RGB", (1200, 560), (236, 236, 240)); prev.paste((28, 28, 34), (600, 0, 1200, 560))
for i, x in enumerate((40, 640)):
    big = out.resize((420, 420), Image.LANCZOS); prev.paste(big, (x, 20), big)
    sm = out.resize((64, 64), Image.LANCZOS); prev.paste(sm, (x + 470, 470), sm)
prev.save("preview.png"); print("ok")
