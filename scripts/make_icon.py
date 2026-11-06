"""Render the 128x128 extension icon (pure Python, 4x supersampled). Run: python3 scripts/make_icon.py"""
import struct
import zlib

S = 128
SS = 4
W = S * SS


def rounded(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


BG = (255, 54, 33)        # Databricks-ish red/orange
BG2 = (230, 40, 25)
WHITE = (255, 255, 255)
CELL = (255, 255, 255)
CODE = (255, 120, 95)
RUN = (40, 200, 120)

# shapes in 128-px coordinates: (kind, rect, radius, colour)
shapes = [
    ("rect", (4, 4, 124, 124), 22, BG),
    # three notebook cells
    ("rect", (22, 22, 106, 48), 6, CELL),
    ("rect", (22, 56, 106, 82), 6, CELL),
    ("rect", (22, 90, 106, 108), 6, CELL),
    # code lines inside cells
    ("rect", (40, 30, 92, 34), 2, CODE),
    ("rect", (40, 38, 78, 42), 2, CODE),
    ("rect", (40, 64, 96, 68), 2, CODE),
    ("rect", (40, 72, 70, 76), 2, CODE),
    ("rect", (40, 97, 86, 101), 2, CODE),
]
# run triangles at the left of each cell
tris = [((27, 29), (27, 41), (36, 35)), ((27, 63), (27, 75), (36, 69)), ((27, 94), (27, 104), (35, 99))]


def in_tri(px, py, a, b, c):
    def s(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1, d2, d3 = s((px, py), a, b), s((px, py), b, c), s((px, py), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def sample(x, y):
    col = None
    for kind, (x0, y0, x1, y1), r, c in shapes:
        if rounded(x, y, x0, y0, x1, y1, r):
            if c is BG:
                t = y / 128
                c = tuple(int(BG[i] * (1 - t) + BG2[i] * t) for i in range(3))
            col = c
    for t in tris:
        if in_tri(x, y, *t):
            col = RUN
    return col


rows = []
for py in range(S):
    row = bytearray([0])
    for px in range(S):
        acc = [0, 0, 0, 0]
        for sy in range(SS):
            for sx in range(SS):
                c = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)
                if c:
                    acc[0] += c[0]
                    acc[1] += c[1]
                    acc[2] += c[2]
                    acc[3] += 1
        n = acc[3]
        if n:
            row += bytes([acc[0] // n, acc[1] // n, acc[2] // n, 255 * n // (SS * SS)])
        else:
            row += bytes([0, 0, 0, 0])
    rows.append(bytes(row))


def chunk(t, d):
    c = struct.pack(">I", len(d)) + t + d
    return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
open("images/icon.png", "wb").write(png)
print("wrote images/icon.png", len(png), "bytes")
