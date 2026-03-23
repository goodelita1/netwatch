#!/usr/bin/env python3
"""
NetWatch — Icon generator.
Generates all required PWA icon sizes from SVG using cairosvg or
falls back to creating simple PNG icons using only stdlib (no deps).

Run once:
    cd /path/to/web_UI
    python3 generate_icons.py

Requires: pip install cairosvg   (best quality)
Or runs without it using a pure-Python fallback (basic PNG).
"""
import os, struct, zlib

SIZES  = [72, 96, 128, 144, 152, 192, 384, 512]
OUTDIR = os.path.join(os.path.dirname(__file__), "static", "icons")
os.makedirs(OUTDIR, exist_ok=True)

# ── SVG source ────────────────────────────────────────────────────────────────
SVG_TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}">
  <rect width="{s}" height="{s}" rx="{r}" fill="#0d1117"/>
  <polygon points="{hex_pts}" fill="#3d7fff"/>
  <text x="{cx}" y="{cy}" font-family="monospace" font-weight="bold"
        font-size="{fs}" fill="#e0e6f0" text-anchor="middle"
        dominant-baseline="central">NW</text>
</svg>"""

def make_svg(size):
    s  = size
    r  = round(s * 0.22)
    cx = s // 2
    cy = s // 2
    # Hexagon points
    import math
    R  = s * 0.32
    pts = []
    for i in range(6):
        angle = math.pi / 180 * (60 * i - 30)
        pts.append(f"{cx + R * math.cos(angle):.1f},{cy + R * math.sin(angle):.1f}")
    return SVG_TEMPLATE.format(
        s=s, r=r, cx=cx, cy=cy,
        hex_pts=" ".join(pts),
        fs=round(s * 0.22),
    )

# ── Try cairosvg first ────────────────────────────────────────────────────────
def generate_with_cairo():
    import cairosvg
    for size in SIZES:
        svg = make_svg(size).encode()
        out = os.path.join(OUTDIR, f"icon-{size}.png")
        cairosvg.svg2png(bytestring=svg, write_to=out, output_width=size, output_height=size)
        print(f"  {size}×{size}  →  {out}")
    return True

# ── Pure-Python PNG fallback (no alpha, solid color blocks) ──────────────────
def _png_chunk(chunk_type, data):
    c  = chunk_type + data
    return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

def make_simple_png(size):
    """Creates a minimal valid PNG — dark bg with a blue square in the center."""
    bg   = (13,  17,  23)    # #0d1117
    acc  = (61,  127, 255)   # #3d7fff

    pixels = []
    margin = size // 5
    for y in range(size):
        row = []
        for x in range(size):
            in_hex = (margin <= x < size - margin) and (margin <= y < size - margin)
            row.extend(acc if in_hex else bg)
        pixels.append(bytes(row))

    raw = b""
    for row in pixels:
        raw += b"\x00" + row  # filter type 0

    compressed = zlib.compress(raw, 9)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png  = b"\x89PNG\r\n\x1a\n"
    png += _png_chunk(b"IHDR", ihdr)
    png += _png_chunk(b"IDAT", compressed)
    png += _png_chunk(b"IEND", b"")
    return png

def generate_fallback():
    for size in SIZES:
        out = os.path.join(OUTDIR, f"icon-{size}.png")
        with open(out, "wb") as f:
            f.write(make_simple_png(size))
        print(f"  {size}×{size}  →  {out}  (fallback PNG)")

# ── Also save SVG source ──────────────────────────────────────────────────────
svg_out = os.path.join(OUTDIR, "icon.svg")
with open(svg_out, "w") as f:
    f.write(make_svg(512))
print(f"  SVG source  →  {svg_out}")

# ── Run ───────────────────────────────────────────────────────────────────────
print(f"\nGenerating {len(SIZES)} icon sizes → {OUTDIR}\n")
try:
    if generate_with_cairo():
        print("\n✅  Icons generated with cairosvg (best quality)")
except Exception as e:
    print(f"cairosvg not available ({e}), using fallback...")
    generate_fallback()
    print("\n✅  Icons generated (fallback quality)")
    print("   For better icons: pip install cairosvg && python3 generate_icons.py")