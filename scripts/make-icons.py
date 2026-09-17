"""Generate app icon (.icns) and tray template PNGs with zero dependencies."""
import math, os, struct, subprocess, zlib, shutil, tempfile

def png(w, h, rgba_fn):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b, a = rgba_fn(x, y)
            raw += bytes((int(r), int(g), int(b), int(a)))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')

def sdf_rrect(px, py, cx, cy, hw, hh, r):
    dx, dy = abs(px - cx) - (hw - r), abs(py - cy) - (hh - r)
    return math.hypot(max(dx, 0), max(dy, 0)) + min(max(dx, dy), 0) - r

def sdf_seg(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)))
    return math.hypot(px - (ax + t * abx), py - (ay + t * aby))

def aa(d, s=1.0):
    return max(0.0, min(1.0, 0.5 - d / s))

def app_icon(size):
    s = size / 1024.0
    # macOS icon grid: 824px rounded square inside 1024 canvas, radius ~185
    def f(x, y):
        px, py = x + 0.5, y + 0.5
        d = sdf_rrect(px, py, 512 * s, 512 * s, 412 * s, 412 * s, 186 * s)
        cover = aa(d, 1.5 * s)
        if cover <= 0:
            return (0, 0, 0, 0)
        # vertical gradient accent
        t = (py - 100 * s) / (824 * s)
        r, g, b = 47 + 40 * t, 111 + 30 * t, 237
        r, g, b = 0x2f + (0x5b - 0x2f) * t, 0x6f + (0x8a - 0x6f) * t, 0xed + (0xff - 0xed) * t
        # checkmark stroke
        w = 62 * s
        d1 = sdf_seg(px, py, 330 * s, 528 * s, 462 * s, 660 * s) - w
        d2 = sdf_seg(px, py, 462 * s, 660 * s, 700 * s, 392 * s) - w
        ck = aa(min(d1, d2), 1.5 * s)
        r = r + (255 - r) * ck; g = g + (255 - g) * ck; b = b + (255 - b) * ck
        return (r, g, b, 255 * cover)
    return png(size, size, f)

def tray_icon(size):
    s = size / 16.0
    def f(x, y):
        px, py = x + 0.5, y + 0.5
        cx = cy = 8 * s
        ring = abs(math.hypot(px - cx, py - cy) - 6.5 * s) - 0.85 * s
        w = 0.9 * s
        d1 = sdf_seg(px, py, 5.0 * s, 8.2 * s, 7.1 * s, 10.3 * s) - w
        d2 = sdf_seg(px, py, 7.1 * s, 10.3 * s, 11.2 * s, 5.8 * s) - w
        a = max(aa(ring, 1.0 * s), aa(min(d1, d2), 1.0 * s))
        return (0, 0, 0, 255 * a)
    return png(size, size, f)

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
build = os.path.join(root, 'build')
icons = os.path.join(build, 'icons')
os.makedirs(icons, exist_ok=True)
open(os.path.join(icons, 'trayTemplate.png'), 'wb').write(tray_icon(16))
open(os.path.join(icons, 'trayTemplate@2x.png'), 'wb').write(tray_icon(32))
big = app_icon(1024)
open(os.path.join(build, 'icon.png'), 'wb').write(big)
open(os.path.join(root, 'src', 'renderer', 'icon.png'), 'wb').write(app_icon(256))

tmp = tempfile.mkdtemp()
iconset = os.path.join(tmp, 'icon.iconset')
os.makedirs(iconset)
src = os.path.join(build, 'icon.png')
for n in (16, 32, 128, 256, 512):
    subprocess.run(['sips', '-z', str(n), str(n), src, '--out', os.path.join(iconset, f'icon_{n}x{n}.png')], check=True, capture_output=True)
    subprocess.run(['sips', '-z', str(n * 2), str(n * 2), src, '--out', os.path.join(iconset, f'icon_{n}x{n}@2x.png')], check=True, capture_output=True)
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(build, 'icon.icns')], check=True)
shutil.rmtree(tmp)
print('icons written')
