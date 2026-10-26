from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path
import math

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'branding'
OUT.mkdir(exist_ok=True)
SIZE = 1024

# DreamKey: midnight field, faceted key-diamond, crisp at launcher sizes.
im = Image.new('RGBA', (SIZE, SIZE), (9, 13, 35, 255))
pix = im.load()
for y in range(SIZE):
    for x in range(SIZE):
        # subtle diagonal midnight gradient
        t = (x + y) / (2 * (SIZE - 1))
        pix[x, y] = (int(9 + 13*t), int(13 + 12*t), int(35 + 28*t), 255)

# rounded inner panel
panel = Image.new('RGBA', (SIZE, SIZE), (0,0,0,0))
pd = ImageDraw.Draw(panel)
pd.rounded_rectangle((48,48,SIZE-48,SIZE-48), radius=210, fill=(15, 25, 62, 255), outline=(54, 71, 125, 220), width=8)
im = Image.alpha_composite(im, panel)

# soft glow behind mark
glow = Image.new('RGBA', (SIZE,SIZE), (0,0,0,0))
gd = ImageDraw.Draw(glow)
gd.ellipse((208,160,816,864), fill=(45, 185, 255, 95))
gd.ellipse((260,212,764,812), fill=(146, 83, 255, 70))
glow = glow.filter(ImageFilter.GaussianBlur(65))
im = Image.alpha_composite(im, glow)

# diamond composed of four facets
mark = Image.new('RGBA', (SIZE,SIZE), (0,0,0,0))
md = ImageDraw.Draw(mark)
cx, cy = 512, 492
p_top=(512,196); p_right=(826,492); p_bottom=(512,788); p_left=(198,492)
# outer dark outline / shadow
md.polygon([p_top,p_right,p_bottom,p_left], fill=(5,9,25,255))
# inset diamond facets
md.polygon([p_top,(512,492),p_left], fill=(81,224,255,255))
md.polygon([p_top,p_right,(512,492)], fill=(151,111,255,255))
md.polygon([p_left,(512,492),p_bottom], fill=(31,170,219,255))
md.polygon([(512,492),p_right,p_bottom], fill=(104,65,224,255))
# facet highlights
md.line([p_top,p_right], fill=(209,220,255,230), width=5)
md.line([p_top,p_left], fill=(181,247,255,200), width=5)
# keyhole: circle + stem, with subtle dark edge
md.ellipse((448,393,576,521), fill=(8,16,42,255))
md.polygon([(475,482),(549,482),(582,650),(442,650)], fill=(8,16,42,255))
# keyhole inner highlight (small, readable)
md.ellipse((467,412,557,502), fill=(245,250,255,255))
md.polygon([(487,478),(537,478),(558,604),(466,604)], fill=(245,250,255,255))
# small sparkle at upper right
md.polygon([(747,278),(761,316),(799,332),(761,348),(747,388),(733,348),(695,332),(733,316)], fill=(255,211,102,255))

# add tiny dark outline around mark by compositing an offset shadow
shadow = Image.new('RGBA',(SIZE,SIZE),(0,0,0,0))
sm = ImageDraw.Draw(shadow)
sm.polygon([(p_top[0],p_top[1]+10),(p_right[0]+10,p_right[1]),(p_bottom[0],p_bottom[1]+10),(p_left[0]-10,p_left[1])], fill=(0,0,0,125))
shadow = shadow.filter(ImageFilter.GaussianBlur(14))
im = Image.alpha_composite(im, shadow)
im = Image.alpha_composite(im, mark)

# preserve master in branding, plus SVG-friendly-ish PNG master
im.convert('RGB').save(OUT / 'dreamkey-logo-1024.png', optimize=True)

android_sizes = {'mdpi':48, 'hdpi':72, 'xhdpi':96, 'xxhdpi':144, 'xxxhdpi':192}
for density, size in android_sizes.items():
    target = im.resize((size,size), Image.Resampling.LANCZOS).convert('RGB')
    for name in ('ic_launcher.png','ic_launcher_round.png'):
        target.save(ROOT / 'android' / 'app' / 'src' / 'main' / 'res' / f'mipmap-{density}' / name, optimize=True)

ios_sizes = {
    'Icon-20@2x.png':40, 'Icon-20@3x.png':60,
    'Icon-29@2x.png':58, 'Icon-29@3x.png':87,
    'Icon-40@2x.png':80, 'Icon-40@3x.png':120,
    'Icon-60@2x.png':120, 'Icon-60@3x.png':180,
    'Icon-1024.png':1024,
}
ios_dir = ROOT / 'ios' / 'IndependentWallet' / 'Images.xcassets' / 'AppIcon.appiconset'
for filename,size in ios_sizes.items():
    im.resize((size,size), Image.Resampling.LANCZOS).convert('RGB').save(ios_dir / filename, optimize=True)
print('generated', OUT / 'dreamkey-logo-1024.png')
