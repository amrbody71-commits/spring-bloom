"""Cut a spread into pop-up layers: standing cut-outs plus a clean plate.

Each spread has a mask recipe in tools/masks/NN.json:

  {
    "horizon": 0.66,                         # fraction down the spread where the ground starts
    "layers": [
      {"id": "kids", "name": "Aliya and Zade", "tilt": 88, "order": 3,
       "sam": {"box": [0, 0.18, 0.40, 1.0], "pos": [[0.11, 0.42]], "neg": [[0.24, 0.20]]}},
      {"id": "wall", "name": "the trees", "tilt": 90, "order": 0, "derive": "content-above-horizon"}
    ]
  }

Coordinates are fractions of the spread (u across, v down). A "sam" layer is
segmented by fal's SAM2 endpoint from a box and point prompts (about $0.003 a
call; raw masks are cached under work/layers so a rerun costs nothing, and a
changed recipe needs its cache file deleted). Every SAM mask is tidied before
it is cut (see tidy_mask): specks dropped, pinholes filled. A "derive" layer is
computed here: "content-above-horizon" is every non-paper pixel above the
horizon that no other layer claimed, which is what the back wall of a paper
theatre is.

Paper keying: the illustrations sit on white paper, so a pixel's distance from
white is its coverage. Partial-alpha edge pixels are despilled (the white
contribution removed) so cut-outs carry no pale halo once they stand in front
of darker art, and the alpha is feathered because a hard edge aliases badly on
a plane seen at an angle.

Outputs per spread:
  assets/layers/NN/<id>.webp        RGBA cut-out, cropped to its box
  assets/layers/NN/layers.json      boxes, feet, tilts, order, names
  assets/spreads/NN-plate-left.webp and -right.webp   the page with the standing
                                    layers removed and their holes filled
  work/layers/NN-sheet.png          contact sheet for review

Usage:
  python tools/layers.py 04           one spread
  python tools/layers.py --all        every spread with a recipe
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import requests
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SPREADS = ROOT / "assets" / "spreads"
LAYERS = ROOT / "assets" / "layers"
MASKS = ROOT / "tools" / "masks"
WORK = ROOT / "work" / "layers"
HALF = (1024, 1304)
FAL_KEY = json.load(open(Path.home() / ".fal" / "credentials.json"))["fal_key"]


# ------------------------------------------------------------- keying ----
def content_alpha(rgb: np.ndarray, lo: float = 222.0, hi: float = 249.0) -> np.ndarray:
    """Coverage from distance to white: 0 on paper, 1 on ink, a ramp between."""
    mn = rgb.min(axis=2).astype(np.float32)
    return np.clip((hi - mn) / (hi - lo), 0.0, 1.0)


def feather(alpha01: np.ndarray, sigma: float = 1.2) -> np.ndarray:
    return np.clip(cv2.GaussianBlur(alpha01.astype(np.float32), (0, 0), sigma), 0.0, 1.0)


def despill(rgb: np.ndarray, alpha01: np.ndarray) -> np.ndarray:
    """pixel = a * colour + (1 - a) * white, so colour = (pixel - (1 - a) * 255) / a."""
    a = alpha01[..., None].astype(np.float32)
    col = rgb.astype(np.float32)
    soft = (a > 0.04) & (a < 0.985)
    fixed = np.where(soft, (col - (1.0 - a) * 255.0) / np.maximum(a, 0.04), col)
    return np.clip(fixed, 0, 255).astype(np.uint8)


# --------------------------------------------------------------- sam2 ----
def sam_mask(img: Image.Image, spec: dict, cache: Path) -> np.ndarray:
    if cache.exists():
        return np.array(Image.open(cache).convert("L")) / 255.0
    W, H = img.size
    buf = io.BytesIO(); img.save(buf, "PNG")
    data_uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    points = [{"x": int(u * W), "y": int(v * H), "label": 1} for u, v in spec.get("pos", [])]
    points += [{"x": int(u * W), "y": int(v * H), "label": 0} for u, v in spec.get("neg", [])]
    boxes = spec.get("boxes", [spec["box"]] if "box" in spec else [None])
    # One request per box: the endpoint rejects several boxes in one call, so a
    # layer spanning two objects is the union of one mask per box.
    union = np.zeros((H, W), np.float32)
    for box in boxes:
        body = {"image_url": data_uri, "sync_mode": False, "output_format": "png", "prompts": points}
        if box:
            u0, v0, u1, v1 = box
            body["box_prompts"] = [{"x_min": int(u0 * W), "y_min": int(v0 * H), "x_max": int(u1 * W), "y_max": int(v1 * H)}]
            # keep only the points inside this box, plus every negative
            body["prompts"] = [p for p in points if p["label"] == 0 or (u0 * W <= p["x"] <= u1 * W and v0 * H <= p["y"] <= v1 * H)]
        r = requests.post("https://fal.run/fal-ai/sam2/image", headers={"Authorization": "Key " + FAL_KEY}, json=body, timeout=180)
        if not r.ok:
            raise SystemExit(f"SAM2 {r.status_code}: {r.text[:400]}")
        url = r.json()["image"]["url"]
        m = np.array(Image.open(io.BytesIO(requests.get(url, timeout=60).content)).convert("L")) / 255.0
        union = np.maximum(union, m)
    cache.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((union * 255).astype(np.uint8)).save(cache)
    return union


def box_area(spec: dict, W: int, H: int, m01: np.ndarray) -> float:
    """Pixel area of the recipe's box(es); the mask's own bounds when it has none."""
    boxes = spec.get("boxes", [spec["box"]] if "box" in spec else [])
    if boxes:
        return float(sum((u1 - u0) * W * (v1 - v0) * H for u0, v0, u1, v1 in boxes))
    x0, y0, x1, y1 = bbox_of(m01, 0)
    return float((x1 - x0) * (y1 - y0))


def tidy_mask(m01: np.ndarray, area: float) -> np.ndarray:
    """Clean a raw SAM mask before it is cut.

    An opening (about 5 px at the 1024-wide half-page scale) finds the specks;
    it is applied by reconstruction, so a component that survives it anywhere
    is kept whole and a flamingo leg a few pixels wide stays on its body while
    isolated flecks go. Components under 0.3% of the layer's box area are then
    dropped unless they are the largest, and enclosed holes under 1% of the box
    area are filled, so a cut-out has no pinholes for the plate to show through.
    """
    H, W = m01.shape
    b = (m01 > 0.5).astype(np.uint8)
    if not b.any():
        return m01
    k = max(3, int(round(5 * (W / 2) / 1024)) | 1)
    opened = cv2.morphologyEx(b, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(b, connectivity=8)
    survives = np.zeros(n, bool)
    survives[np.unique(lab[opened > 0])] = True
    areas = stats[:, cv2.CC_STAT_AREA].astype(np.int64)
    areas[0] = 0
    keep = survives & (areas >= 0.003 * area)
    keep[int(areas.argmax())] = True
    keep[0] = False
    b = keep[lab].astype(np.uint8)
    # Enclosed holes are background components that never reach the image edge.
    n, lab, stats, _ = cv2.connectedComponentsWithStats(1 - b, connectivity=4)
    x, y, w, h, a = (stats[:, i] for i in range(5))
    hole = (x > 0) & (y > 0) & (x + w < W) & (y + h < H) & (a < 0.01 * area)
    hole[0] = False
    b = np.where(hole[lab], 1, b).astype(np.uint8)
    return b.astype(np.float32)


# ------------------------------------------------------------- layers ----
def bbox_of(alpha01: np.ndarray, pad: int) -> tuple[int, int, int, int]:
    ys, xs = np.where(alpha01 > 0.03)
    if len(xs) == 0:
        raise SystemExit("empty layer mask")
    H, W = alpha01.shape
    return (int(max(0, xs.min() - pad)), int(max(0, ys.min() - pad)),
            int(min(W, xs.max() + pad + 1)), int(min(H, ys.max() + pad + 1)))


def cut_layer(rgb: np.ndarray, alpha01: np.ndarray, pad: int = 6) -> tuple[Image.Image, tuple[int, int, int, int]]:
    a = feather(alpha01)
    col = despill(rgb, a)
    x0, y0, x1, y1 = bbox_of(a, pad)
    out = np.dstack([col[y0:y1, x0:x1], (a[y0:y1, x0:x1] * 255).astype(np.uint8)])
    return Image.fromarray(out, "RGBA"), (x0, y0, x1, y1)


def clean_plate(rgb: np.ndarray, holes01: np.ndarray) -> np.ndarray:
    """Fill where standing layers were. Inpainting at half size is plenty: the
    filled area sits behind a cut-out and only shows at the parallax edges."""
    H, W = holes01.shape
    hole = (cv2.dilate((holes01 > 0.5).astype(np.uint8), np.ones((5, 5), np.uint8)) * 255).astype(np.uint8)
    small = cv2.resize(rgb, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
    small_hole = cv2.resize(hole, (W // 2, H // 2), interpolation=cv2.INTER_NEAREST)
    filled = cv2.inpaint(cv2.cvtColor(small, cv2.COLOR_RGB2BGR), small_hole, 9, cv2.INPAINT_TELEA)
    filled = cv2.cvtColor(cv2.resize(filled, (W, H), interpolation=cv2.INTER_CUBIC), cv2.COLOR_BGR2RGB)
    soft = cv2.GaussianBlur(hole.astype(np.float32) / 255.0, (0, 0), 2.0)[..., None]
    return (rgb * (1 - soft) + filled * soft).astype(np.uint8)


def build(sid: str, force: bool = False) -> dict:
    recipe = json.loads((MASKS / f"{sid}.json").read_text(encoding="utf-8"))
    img = Image.open(SPREADS / f"{sid}.webp").convert("RGB")
    rgb = np.array(img)
    H, W = rgb.shape[:2]
    out_dir = LAYERS / sid
    out_dir.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)

    # A recipe may raise the paper threshold when a pale sky gradient should
    # count as paper rather than as part of the back wall.
    content = content_alpha(rgb, *recipe.get("paper", [222.0, 249.0]))
    claimed = np.zeros((H, W), np.float32)
    masks: dict[str, np.ndarray] = {}

    # SAM layers first so derived layers can exclude them.
    for layer in recipe["layers"]:
        if "sam" in layer:
            m = sam_mask(img, layer["sam"], WORK / f"{sid}-{layer['id']}.png")
            m = tidy_mask(m, box_area(layer["sam"], W, H, m))
            m = np.minimum(m, content)
            masks[layer["id"]] = m
            claimed = np.maximum(claimed, m)
    # The plate is the spread with every standing cut-out removed and filled.
    # Derived backdrops are cut from the plate rather than the original, so a
    # character standing in front of the wall leaves no character-shaped
    # window in it once the two planes separate in depth.
    plate = clean_plate(rgb, claimed)
    plate_content = content_alpha(plate, *recipe.get("paper", [222.0, 249.0]))
    sources: dict[str, np.ndarray] = {}

    for layer in recipe["layers"]:
        if layer.get("derive") == "band-above-horizon":
            # Full-bleed paintings have no paper to key against, so the backdrop
            # is the whole strip above the horizon, standing up like a painted
            # flat in a toy theatre.
            hz = int(recipe["horizon"] * H)
            band = np.zeros((H, W), np.float32)
            band[:hz] = 1.0
            masks[layer["id"]] = cv2.GaussianBlur(band, (0, 0), 3.0).astype(np.float32)
            sources[layer["id"]] = plate
        elif layer.get("derive") == "content-above-horizon":
            hz = int(recipe["horizon"] * H)
            band = np.zeros((H, W), np.float32)
            band[:hz] = 1.0
            band = cv2.GaussianBlur(band, (0, 0), 6.0)
            m = plate_content * band
            m = np.where(m > 0.35, m, 0.0)
            sources[layer["id"]] = plate
            # drop specks: keep components larger than 0.05% of the spread
            n, lab, stats, _ = cv2.connectedComponentsWithStats((m > 0.5).astype(np.uint8), 8)
            keep = np.zeros_like(m)
            for i in range(1, n):
                if stats[i, cv2.CC_STAT_AREA] > 0.0005 * H * W:
                    keep[lab == i] = 1.0
            m = m * cv2.dilate(keep.astype(np.uint8), np.ones((3, 3), np.uint8))
            masks[layer["id"]] = m.astype(np.float32)

    entries = []
    tiles = [("spread", img.copy())]
    for layer in recipe["layers"]:
        m = masks[layer["id"]]
        cut, (x0, y0, x1, y1) = cut_layer(sources.get(layer["id"], rgb), m)
        path = out_dir / f"{layer['id']}.webp"
        cut.save(path, "WEBP", quality=90, method=6, exact=True)
        entries.append({
            "id": layer["id"], "name": layer["name"], "src": f"assets/layers/{sid}/{layer['id']}.webp",
            "box": [round(x0 / W, 4), round(y0 / H, 4), round(x1 / W, 4), round(y1 / H, 4)],
            "foot": [round((x0 + x1) / 2 / W, 4), round(y1 / H, 4)],
            "tilt": layer.get("tilt", 88), "order": layer.get("order", 1),
            "px": [x1 - x0, y1 - y0],
        })
        tile = Image.new("RGB", cut.size, (128, 128, 128)); tile.paste(cut, (0, 0), cut)
        tiles.append((layer["id"], tile))

    plate_img = Image.fromarray(plate)
    pw = W // 2
    plate_img.crop((0, 0, pw, H)).resize(HALF, Image.LANCZOS).save(SPREADS / f"{sid}-plate-left.webp", "WEBP", quality=90, method=6)
    plate_img.crop((pw, 0, W, H)).resize(HALF, Image.LANCZOS).save(SPREADS / f"{sid}-plate-right.webp", "WEBP", quality=90, method=6)
    tiles.insert(1, ("plate", plate_img))

    meta = {"spread": int(sid), "horizon": recipe["horizon"], "hero": bool(recipe.get("hero", False)),
            "layers": sorted(entries, key=lambda e: e["order"])}
    (out_dir / "layers.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")

    # contact sheet: each tile scaled to 420 px wide
    cols = 3; tw = 420
    rows = (len(tiles) + cols - 1) // cols
    th = int(tw * H / W)
    sheet = Image.new("RGB", (cols * tw, rows * (th + 18)), "white")
    d = ImageDraw.Draw(sheet)
    for i, (label, im) in enumerate(tiles):
        t = im.copy(); t.thumbnail((tw - 6, th - 2))
        x, y = (i % cols) * tw, (i // cols) * (th + 18)
        d.text((x + 3, y + 2), label, fill="black")
        sheet.paste(t, (x + 3, y + 18))
    sheet.save(WORK / f"{sid}-sheet.png")
    return meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("spreads", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    ids = sorted(p.stem for p in MASKS.glob("*.json")) if a.all else a.spreads
    if not ids:
        sys.exit("give spread ids or --all")
    for sid in ids:
        meta = build(sid, a.force)
        print(f"spread {sid}: {len(meta['layers'])} layers -> " + ", ".join(f"{e['id']} {e['px'][0]}x{e['px'][1]}" for e in meta["layers"]))
