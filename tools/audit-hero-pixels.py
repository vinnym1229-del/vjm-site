"""Measure where the rendered car actually sits inside its frame, and whether
it is turning. Companion to tools/audit-live-hero.mjs, which produces the
screenshots this reads.

Screenshots are the only honest way to answer "is it centred": the DOM box
being centred says nothing about where WebGL drew inside it, and eyeballing a
render is exactly what let several rounds of this ship broken. This finds the
car+platform by colour (dark platform, red bodywork), takes its bounding box,
and compares that box's centre to the frame's true centre.
"""
import sys, os, glob

from PIL import Image, ImageChops

TOL_X = 12   # px; anything under this is imperceptible at these sizes
TOL_Y = 16

# How much of its frame the car must actually occupy. Centering alone is not
# composition: an earlier build passed every centering check while the car
# filled 35% of the frame's height, which looks exactly like "not centred" to
# anyone looking at it. A subject that fills its frame cannot look marooned.
MIN_FILL_W = 0.70
MIN_FILL_H = 0.55

# The stage is a CSS box with a 1px border and a 20px radius, and the
# screenshot clips to that box, so its own rounded corners land inside the
# image. Those corner pixels are dark and reddish, which is exactly what this
# tool looks for -- a single antialiased pixel at (659,2) once dragged the
# bounding box 23px right and reported a visibly centred car as off-centre.
# Measure only what WebGL drew, not the frame drawn around it.
CHROME_INSET = 6


def content_bbox(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    minx, maxx, miny, maxy = w, 0, h, 0
    found = False
    for y in range(CHROME_INSET, h - CHROME_INSET):
        for x in range(CHROME_INSET, w - CHROME_INSET):
            r, g, b = px[x, y]
            dark = r < 100 and g < 100 and b < 100
            red = r > 100 and r - g > 40 and r - b > 40
            if dark or red:
                found = True
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    return (found, minx, miny, maxx, maxy, w, h)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else 'audit-out'
    failures = 0
    pairs = sorted(glob.glob(os.path.join(out_dir, 'w*-t0.png')))
    if not pairs:
        print('FAIL  no screenshots produced — the car never reached a rendered state')
        return 1

    for t0 in pairs:
        t1 = t0.replace('-t0.png', '-t1.png')
        label = os.path.basename(t0).split('-')[0]
        print(f'\n--- {label} ---')

        found, minx, miny, maxx, maxy, w, h = content_bbox(t0)
        if not found:
            print('FAIL  nothing drawn in the frame (blank canvas)')
            failures += 1
            continue

        cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
        off_x, off_y = cx - w / 2, cy - h / 2
        print(f'frame {w}x{h}  content bbox ({minx},{miny})-({maxx},{maxy})')
        print(f'left/right margin: {minx} / {w - maxx}   top/bottom margin: {miny} / {h - maxy}')
        print(f'centre offset: x={off_x:+.0f}px  y={off_y:+.0f}px')

        ok_x, ok_y = abs(off_x) <= TOL_X, abs(off_y) <= TOL_Y
        print(f'{"PASS" if ok_x else "FAIL"}  horizontally centred (tolerance {TOL_X}px)')
        print(f'{"PASS" if ok_y else "FAIL"}  vertically centred (tolerance {TOL_Y}px)')
        failures += (not ok_x) + (not ok_y)

        fill_w = (maxx - minx) / w
        fill_h = (maxy - miny) / h
        ok_fw, ok_fh = fill_w >= MIN_FILL_W, fill_h >= MIN_FILL_H
        print(f'fills {fill_w * 100:.0f}% of width, {fill_h * 100:.0f}% of height')
        print(f'{"PASS" if ok_fw else "FAIL"}  fills its frame horizontally (min {MIN_FILL_W:.0%})')
        print(f'{"PASS" if ok_fh else "FAIL"}  fills its frame vertically (min {MIN_FILL_H:.0%})')
        failures += (not ok_fw) + (not ok_fh)

        # Rotation: the two frames are seconds apart with no interaction, so a
        # turning car must differ. Identical frames mean it is frozen — which
        # is what a starved frame rate looks like, and it reads to a visitor
        # as "stuck at a weird angle", not as "not animating".
        if os.path.exists(t1):
            diff = ImageChops.difference(Image.open(t0).convert('RGB'),
                                         Image.open(t1).convert('RGB'))
            changed = sum(1 for p in diff.getdata() if p[0] + p[1] + p[2] > 30)
            total = diff.size[0] * diff.size[1]
            pct = 100 * changed / total
            spinning = pct > 0.5
            print(f'{"PASS" if spinning else "FAIL"}  rotating on its own '
                  f'({pct:.2f}% of pixels changed over 3s)')
            failures += (not spinning)

    print('\n' + ('ALL PIXEL CHECKS PASSED' if failures == 0 else f'{failures} PIXEL CHECK(S) FAILED'))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
