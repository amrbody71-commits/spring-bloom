"""Shoot the live site at exact book seconds with Playwright's Chromium.

The Claude Code browser pane returns black frames for a WebGL canvas, and
HyperFrames snapshots follow the reel's script only. This drives index.html
in capture mode (time set from outside, every spread's layers preloaded),
jumps to a spread, restarts its rise at t = 0 with popup.show(n, 0), renders
at the requested `since`, and grabs the frame through CDP, which does not
wait for a page that animates to go still.

    python tools/snap-life.py 2:4.5 2:6.5 4:3.6 15:box:4.0

Each item is spread:since. `spread:box:since` first fires the card's last
`box` event at t = 0 (spread 15's car leaves 1.5 s after it). PNGs land in
work/life-shots/. Needs the static server on 127.0.0.1:8326. Never deployed:
tools/ and *.py are in .vercelignore.
"""

import base64
import io
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8326/index.html?capture&fps=30&w=1280&h=720&dpr=1&seed=7"
OUT = Path(__file__).resolve().parent.parent / "work" / "life-shots"


def main(items):
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
            "--use-gl=angle", "--ignore-gpu-blocklist", "--hide-scrollbars",
        ])
        ctx = browser.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="load")
        page.wait_for_function("window.__book && window.__book.ready", timeout=60000)
        page.evaluate("async () => { await window.__book.ready; }")
        cdp = ctx.new_cdp_session(page)
        def render(spread, since, box, nolife, focus):
            # twice: the first frame after a jump carries a settle transient
            # (card and camera), the second is the steady frame
            for _ in range(2):
                setup(spread, since, box, nolife, focus)
            shot = cdp.send("Page.captureScreenshot", {"format": "png"})
            return base64.b64decode(shot["data"])

        def setup(spread, since, box, nolife, focus):
            page.evaluate(
                """([n, t, box, nolife, focus, hideDom]) => {
                    const b = window.__book;
                    for (const id of ['ui', 'cards']) { const el = document.getElementById(id); if (el) el.style.visibility = hideDom ? 'hidden' : ''; }
                    b.book.open(n);
                    b.popup.show(n, 0);
                    b.renderAt(0.01);
                    if (box) b.events.emit('box', { spread: n, box: 2, count: 3, at: 0, text: '' });
                    if (focus) b.events.emit('focus', { spread: n, layer: 'plate', at: focus, name: 'probe', source: 'tour' });
                    b.renderAt(t);
                    if (nolife) {
                        const e = b.popup.entry(n);
                        e.group.traverse((o) => { if ((o.geometry && o.geometry.attributes.color) || (o.isMesh && !o.name)) o.visible = false; });
                    }
                    b.forceRender();
                }""",
                [spread, since, box, nolife, focus, hide_dom[0]],
            )

        hide_dom = [False]
        for item in items:
            # spread:since[:box][:nolife][:diff][:f=u,v]  (flags in any order)
            parts = item.split(":")
            spread = int(parts[0])
            since = float(parts[1])
            flags = parts[2:]
            box = "box" in flags
            nolife = "nolife" in flags
            diff = "diff" in flags or "same" in flags
            same = "same" in flags     # diff two identical renders: any change is the rig's own noise
            focus = None
            for f in flags:
                if f.startswith("f="):
                    focus = [float(x) for x in f[2:].split(",")]
            hide_dom[0] = diff     # a diff compares the canvas only
            png = render(spread, since, box, nolife, focus)
            tag = ("box-" if box else "") + ("nolife-" if nolife else "") + (f"f{focus[0]:g},{focus[1]:g}-" if focus else "")
            name = OUT / f"{spread:02d}-{tag}t{since:g}.png"
            name.write_bytes(png)
            if diff:
                # the same frame without this module's objects; crop where they differ
                base = Image.open(io.BytesIO(render(spread, since, box, not same, focus))).convert("RGB")
                img = Image.open(io.BytesIO(png)).convert("RGB")
                from PIL import ImageChops
                mask = ImageChops.difference(img, base).convert("L").point(lambda v: 255 if v > 24 else 0)
                mask.save(OUT / f"{name.stem}-{'same' if same else 'diff'}-mask.png")
                bb = mask.getbbox()
                if bb:
                    x0 = max(0, bb[0] - 24); y0 = max(0, bb[1] - 24)
                    x1 = min(img.width, bb[2] + 24); y1 = min(img.height, bb[3] + 24)
                    crop = img.crop((x0, y0, x1, y1))
                    scale = max(1, min(4, 900 // max(1, crop.width)))
                    crop = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
                    dname = OUT / f"{name.stem}-diff.png"
                    crop.save(dname)
                    print("  differs in", bb, "->", dname.name, f"(x{scale})")
                else:
                    print("  no pixel differs with life hidden")
            # a zoomed crop of the book: the page corners, flat and 1.1 up
            bbox = page.evaluate(
                """async () => {
                    const b = window.__book; const THREE = await import('three');
                    const pts = []; const w = b.vw(), h = b.vh();
                    for (const u of [0, 1]) for (const v of [0, 1]) for (const lift of [0, 1.1]) {
                        const p = b.book.pageToWorld(u, v); p.y += lift; p.project(b.camera);
                        pts.push([(p.x + 1) / 2 * w, (1 - p.y) / 2 * h]);
                    }
                    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
                    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
                }"""
            )
            img = Image.open(io.BytesIO(png))
            x0 = max(0, int(bbox[0]) - 30); y0 = max(0, int(bbox[1]) - 30)
            x1 = min(img.width, int(bbox[2]) + 30); y1 = min(img.height, int(bbox[3]) + 30)
            crop = img.crop((x0, y0, x1, y1))
            scale = max(1, min(3, 1400 // max(1, crop.width)))
            crop = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
            zoom = OUT / f"{name.stem}-zoom.png"
            crop.save(zoom)
            print("wrote", name.name, "and", zoom.name, f"(x{scale})")
        stats = page.evaluate("() => { const s = window.__book.stats(); return [s.calls, s.triangles]; }")
        print("last frame: calls", stats[0], "triangles", stats[1])
        if errors:
            print("console errors:")
            for e in errors:
                print("  ", e)
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1:] or ["4:4.0"])
