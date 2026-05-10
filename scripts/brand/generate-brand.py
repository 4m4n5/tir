#!/usr/bin/env python3
"""
generate-brand.py - generate the tir brand asset set from the master SVG.

Produces:
  assets/brand/icon-1024.png      - app icon master (1024x1024 opaque RGB)
  assets/brand/icon-180.png       - iPhone @3x preview
  assets/brand/icon-60.png        - small-size preview
  assets/brand/wordmark-light.png - 'tir' wordmark on warm-near-black bg
  assets/brand/wordmark-dark.png  - 'tir' wordmark on warm off-white bg
                                    (for placement on light marketing surfaces)
  assets/brand/lockup.png         - icon + wordmark, marketing lockup

  ios/TirApp/Images.xcassets/AppIcon.appiconset/icon-1024.png
                                  - app icon shipped with iOS build

Run:  python3 scripts/brand/generate-brand.py
"""
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[2]
BRAND = REPO / "TirApp/assets/brand"
APPICON = REPO / "TirApp/ios/TirApp/Images.xcassets/AppIcon.appiconset"

BG = (0x0B, 0x0B, 0x12)
TEXT_LIGHT = (0xF7, 0xF7, 0xF7)
TEXT_DARK = (0x0B, 0x0B, 0x12)
ACCENT = (0x00, 0xE5, 0xFF)
SURFACE_LIGHT_BG = (0xFA, 0xF7, 0xF4)

SF_NS = "/System/Library/Fonts/SFNS.ttf"

def render_icon():
    """rsvg-convert the master SVG to PNGs at the standard sizes."""
    src = BRAND / "icon-master.svg"
    for size in (1024, 180, 60):
        out = BRAND / f"icon-{size}.png"
        subprocess.run(
            ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(out), str(src)],
            check=True,
        )
        print(f"  wrote {out.relative_to(REPO)}")
    # Drop the master into the iOS asset catalog so Xcode picks it up.
    APPICON.mkdir(parents=True, exist_ok=True)
    (APPICON / "icon-1024.png").write_bytes((BRAND / "icon-1024.png").read_bytes())
    print(f"  wrote {(APPICON / 'icon-1024.png').relative_to(REPO)}")


def load_thin_font(size_px: int, variant: bytes = b"Ultralight") -> ImageFont.FreeTypeFont:
    """Load SF NS at a specific named variation. SF NS ships every weight
    (Ultralight / Thin / Light / Regular ...) and every width (Compressed /
    Condensed / Expanded ...) as named instances; we pick by name rather
    than by axis values to be robust to PIL version differences. Falls
    back to the default (Regular) if the requested variant is unavailable.
    """
    f = ImageFont.truetype(SF_NS, size=size_px)
    try:
        f.set_variation_by_name(variant)
    except Exception as e:
        print(f"  warning: could not apply variant {variant!r}: {e}")
    return f


def render_wordmark(bg, fg, out_name: str, padding=(120, 60)):
    """Render the lowercase 'tir' wordmark at a confident size with tight
    negative tracking, on the requested background. Sized so the rendered
    PNG is ready for retina display use without further upscaling."""
    text = "tir"
    font_size = 380
    f = load_thin_font(font_size)

    # Rough measure for sizing the canvas tightly with the padding.
    bbox = f.getbbox(text)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    # Tight letter-spacing: render glyphs individually with negative kerning
    # to match the aaam.dev wordmark feel (-0.03em ~ -11.4 at 380px).
    kerning_px = -16
    glyph_widths = [f.getbbox(ch)[2] - f.getbbox(ch)[0] for ch in text]
    total_w = sum(glyph_widths) + kerning_px * (len(text) - 1)

    canvas_w = total_w + padding[0] * 2
    canvas_h = text_h + padding[1] * 2
    img = Image.new("RGB", (canvas_w, canvas_h), bg)
    draw = ImageDraw.Draw(img)

    x = padding[0]
    y = padding[1] - bbox[1]  # account for the glyph's baseline offset
    for ch, w in zip(text, glyph_widths):
        draw.text((x, y), ch, font=f, fill=fg)
        x += w + kerning_px

    out = BRAND / out_name
    img.save(out)
    print(f"  wrote {out.relative_to(REPO)}  ({canvas_w}x{canvas_h})")


def render_lockup():
    """Marketing lockup: icon mark on the left, wordmark to the right.
    For headers, social posts, App Store marketing screenshots when needed.
    """
    icon = Image.open(BRAND / "icon-1024.png").convert("RGB")
    # Icon at 360 high; wordmark at ~180 cap height to balance optically.
    icon_h = 360
    icon_resized = icon.resize((icon_h, icon_h), Image.LANCZOS)

    text = "tir"
    f = load_thin_font(280)
    glyph_widths = [f.getbbox(ch)[2] - f.getbbox(ch)[0] for ch in text]
    bbox = f.getbbox(text)
    text_h = bbox[3] - bbox[1]
    kerning_px = -12
    total_w = sum(glyph_widths) + kerning_px * (len(text) - 1)

    gap = 56
    canvas_w = icon_h + gap + total_w + 120 * 2
    canvas_h = max(icon_h, text_h) + 80 * 2
    img = Image.new("RGB", (canvas_w, canvas_h), BG)
    draw = ImageDraw.Draw(img)

    icon_y = (canvas_h - icon_h) // 2
    img.paste(icon_resized, (120, icon_y))

    text_y = (canvas_h - text_h) // 2 - bbox[1]
    x = 120 + icon_h + gap
    for ch, w in zip(text, glyph_widths):
        draw.text((x, text_y), ch, font=f, fill=TEXT_LIGHT)
        x += w + kerning_px

    out = BRAND / "lockup.png"
    img.save(out)
    print(f"  wrote {out.relative_to(REPO)}  ({canvas_w}x{canvas_h})")


def main():
    BRAND.mkdir(parents=True, exist_ok=True)
    print("Rendering icon variants:")
    render_icon()
    print("Rendering wordmark:")
    render_wordmark(BG, TEXT_LIGHT, "wordmark-light.png")
    render_wordmark(SURFACE_LIGHT_BG, TEXT_DARK, "wordmark-dark.png")
    print("Rendering lockup:")
    render_lockup()
    print("Done.")


if __name__ == "__main__":
    main()
