# Module contracts for the parallel build

Five units are built at the same time in this folder by five workers. Each owns its own files, nobody edits anyone else's, and the orchestrator wires modules into `js/app.js` afterwards. Read this whole file before writing code.

## Ground rules for every worker

- Work only inside `spring-bloom/`. Create the files you own; never edit `index.html`, `js/app.js`, `js/book.js`, `js/leaf.js`, `js/turn.js`, `js/clock.js`, `js/textures.js`, `js/events.js`, `js/rng.js`, `js/viewport.js`, `js/audio-core.js`, `css/site.css`, or another worker's files. If you need a change in a shared file, describe it in your final report instead.
- Never run `git`. Never start or stop a web server: a static server already serves this folder at `http://127.0.0.1:8325/` (any file path under it). Test your module through a probe page you own: `tools/probe-<unit>.html` that boots the app and inits your module.
- Determinism: no `Math.random`, `Date.now`, `setTimeout`/`setInterval` or `requestAnimationFrame` in anything that affects what a frame looks like. Everything animated is a function of `api.time` (book seconds) plus an event log. Use `js/rng.js` (`mulberry32`) for noise, seeded from `api.seed` and an event time.
- Two modes: `api.mode === 'live'` (real-time loop, pointer input) and `'capture'` (time set from outside via `api.renderAt(t)`; the reel renders this way frame by frame, seeking to arbitrary times). Your state at time `t` must be recomputable from `t` and the log, so a seek backwards works. Web Audio playback is live-mode only; in capture mode audio is mixed by the reel composition, so your module must not need audio to be playing to advance visuals.
- Browser pane facts: screenshots of the WebGL canvas come back black; call `window.__book.forceRender()` and blit the canvas into an `<img>` first (snippet at the bottom). The pane suspends `requestAnimationFrame` when the tab is not fronted; step time with `window.__book.frame(1/60)`. A hidden pane can report `innerWidth` 0; use `api.vw()`/`api.vh()`.
- Typography: `--display` (Fredoka) for headings and pills, `--body` (Andika) for text, `--label` (Andika, caps and tracking) for labels. Never a monospace face. Copy on screen: no em dashes, no "X, not Y" phrasings.
- Report at the end: files, what you verified in the pane and how, console status, what is unfinished, and the exact line to wire your module into `app.js`.

## The app object (`window.__book`, passed to every `init(api)`)

```
api.time            book seconds (getter)
api.mode            'live' | 'capture'
api.reduced         prefers-reduced-motion or ?reduced=1
api.seed            number
api.frame(dt)       step one frame by dt seconds
api.renderAt(t)     capture mode: render the frame at absolute time t
api.forceRender()   render now at the current time
api.scene, api.camera, api.renderer, api.composer   three.js objects
api.book            see below
api.turn            see below
api.events          emitter: on(name, fn), off(name, fn), emit(name, payload) -> array of listener return values
api.pool            texture pool: want(...spreads), resident()
api.clock           { time, mode, frame, renderAt, start }
api.vw(), api.vh()  viewport size with a fallback
api.ready           promise: first spread's textures resident
```

`api.book`: `group` (THREE.Group at the spine centre on the blanket), `spread` (current resting spread 0..16), `state` ('closed' | 'opening' | 'open' | 'turning' | 'closing'), `isOpen`, `open(s)` (jump), `openCover()`, `closeCover()`, `coverAt(t)` (0..1), `restY(k, s)`, `footprint()`, and `pageToWorld(u, v, out?)` which maps a point on the open spread to world space: `u` 0..1 across the whole spread (0.5 is the spine), `v` 0..1 down the page. This is the mapping every module uses for anchors; the same `u, v` units appear in `assets/text/NN.json` boxes and `assets/layers/NN/layers.json` boxes and feet.

Book frame: the blanket is the XZ plane, Y up. The spine runs along Z. The left page spans x in [-1, 0], the right page x in [0, 1]; the top edge of the page is z = -0.635, the bottom edge z = +0.635 (page = 1.0 x 1.27 world units = 22 x 28 cm). The camera home pose looks down at the book from the front-right at about 38 degrees FOV.

`api.turn`: `next()`, `prev()`, `to(s)`, `active` (null or `{dir, from, to, t, kind, start}`), `set(t)` (probe use), `attach()`.

Spread numbering: 0 = title spread, 1..15 = story, 16 = activities. Files: `assets/spreads/NN-left.webp`, `NN-right.webp` (page halves), `NN.webp` (full story spread), `NN-plate-left.webp`, `NN-plate-right.webp` (the page with standing layers removed; exists for every spread with a recipe), `assets/text/NN.json`, `assets/timings/spread-NN.json`, `assets/audio/spread-NN.mp3`, `assets/audio/labels/<slug>.mp3`, `assets/layers/NN/layers.json` and `<id>.webp`, `assets/data/spreads.json` (heading, hint, word links, counting beats per spread), `assets/sfx/*.mp3`, `assets/bed/bed.mp3`.

## Events (all through `api.events`)

Existing, emitted by the book and turn modules:
- `beforeTurn {from, to, dir}`: a listener that needs time first returns a number of seconds; the turn waits for the largest.
- `turnStart {from, to, dir, kind, at}`: the sheet starts moving at book time `at`.
- `settle {spread, from, to, committed}`: a turn (or a thrown-back drag) has landed on `spread`.
- `jump {spread}`: `book.open(s)` was called; everything should snap to that spread.
- `cover {open, t}`: the cover starts opening or closing at time `t`.

New, owned as follows:
- `focus {spread, layer, at: [u, v], name, source}` and `unfocus {}`: emitted by the story card (source 'word') and by pop-up layers (source 'layer'); consumed by the camera and by the label pill. `layer` is a layer id from layers.json or 'plate'; `at` is a point on the spread (optional when the layer has a box).
- `rise {spread}` and `fold {spread}`: emitted by pop-ups when layers start standing up or folding flat.
- `tap {spread, layer, name, at}`: emitted by pop-ups on a layer tap (also emitted by the card for word taps as `wordTap {spread, i, text}`).
- `word {spread, i, text, start, end}`: emitted by karaoke when a word becomes the active one (live mode; in capture mode consumers must derive from time instead).
- `narration {spread, state, at}`: state is 'start' | 'end' | 'pause' | 'resume'; `at` is book time.
- `count {kind, total, at}`: kind is 'shell' | 'twig' | 'pebble' | 'carry'; emitted by the tray when something lands.
- `hint {text}`: emitted by whoever changes the hint (pop-ups on settle); the interface renders it.

## Module APIs (what each worker builds and exposes)

- **camera** (`js/camera.js`, `js/ledger.js`; worker A): keeps the existing `setPose`, `update(dt, time)`, `refit(aspect)`, `home`; adds `focusOn({spread, layer, at, name})`, `release()`, `poseFor(spread, kind)` where kind is 'closed' | 'title' | 'home' | 'card' | a layer id, and listens to `focus`, `unfocus`, `cover`, `settle`, `jump` itself. Portrait (aspect < 0.8) has its own ledger. Also owns `js/scene.js` polish (blanket, light, props, performance policy).
- **narration + card** (`js/narration.js`, `js/card.js`, `js/karaoke.js`, `js/words.js`, `css/card.css`; worker B): `api.narration = { play(spread?), pause(), toggle(), playing, autoAdvance, state() -> {spread, startedAt, playing, position}, sayWord(spread, i) }` and `api.card = { show(spread), hide(), element }`. The card is DOM inside `#cards`, positioned each frame by projecting `book.pageToWorld(anchor)`.
- **pop-ups** (`js/popup.js`, `js/labels.js`, `css/labels.css`; worker C): `api.popup = { show(spread), fold(spread) -> seconds, layers(spread), hitTest(pointer) -> layer | null, setPlateVisible(spread, on) }`; answers `beforeTurn` with the fold time; listens to `settle` and `jump`; emits `rise`, `fold`, `tap`, `focus`, `hint`.
- **tray** (`js/tray.js`, `js/count-events.js`; worker D): `api.tray = { total, set(n, at?), add(n, at?), stateAt(t) }`; derives story counts from `assets/data/spreads.json` `count` beats plus the timings and `narration` events; listens to `tap` for the tap-to-count spreads; emits `count`.
- **interface + sound** (`js/ui.js`, `js/cursor.js`, `js/audio.js`, `css/ui.css`; worker E): `api.ui = { setHint(text), setPlaying(bool), setSpread(n), mount() }` and `api.audio = { sfx(id, opts), ambience(on), bed(on), duck(on), mute(on), muted }` built on `js/audio-core.js` (one AudioContext, `load(url)`, `play(buffer, opts)`, `bus(name)`, `setMuted`). Listens to `turnStart`, `settle`, `cover`, `rise`, `fold`, `tap`, `wordTap`, `count`, `narration`, `hint`.

Wiring order in `app.js` after the merge: audio, camera, popup, narration and card, tray, ui. Each module exports `init(api)` and returns its object; init must not throw if an optional sibling is missing (check `api.audio` before using it).

## The blit snippet for pane screenshots

```js
const b = window.__book; const src = document.getElementById('stage'); const cv = document.createElement('canvas');
cv.width = src.width; cv.height = src.height; const ctx = cv.getContext('2d'); b.forceRender(); ctx.drawImage(src, 0, 0);
document.querySelectorAll('img.__blit').forEach(e => e.remove());
const img = document.createElement('img'); img.className = '__blit'; img.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:0;pointer-events:none';
img.src = cv.toDataURL('image/png'); document.body.appendChild(img); src.style.visibility = 'hidden';
```
DOM overlays (`#ui`, `#cards`) still composite above the blit, so a screenshot shows both. Reload the page to clear it.
