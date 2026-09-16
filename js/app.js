/* app.js — boot. Builds the clock, scene, book, turn and camera, wires the
 * frame, and exposes everything on window.__book.
 *
 * Boot never waits for textures: the loop starts at once with navy boards
 * and cream pages, and each image lands on its face when it arrives. In
 * capture mode the frame is re-rendered when the first spread is resident,
 * so a `?t=` freeze shows the real art.
 *
 * URL switches:
 *   ?capture&fps=30   capture mode, time driven from outside (hf-seek)
 *   ?t=<seconds>      capture mode, one frame at that time
 *   ?seed=<n>         blanket weave seed (default 7)
 *   ?reduced=1        settle every turn and the cover without animation
 *
 * stats(n) steps n frames with a 1x1 readPixels after each so the mean
 * includes GPU time; a bare stats() reports the last frame's counts.
 */

import { vw, vh } from './viewport.js';
import { createEvents } from './events.js';
import { createClock } from './clock.js';
import { createTexturePool } from './textures.js';
import { createCamera } from './camera.js';
import { createScene } from './scene.js';
import { createBook } from './book.js';
import { createTurn } from './turn.js';
import { init as initAudio } from './audio.js';
import { init as initCamera } from './ledger.js';
import { init as initPopup } from './popup.js';
import { init as initNarration } from './narration.js';
import { init as initCard } from './card.js';
import { init as initTray } from './tray.js';
import { init as initUi } from './ui.js';
import { init as initCursor } from './cursor.js';
import { createTour, loadTour } from './tour.js';
import { initCapture } from './capture.js';

export function boot({ canvas, params = new URLSearchParams(location.search) } = {}) {
  const seed = Number(params.get('seed')) || 7;
  const capture = params.has('capture') || params.has('t');
  const mode = capture ? 'capture' : 'live';
  const live = !capture;
  const reduced = params.get('reduced') === '1'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const events = createEvents();
  const camera = createCamera({ reduced, live });
  const sceneKit = createScene({ canvas, camera, seed, reduced });
  const { renderer, scene, composer, render, setSize, setFog } = sceneKit;
  const pool = createTexturePool({ renderer });

  let turn = null;
  let tour = null;
  let cap = null;
  function onFrame(dt, time) {
    /* The tour fires its events first so a turn or a focus requested at this
       time is seen by every module in the same frame. */
    if (tour) tour.update(time);
    turn.update(dt, time);
    camera.update(dt, time);
    if (cap) cap.update(time);
    /* DOM modules (interface, cursor, capture overlays) follow the same clock
       through this event; scene modules chain on scene.onBeforeRender. */
    events.emit('frame', { dt, time });
    render(time);
  }

  const clock = createClock({ mode, onFrame });
  const book = createBook({ pool, clock, events, reduced });
  scene.add(book.group);
  turn = createTurn({ book, pool, clock, events, camera, canvas, reduced, live });

  function resize() {
    /* The reel pins its frame size (?w=1080&h=1920) so the render never
       depends on the headless browser's window. */
    const w = Number(params.get('w')) || vw();
    const h = Number(params.get('h')) || vh();
    setSize(w, h, Number(params.get('dpr')) || undefined);
    camera.refit(w / h);
    setFog(camera.home.distance);
  }
  window.addEventListener('resize', resize);
  resize();

  /* A seek with a tour running steps through every frame between the old
     time and the new one at the capture rate, so each scripted event fires at
     its own moment and every module stamps the right time. Seeking backwards
     resets the book and replays from zero. Without a tour a seek is a jump. */
  const fps = Number(params.get('fps')) || 30;
  function seek(t) {
    if (!tour) { clock.renderAt(t); return; }
    if (t < clock.time - 1e-6) { tour.reset(); clock.time = 0; clock.renderAt(0); }
    const dt = 1 / fps;
    let guard = 0;
    while (clock.time + dt <= t + 1e-6 && guard < 20000) { clock.frame(dt); guard += 1; }
    if (t > clock.time + 1e-6) clock.renderAt(t);
  }

  window.addEventListener('hf-seek', (e) => {
    const t = e && e.detail ? Number(e.detail.time) : NaN;
    if (Number.isFinite(t)) seek(t);
  });

  if (live) {
    camera.footprint = () => book.footprint();
    camera.attach(canvas);
    turn.attach();
    clock.start();
    /* The reader's orbit and zoom ease back when the book moves on or the
       camera flies somewhere authored. */
    for (const name of ['settle', 'focus', 'unfocus', 'cover', 'jump']) {
      events.on(name, () => { if (camera.resetOrbit) camera.resetOrbit(); });
    }
  } else {
    clock.renderAt(Number(params.get('t')) || 0);
    book.ready.then(() => clock.renderAt(clock.time));
  }

  function stats(n = 0) {
    let meanMs = null;
    if (n > 0) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const t0 = performance.now();
      for (let i = 0; i < n; i += 1) {
        clock.frame(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      meanMs = (performance.now() - t0) / n;
    }
    const r = renderer.info.render;
    const m = renderer.info.memory;
    return {
      calls: r.calls,
      triangles: r.triangles,
      meanMs,
      dpr: renderer.getPixelRatio(),
      width: canvas.width,
      height: canvas.height,
      textures: m.textures,
      geometries: m.geometries,
      resident: pool.resident(),
      spread: book.spread,
      state: book.state,
      time: clock.time,
    };
  }

  /* True GPU time per frame from EXT_disjoint_timer_query_webgl2, which the
     laptop's ANGLE/D3D11 driver exposes. CPU-side timing with a readPixels
     sync measured nothing useful in a hidden or emulated pane. Resolves to
     null where the extension is missing. */
  async function gpuMs(n = 60) {
    const gl = renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    clock.frame(1 / 60);
    const queries = [];
    for (let i = 0; i < n; i += 1) {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      clock.frame(1 / 60);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      queries.push(q);
    }
    gl.flush();
    /* Few, long polls: a background tab clamps timers to a second each, and
       sixty frames of GPU work are done long before the second poll. */
    const last = queries[n - 1];
    for (let k = 0; k < 12 && !gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE); k += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const ms = queries
      .map((q) => (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) ? gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 : NaN))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    queries.forEach((q) => gl.deleteQuery(q));
    if (!ms.length) return null;
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    return { mean: +mean.toFixed(2), median: +ms[ms.length >> 1].toFixed(2), min: +ms[0].toFixed(2), max: +ms[ms.length - 1].toFixed(2), frames: ms.length };
  }

  const api = {
    get time() { return clock.time; },
    mode,
    reduced,
    seed,
    frame: clock.frame,
    renderAt: seek,
    forceRender() { onFrame(0, clock.time); },
    stats,
    gpuMs,
    resize,
    scene,
    camera,
    renderer,
    composer,
    book,
    turn,
    events,
    pool,
    clock,
    vw,
    vh,
    ready: book.ready,
  };
  window.__book = api;

  /* The lamp switch: the interface's button and a tap on the lamp itself
     both come here; `lamp` is emitted so the button can follow a tap. */
  api.lamp = {
    get on() { return sceneKit.lampOn; },
    set(on, at = clock.time) {
      if (!sceneKit.setLamp(on)) return false;
      if (api.audio && api.audio.sfx) api.audio.sfx('tap-pop', { gain: 0.5 });
      events.emit('lamp', { on: sceneKit.lampOn, at });
      return true;
    },
    toggle(at) { return api.lamp.set(!sceneKit.lampOn, at); },
  };

  /* Modules in dependency order. One failing module logs and leaves the rest
     standing: the book still opens and turns without its card or its tray. */
  const wire = (name, fn) => { try { const v = fn(); if (v !== undefined) api[name] = v; } catch (err) { console.error(`[spring-bloom] ${name} failed to init`, err); } };
  wire('audio', () => initAudio(api));
  wire('ledger', () => { initCamera(api); });
  wire('popup', () => initPopup(api));
  wire('narration', () => initNarration(api));
  wire('card', () => initCard(api));
  wire('tray', () => initTray(api));
  wire('ui', () => initUi(api));
  wire('cursor', () => initCursor(api));
  /* Keys behave like the bar's arrows: next box first, then the page. */
  turn.beforeNext = () => !!(api.card && api.card.advance && api.card.advance());
  turn.beforePrev = () => !!(api.card && api.card.retreat && api.card.retreat());

  /* ?tour=<url> plays a scripted run: an autopilot in live mode, the reel's
     script in capture mode. ?tour=1 means reel/tour.json. */
  /* Capture mode holds the whole book in memory before the first frame: a
     render must never show a page whose art is still downloading. */
  if (capture) {
    pool.setKeepAll(true);
    pool.want(book.spread);
    if (api.popup && api.popup.prepareAll) api.popup.prepareAll();
    api.ready = Promise.all([
      book.ready,
      pool.idle(),
      api.popup && api.popup.idle ? api.popup.idle() : null,
      document.fonts ? document.fonts.ready : null,
    ]).then(() => clock.renderAt(clock.time));
  }

  const tourParam = params.get('tour');
  if (tourParam) {
    const url = tourParam === '1' ? 'reel/tour.json' : tourParam;
    if (capture) cap = api.capture = initCapture(api);
    api.tourReady = Promise.all([loadTour(url), api.ready]).then(([events]) => {
      tour = api.tour = createTour(api, events);
      if (capture) { const t = clock.time; clock.time = 0; seek(t); }
      return tour;
    }).catch((err) => { console.error('[spring-bloom] tour failed to load', err); });
  }

  return api;
}
