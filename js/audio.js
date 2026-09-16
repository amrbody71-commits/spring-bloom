/* audio.js, the soundscape on top of audio-core.
 *
 * Buses: sfx 0.9, ambience 0.35, bed 0.16 (ducked to 0.06 with a 250 ms ramp
 * while narration plays). The narration bus belongs to the narration module.
 *
 * Events map to files in assets/sfx: turnStart to page-turn (scheduled at the
 * turn's `at`), settle to a quiet page-settle, cover open to cover-open, rise
 * to rise, tap and wordTap to tap-pop, count kinds to shell-drop, twig-tick,
 * pebble-drop and carry, and a layer focus to sparkle. The ambience loops
 * with a 1 s equal-power seam (two overlapping sources) from the first
 * unlock; the bed loops the same way and starts when the cover opens.
 *
 * unlock() resumes the context and is wired to the first pointerdown,
 * pointerup and keydown on the document (touch activation arrives on
 * pointerup). Nothing plays before it: a source started on a suspended
 * context would pile up and burst out on resume.
 *
 * Capture mode loads nothing and plays nothing; the reel mixes its own audio.
 */

import { context, resume, load, play, bus, setMuted } from './audio-core.js';

const SFX = {
  'page-turn': 'assets/sfx/page-turn.mp3',
  'page-settle': 'assets/sfx/page-settle.mp3',
  'cover-open': 'assets/sfx/cover-open.mp3',
  rise: 'assets/sfx/rise.mp3',
  'tap-pop': 'assets/sfx/tap-pop.mp3',
  'shell-drop': 'assets/sfx/shell-drop.mp3',
  'twig-tick': 'assets/sfx/twig-tick.mp3',
  'pebble-drop': 'assets/sfx/pebble-drop.mp3',
  carry: 'assets/sfx/carry.mp3',
  sparkle: 'assets/sfx/sparkle.mp3',
};
const AMBIENCE_URL = 'assets/sfx/ambience.mp3';
const BED_URL = 'assets/bed/bed.mp3';
const GAIN = { sfx: 0.9, ambience: 0.35, bed: 0.16 };
const BED_DUCKED = 0.06;
const DUCK_S = 0.25;
const SEAM_S = 1.0;
const STOP_S = 0.5;
const COUNT_SFX = { shell: 'shell-drop', twig: 'twig-tick', pebble: 'pebble-drop', carry: 'carry' };

/* A gapless loop: each pass of the buffer is its own source with an
   equal-power fade at both ends, and the next pass starts SEAM_S before the
   current one ends. Two passes are always scheduled; when one ends, the one
   after next is queued from the last start time, so nothing here needs a
   timer and a busy main thread cannot open a gap. */
function makeLoop(destination, seam) {
  const N = 64;
  const fadeIn = new Float32Array(N);
  const fadeOut = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    const k = (i / (N - 1)) * Math.PI / 2;
    fadeIn[i] = Math.sin(k);
    fadeOut[i] = Math.cos(k);
  }
  let run = null;

  function pass(r, at) {
    if (run !== r) return;
    const c = context();
    const dur = r.buffer.duration;
    const src = c.createBufferSource();
    src.buffer = r.buffer;
    const g = c.createGain();
    g.gain.setValueCurveAtTime(fadeIn, at, r.seam);
    g.gain.setValueCurveAtTime(fadeOut, at + dur - r.seam, r.seam);
    src.connect(g);
    g.connect(r.gain);
    src.start(at);
    src.stop(at + dur);
    r.sources.add(src);
    r.lastStart = at;
    src.onended = () => {
      r.sources.delete(src);
      try { src.disconnect(); g.disconnect(); } catch (e) { /* gone */ }
      if (run === r) pass(r, r.lastStart + dur - r.seam);
    };
  }

  return {
    get running() { return !!run; },
    start(buffer) {
      if (run && run.buffer === buffer) return;
      this.stop();
      const c = context();
      const s = Math.min(seam, buffer.duration / 3);
      const r = { buffer, seam: s, gain: c.createGain(), sources: new Set(), lastStart: 0 };
      r.gain.gain.value = 1;
      r.gain.connect(destination);
      run = r;
      const t0 = c.currentTime + 0.05;
      pass(r, t0);
      pass(r, t0 + buffer.duration - s);
    },
    stop() {
      const r = run;
      if (!r) return;
      run = null;
      const c = context();
      const t = c.currentTime;
      const g = r.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + STOP_S);
      for (const src of r.sources) {
        try { src.stop(t + STOP_S + 0.05); } catch (e) { /* already stopping */ }
      }
    },
  };
}

export function init(api) {
  const live = api.mode === 'live';
  const state = { muted: false, unlocked: false, ambienceOn: true, bedOn: false, ducked: false };

  if (!live) {
    return {
      sfx() { return null; },
      ambience() {},
      bed() {},
      duck() {},
      mute(on) { state.muted = !!on; },
      get muted() { return state.muted; },
      get unlocked() { return false; },
      unlock() { return Promise.resolve(false); },
      buffers: new Map(),
      buses: null,
    };
  }

  const buffers = new Map();
  const loading = new Map();
  const buses = {
    sfx: bus('sfx', GAIN.sfx),
    ambience: bus('ambience', GAIN.ambience),
    bed: bus('bed', GAIN.bed),
  };
  buses.sfx.gain.value = GAIN.sfx;
  buses.ambience.gain.value = GAIN.ambience;
  buses.bed.gain.value = GAIN.bed;

  function preload(id, url) {
    const p = load(url)
      .then((buf) => { buffers.set(id, buf); return buf; })
      .catch((err) => { console.warn(`audio: ${id} did not load (${err && err.message})`); return null; });
    loading.set(id, p);
    return p;
  }
  for (const [id, url] of Object.entries(SFX)) preload(id, url);
  preload('ambience', AMBIENCE_URL);
  preload('bed', BED_URL);

  const loops = { ambience: makeLoop(buses.ambience, SEAM_S), bed: makeLoop(buses.bed, SEAM_S * 1.5) };

  function whenLoaded(id, fn) {
    const buf = buffers.get(id);
    if (buf) { fn(buf); return; }
    const p = loading.get(id);
    if (p) p.then((b) => { if (b) fn(b); });
  }

  function settleLoops() {
    if (!state.unlocked) return;
    if (state.ambienceOn) whenLoaded('ambience', (b) => { if (state.ambienceOn && state.unlocked) loops.ambience.start(b); });
    else loops.ambience.stop();
    if (state.bedOn) whenLoaded('bed', (b) => { if (state.bedOn && state.unlocked) loops.bed.start(b); });
    else loops.bed.stop();
  }

  function sfx(id, { gain = 1, when = 0 } = {}) {
    if (!state.unlocked) return null;
    const buf = buffers.get(id);
    if (!buf) return null;
    return play(buf, { gain, when: Math.max(0, when || 0), destination: buses.sfx });
  }

  function ambience(on) {
    state.ambienceOn = !!on;
    settleLoops();
  }

  function bed(on) {
    state.bedOn = !!on;
    settleLoops();
  }

  function duck(on) {
    state.ducked = !!on;
    const g = buses.bed.gain;
    const t = context().currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(state.ducked ? BED_DUCKED : GAIN.bed, t + DUCK_S);
  }

  function mute(on) {
    state.muted = !!on;
    setMuted(state.muted);
  }

  async function unlock() {
    const s = await resume();
    if (s !== 'running') return false;
    if (!state.unlocked) {
      state.unlocked = true;
      setMuted(state.muted);
      if (api.book && api.book.isOpen) state.bedOn = true;
      settleLoops();
    }
    return true;
  }

  const gestures = ['pointerdown', 'pointerup', 'keydown'];
  function onGesture() {
    unlock().then((ok) => {
      if (ok) for (const g of gestures) document.removeEventListener(g, onGesture, true);
    });
  }
  for (const g of gestures) document.addEventListener(g, onGesture, true);

  /* ---- events ------------------------------------------------------- */

  const ev = api.events;
  ev.on('turnStart', (p) => {
    const when = p && Number.isFinite(p.at) ? p.at - api.time : 0;
    sfx('page-turn', { when });
  });
  ev.on('settle', () => sfx('page-settle', { gain: 0.4 }));
  ev.on('cover', (p) => {
    if (p && p.open) { sfx('cover-open'); bed(true); } else bed(false);
  });
  ev.on('jump', () => { if (api.book && api.book.isOpen) bed(true); });
  ev.on('rise', () => sfx('rise', { gain: 0.8 }));
  ev.on('tap', () => sfx('tap-pop'));
  ev.on('wordTap', () => sfx('tap-pop', { gain: 0.7 }));
  ev.on('count', (p) => { const id = COUNT_SFX[p && p.kind]; if (id) sfx(id); });
  ev.on('focus', (p) => { if (p && p.source === 'layer') sfx('sparkle', { gain: 0.7 }); });
  ev.on('narration', (p) => {
    if (!p) return;
    if (p.state === 'start' || p.state === 'resume') duck(true);
    else if (p.state === 'pause' || p.state === 'end') duck(false);
  });

  return {
    sfx,
    ambience,
    bed,
    duck,
    mute,
    unlock,
    get muted() { return state.muted; },
    get unlocked() { return state.unlocked; },
    get ducked() { return state.ducked; },
    get ambienceOn() { return state.ambienceOn; },
    get bedOn() { return state.bedOn; },
    buffers,
    buses,
    loops,
  };
}
