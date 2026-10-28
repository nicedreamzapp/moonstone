# Moonstone icons (10/26): ONE source of truth = the iPhone app icon (translucent ringed moonstone on deep
# blue, shared/moonstone-ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png). Every other Moonstone
# icon (Mac app, Windows, docs, favicon) is derived from it here. The old purple-tile and crescent icons are retired.
import sys, os, subprocess, shutil
from PIL import Image, ImageDraw, ImageFilter
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
art = Image.open(src).convert("RGBA").resize((1024, 1024), Image.LANCZOS)
art.save(os.path.join(out, "moonstone-1024.png"))                      # full-bleed square (iOS-style art)
# macOS-style: the art in a rounded-square plate on the standard 824/1024 grid with a soft shadow
S, P = 1024, 824
plate = art.resize((P, P), Image.LANCZOS)
mask = Image.new("L", (P, P), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, P - 1, P - 1], radius=186, fill=255)
mac = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sh = Image.new("L", (S, S), 0); ImageDraw.Draw(sh).rounded_rectangle([100, 112, 100 + P, 112 + P], radius=186, fill=110)
mac.paste((0, 0, 0, 255), (0, 0), sh.filter(ImageFilter.GaussianBlur(14)))
mac.paste(plate, (100, 100), mask)
mac.save(os.path.join(out, "moonstone-shaped-1024.png"))               # name kept: the Mac app and docs point at it
iset = os.path.join(out, "Moonstone.iconset"); os.makedirs(iset, exist_ok=True)
for n in (16, 32, 128, 256, 512):
    for k, sfx in ((1, ""), (2, "@2x")):
        mac.resize((n * k, n * k), Image.LANCZOS).save(os.path.join(iset, f"icon_{n}x{n}{sfx}.png"))
subprocess.run(["iconutil", "-c", "icns", iset, "-o", os.path.join(out, "Moonstone.icns")], check=True)
mac.save(os.path.join(out, "moonstone.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
art.resize((256, 256), Image.LANCZOS).save(os.path.join(out, "icon-256.png"))
mac.resize((64, 64), Image.LANCZOS).save(os.path.join(out, "favicon.png"))
print("built", sorted(os.listdir(out)))
