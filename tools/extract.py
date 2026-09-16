"""Pull the spreads, page halves, story text and card anchors out of the book PDF.

Every story spread in the PDF is one embedded 1736x1106 illustration plus a
separate text layer, so the illustration comes out text-free by construction:
we lift the image object itself instead of rendering the page. The two text
pages (title spread, activities page) are rendered with their text.

Outputs (repo-relative to spring-bloom/):
  assets/spreads/NN.webp          full spread, native 1736x1106, story spreads only
  assets/spreads/NN-left.webp     left page half, 1024x1304
  assets/spreads/NN-right.webp    right page half, 1024x1304
  assets/text/NN.json             words with boxes, paragraphs, card anchor
  work/render/NN.png              full page render at 2x, for reference
  work/sheet-spreads.png          contact sheet of every spread and half

Spread numbering: 0 = title spread (PDF page 2), 1..15 = story (pages 3..17),
16 = activities (page 18). Pages 1 and 19 are blank endpapers and are skipped.

Usage:
  python tools/extract.py            build everything that is missing
  python tools/extract.py --force    rebuild everything
  python tools/extract.py --check    print the inventory and exit non-zero on a mismatch
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
import pypdfium2.raw as raw
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "source" / "spring-bloom-inside.pdf"
SPREADS = ROOT / "assets" / "spreads"
TEXT = ROOT / "assets" / "text"
WORK = ROOT / "work"
RENDER = WORK / "render"

# PDF page number (1-based) -> spread number.
PAGES = {2: 0, **{p: p - 2 for p in range(3, 18)}, 18: 16}
STORY = range(1, 16)
HALF = (1024, 1304)            # page half texture size (page is 22 x 28 cm)
EXPECTED_STORY_WORDS = 1046    # counted from the PDF text layer on 15 Sept 2026


def spread_id(n: int) -> str:
    return f"{n:02d}"


# ---------------------------------------------------------------- images ----
def story_image(page: pdfium.PdfPage) -> Image.Image:
    """The one embedded illustration on a story page, text-free."""
    images = [o for o in page.get_objects(max_depth=4) if o.type == raw.FPDF_PAGEOBJ_IMAGE]
    if len(images) != 1:
        raise SystemExit(f"expected one image on a story page, found {len(images)}")
    return images[0].get_bitmap(render=False).to_pil().convert("RGB")


def rendered_page(page: pdfium.PdfPage, scale: float = 2.0) -> Image.Image:
    return page.render(scale=scale).to_pil().convert("RGB")


def halves(img: Image.Image) -> tuple[Image.Image, Image.Image]:
    w, h = img.size
    left = img.crop((0, 0, w // 2, h)).resize(HALF, Image.LANCZOS)
    right = img.crop((w // 2, 0, w, h)).resize(HALF, Image.LANCZOS)
    return left, right


def save_webp(img: Image.Image, path: Path, quality: int = 90) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "WEBP", quality=quality, method=6)


# ------------------------------------------------------------------ text ----
def extract_text(plumber_page) -> dict:
    """Words with boxes in page units (0..1 across the spread, 0..1 down),
    grouped into lines and paragraphs, plus where the story card should sit."""
    W, H = plumber_page.width, plumber_page.height
    # x_tolerance 3 (pdfplumber's default) is what keeps "fin d" on spread 13 as
    # one word: the PDF sets that word with a wider gap than any real space.
    words = plumber_page.extract_words(keep_blank_chars=False, use_text_flow=True, x_tolerance=3)
    if not words:
        return {"words": [], "paragraphs": [], "card_anchor": None, "page_pt": [W, H]}

    # Lines: cluster by 'top' within a tolerance.
    words.sort(key=lambda w: (round(w["top"]), w["x0"]))
    lines: list[list[dict]] = []
    for w in words:
        if lines and abs(w["top"] - lines[-1][0]["top"]) < 3.0:
            lines[-1].append(w)
        else:
            lines.append([w])
    for ln in lines:
        ln.sort(key=lambda w: w["x0"])

    # Paragraphs: a gap clearly bigger than the normal line pitch starts a new one.
    tops = [ln[0]["top"] for ln in lines]
    pitches = [b - a for a, b in zip(tops, tops[1:]) if b - a > 0]
    pitch = statistics.median(pitches) if pitches else 14.0
    paragraphs: list[list[int]] = [[]]
    out_words: list[dict] = []
    for i, ln in enumerate(lines):
        if i > 0 and (tops[i] - tops[i - 1]) > pitch * 1.45:
            paragraphs.append([])
        for w in ln:
            idx = len(out_words)
            out_words.append({
                "i": idx,
                "text": w["text"],
                "box": [round(w["x0"] / W, 4), round(w["top"] / H, 4),
                        round(w["x1"] / W, 4), round(w["bottom"] / H, 4)],
                "line": i,
            })
            paragraphs[-1].append(idx)

    xs0 = [w["box"][0] for w in out_words]; ys0 = [w["box"][1] for w in out_words]
    xs1 = [w["box"][2] for w in out_words]; ys1 = [w["box"][3] for w in out_words]
    bbox = [min(xs0), min(ys0), max(xs1), max(ys1)]
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    return {
        "page_pt": [W, H],
        "words": out_words,
        "paragraphs": [" ".join(out_words[i]["text"] for i in p) for p in paragraphs],
        "paragraph_word_ranges": [[p[0], p[-1]] for p in paragraphs if p],
        "text_bbox": [round(v, 4) for v in bbox],
        "card_anchor": {"u": round(cx, 4), "v": round(cy, 4), "page": "left" if cx < 0.5 else "right"},
    }


# ----------------------------------------------------------------- sheet ----
def contact_sheet(rows: list[tuple[str, Image.Image, Image.Image, Image.Image | None]], path: Path) -> None:
    cell_w, cell_h, pad = 440, 280, 18
    sheet = Image.new("RGB", (cell_w * 3, (cell_h + pad) * len(rows)), "white")
    draw = ImageDraw.Draw(sheet)
    for r, (label, full, left, right) in enumerate(rows):
        y = r * (cell_h + pad)
        draw.text((4, y + 2), label, fill="black")
        tiles = [full, left, right]
        for c, im in enumerate(tiles):
            if im is None:
                continue
            t = im.copy(); t.thumbnail((cell_w - 8, cell_h - 4))
            sheet.paste(t, (c * cell_w + 4, y + pad))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


# ------------------------------------------------------------------ main ----
def build(force: bool) -> dict:
    pdf = pdfium.PdfDocument(str(SRC))
    plumber = pdfplumber.open(str(SRC))
    RENDER.mkdir(parents=True, exist_ok=True)
    rows = []
    inventory: dict[str, dict] = {}

    for page_no, n in PAGES.items():
        sid = spread_id(n)
        page = pdf[page_no - 1]
        full_path = SPREADS / f"{sid}.webp"
        left_path, right_path = SPREADS / f"{sid}-left.webp", SPREADS / f"{sid}-right.webp"
        text_path = TEXT / f"{sid}.json"

        if force or not (left_path.exists() and right_path.exists() and text_path.exists()):
            img = story_image(page) if n in STORY else rendered_page(page)
            if n in STORY:
                save_webp(img, full_path)
            left, right = halves(img)
            save_webp(left, left_path); save_webp(right, right_path)
            rendered_page(page).save(RENDER / f"{sid}.png")
            info = extract_text(plumber.pages[page_no - 1])
            info["spread"] = n; info["pdf_page"] = page_no
            info["image"] = {"w": img.size[0], "h": img.size[1], "text_free": n in STORY}
            text_path.parent.mkdir(parents=True, exist_ok=True)
            text_path.write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
        else:
            img = Image.open(full_path) if full_path.exists() else Image.open(RENDER / f"{sid}.png")
            left, right = Image.open(left_path), Image.open(right_path)
            info = json.loads(text_path.read_text(encoding="utf-8"))

        rows.append((f"spread {sid}  (pdf p{page_no})  words={len(info['words'])}", img, left, right))
        inventory[sid] = {"words": len(info["words"]), "paragraphs": len(info["paragraphs"]),
                          "card": info.get("card_anchor"), "image": info.get("image")}

    contact_sheet(rows, WORK / "sheet-spreads.png")
    return inventory


def check(inventory: dict) -> int:
    ok = True
    story_words = sum(v["words"] for k, v in inventory.items() if int(k) in STORY)
    for k, v in inventory.items():
        print(f"  spread {k}: {v['words']:4d} words, {v['paragraphs']} paragraphs, card on the {v['card']['page'] if v['card'] else '-'} page")
    print(f"story words: {story_words} (expected {EXPECTED_STORY_WORDS})")
    if story_words != EXPECTED_STORY_WORDS:
        ok = False
    for k, v in inventory.items():
        if int(k) in STORY and (v["image"]["w"], v["image"]["h"]) != (1736, 1106):
            print(f"  spread {k}: unexpected image size {v['image']}"); ok = False
    missing = [p for n in PAGES.values() for p in (SPREADS / f"{spread_id(n)}-left.webp", SPREADS / f"{spread_id(n)}-right.webp", TEXT / f"{spread_id(n)}.json") if not p.exists()]
    for p in missing:
        print("  missing:", p.relative_to(ROOT)); ok = False
    print("OK" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if not SRC.exists():
        sys.exit(f"source PDF not found at {SRC}")
    inv = build(force=args.force)
    sys.exit(check(inv))
