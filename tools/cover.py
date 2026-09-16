"""Split the cover JPG into front, back and spine textures.

The only cover we have is a 960x597 social-media JPG of the full wrap
(back | spine | front) on a white ground. We find the artwork's bounding box
by thresholding the white border, split it down the middle, and upscale each
half to the page texture size. If the authors send print files later, drop
them into source/ and rerun.

Outputs: assets/textures/cover-front.webp, cover-back.webp, cover-spine.webp
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "source" / "cover.jpg"
OUT = ROOT / "assets" / "textures"
BOARD = (1056, 1344)    # boards are a little larger than the 1024x1304 page


def content_box(img: Image.Image) -> tuple[int, int, int, int]:
    bg = Image.new("RGB", img.size, (255, 255, 255))
    diff = ImageChops.difference(img, bg).convert("L").point(lambda v: 255 if v > 18 else 0)
    box = diff.getbbox()
    if not box:
        raise SystemExit("could not find the artwork on the cover image")
    return box


def main() -> None:
    img = Image.open(SRC).convert("RGB")
    x0, y0, x1, y1 = content_box(img)
    art = img.crop((x0, y0, x1, y1))
    w, h = art.size
    spine_w = max(6, int(w * 0.012))
    mid = w // 2
    back = art.crop((0, 0, mid - spine_w // 2, h)).resize(BOARD, Image.LANCZOS)
    front = art.crop((mid + spine_w // 2, 0, w, h)).resize(BOARD, Image.LANCZOS)
    spine = art.crop((mid - spine_w // 2, 0, mid + spine_w // 2, h)).resize((64, BOARD[1]), Image.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, im in (("cover-front", front), ("cover-back", back), ("cover-spine", spine)):
        im.save(OUT / f"{name}.webp", "WEBP", quality=92, method=6)
    print(f"cover art box {art.size}, front/back {BOARD}, spine 64x{BOARD[1]}")


if __name__ == "__main__":
    main()
