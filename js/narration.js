/* narration.js — one narrator, one take per spread, a log instead of timers.
 *
 * Every take is an entry {spread, startedAt, offset, duration, pausedAt?} in
 * book seconds, so stateAt(t) is a pure function: which spread is being
 * read, how far into the take, whether it plays, is paused or is over. Live
 * mode also starts Web Audio at the matching offset through audio-core on
 * the 'narration' bus; capture mode writes only the log, and the karaoke
 * highlight follows the log either way, so a seek to any second is right.
 *
 * A single word is a slice of the same take, start - 0.06 to end + 0.06 with
 * 10 ms fades. Tapping a word mid-narration pauses the take, plays the
 * slice, and resumes from the same position at tap + slice + 0.15 s, which
 * update(time) checks against time rather than waiting on an audio
 * callback. Auto-advance works the same way: 0.7 s after a take ends the
 * page turns, and after the next settle the story card's reveal runs and the
 * next take starts 0.1 s after it finishes.
 *
 * Files: assets/audio/spread-NN.mp3 + assets/timings/spread-NN.json for the
 * story, title.mp3 + title.json for the title spread. Nothing for the
 * activities spread.
 */

import { load as loadAudio, play as playBuffer, bus, resume as resumeAudio } from './audio-core.js';
import { pad2, sliceFor, revealPlan } from './words.js';

const ASSETS = new URL('../assets/', import.meta.url);
const STORY_LAST = 15;
const ADVANCE_AFTER = 0.7;   // seconds after a take ends before the page turns
const SAY_GAP = 0.15;        // between a word slice and the resume
const BREATH = 0.1;          // after the reveal before the next take
export const WORD_CARD_LIFE = 2.2;

export const hasTake = (spread) => Number.isInteger(spread) && spread >= 0 && spread <= STORY_LAST;
export const takeUrl = (s) => new URL(s === 0 ? 'audio/title.mp3' : `audio/spread-${pad2(s)}.mp3`, ASSETS).href;
export const timingsUrl = (s) => new URL(s === 0 ? 'timings/title.json' : `timings/spread-${pad2(s)}.json`, ASSETS).href;

/* One per-frame hook shared by narration and the card. It chains onto the
   scene's onBeforeRender, which three calls once per render (from the
   composer's RenderPass) after the camera matrices are updated, so the card
   projects against the pose that is about to be drawn. update(time) can also
   be called from app.js's onFrame; a module already updated at this time
   skips the hook's call. */
export function frameHook(api) {
  if (api.__frameHook) return api.__frameHook;
  const fns = [];
  const scene = api.scene;
  const prev = scene && typeof scene.onBeforeRender === 'function' ? scene.onBeforeRender : null;
  if (scene) {
    scene.onBeforeRender = function onBeforeRender(...args) {
      if (prev) prev.apply(this, args);
      const t = api.time;
      for (const fn of fns.slice()) fn(t);
    };
  }
  api.__frameHook = {
    add(fn) {
      fns.push(fn);
      return () => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); };
    },
  };
  return api.__frameHook;
}

export function init(api) {
  if (api.narration) return api.narration;
  const live = api.mode === 'live';
  const { events } = api;
  const timings = new Map();          // spread -> data | null
  const timingsPending = new Map();
  const buffers = new Map();          // spread -> AudioBuffer (live only)
  const log = [];                     // take and say entries, sorted by time
  let handle = null;                  // the take's audio handle
  let sliceHandle = null;             // a word slice's audio handle
  let readThrough = false;            // keep reading across turns
  let pending = null;                 // {spread, settledAt}: play after the reveal
  let autoAdvance = true;
  let audioEnabled = true;            // a probe can run silent (no AudioContext)
  let unlocked = false;               // a real gesture has happened
  let stamp = null;

  /* ---- data ----------------------------------------------------------- */

  function loadTimings(spread) {
    if (!hasTake(spread)) return Promise.resolve(null);
    if (timings.has(spread)) return Promise.resolve(timings.get(spread));
    if (!timingsPending.has(spread)) {
      const p = fetch(timingsUrl(spread))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((data) => { timings.set(spread, data); timingsPending.delete(spread); return data; });
      timingsPending.set(spread, p);
    }
    return timingsPending.get(spread);
  }

  function loadBuffer(spread) {
    if (!live || !audioEnabled || !hasTake(spread)) return Promise.resolve(null);
    if (buffers.has(spread)) return Promise.resolve(buffers.get(spread));
    return loadAudio(takeUrl(spread))
      .then((b) => { buffers.set(spread, b); return b; })
      .catch(() => null);
  }

  /* Decoding needs the AudioContext, and creating one before a gesture is a
     console warning, so preloads wait for the first real tap or key. */
  function preload(spread) {
    loadTimings(spread);
    if (unlocked) loadBuffer(spread);
  }

  /* ---- the log -------------------------------------------------------- */

  const keyOf = (e) => (e.type === 'take' ? e.startedAt : e.at);
  function pushLog(entry) {
    let i = log.length;
    while (i > 0 && keyOf(log[i - 1]) > keyOf(entry)) i -= 1;
    log.splice(i, 0, entry);
    return entry;
  }

  const IDLE = Object.freeze({
    spread: null, startedAt: null, playing: false, paused: false, ended: false,
    stopped: false, position: 0, endAt: null, duration: 0, entry: null,
  });

  /* Pure: the narration state at book time t. */
  function stateAt(t) {
    let cur = null;
    for (const e of log) {
      if (e.type !== 'take') continue;
      if (e.startedAt <= t) cur = e; else break;
    }
    if (!cur) return IDLE;
    const stopAt = cur.pausedAt == null ? Infinity : cur.pausedAt;
    const endAt = cur.startedAt + (cur.duration - cur.offset);
    let position;
    let playing = false;
    let paused = false;
    let ended = false;
    if (endAt <= stopAt && t >= endAt) { position = cur.duration; ended = true; }
    else if (t >= stopAt) { position = cur.offset + (stopAt - cur.startedAt); paused = true; }
    else { position = cur.offset + (t - cur.startedAt); playing = true; }
    return {
      spread: cur.spread, startedAt: cur.startedAt, playing, paused, ended,
      stopped: !!cur.stopped, position, endAt: Math.min(endAt, stopAt), duration: cur.duration, entry: cur,
    };
  }

  /* The word card's say entry at t, if any is on screen. */
  function sayAt(t) {
    let cur = null;
    for (const e of log) {
      if (e.type !== 'say') continue;
      if (e.at <= t) cur = e; else break;
    }
    if (!cur) return null;
    const closeAt = Math.min(cur.at + WORD_CARD_LIFE, cur.closedAt == null ? Infinity : cur.closedAt);
    return { entry: cur, visible: t < closeAt, age: t - cur.at, closeAt };
  }

  function closeSay(at = api.time) {
    const s = sayAt(at);
    if (s && s.visible) { s.entry.closedAt = at; return s.entry; }
    return null;
  }

  /* ---- audio ---------------------------------------------------------- */

  const emitNarration = (spread, state, at) => events.emit('narration', { spread, state, at });

  function stopAudio() { if (handle) { handle.stop(0.03); handle = null; } }
  function stopSlice() { if (sliceHandle) { sliceHandle.stop(0.02); sliceHandle = null; } }

  function startAudio(spread, offset) {
    if (!live || !audioEnabled) return;
    const buf = buffers.get(spread);
    stopAudio();
    if (!buf || offset >= buf.duration) return;
    handle = playBuffer(buf, { offset, destination: bus('narration') });
  }

  /* A take that stops for good: a turn, a jump, another spread starting. */
  function stopTake(st, at) {
    if (!st.entry || (!st.playing && !st.paused)) return;
    if (st.playing) st.entry.pausedAt = at;
    st.entry.stopped = true;
    stopAudio();
    emitNarration(st.spread, 'end', at);
  }

  function cancelResumes() {
    for (const e of log) if (e.type === 'say' && e.resumeAt != null && !e.resumed) e.resumed = true;
  }

  /* ---- the API -------------------------------------------------------- */

  async function play(spread = api.book.spread) {
    if (!hasTake(spread)) return false;
    /* Stamp the time before anything can await: in capture mode a seek steps
       many frames inside one task, and an await would land the take on the
       last of them instead of the frame that asked for it. With the timings
       already cached (init preloads them) nothing here yields. */
    const now = api.time;
    const tm = timings.has(spread) ? timings.get(spread) : await loadTimings(spread);
    if (!tm) return false;
    if (live && audioEnabled) { resumeAudio(); await loadBuffer(spread); }
    const st = stateAt(now);
    if (st.playing && st.spread === spread) return true;
    if (st.entry && st.spread !== spread) stopTake(st, now);
    cancelResumes();
    stopSlice();
    let offset = 0;
    let state = 'start';
    if (st.spread === spread && st.paused && !st.stopped) { offset = st.position; state = 'resume'; }
    if (offset >= tm.duration - 0.05) { offset = 0; state = 'start'; }
    /* A fresh start picks up where the reader is: the text box on show, not
       the top of the spread, when they have stepped ahead by hand. */
    if (state === 'start') {
      const cs = api.card && typeof api.card.state === 'function' ? api.card.state() : null;
      const first = cs && cs.spread === spread ? cs.boxStart : 0;
      if (first > 0 && tm.words[first] && Number.isFinite(tm.words[first].start)) {
        offset = Math.max(0, tm.words[first].start - 0.08);
      }
    }
    pushLog({ type: 'take', spread, startedAt: now, offset, duration: tm.duration });
    startAudio(spread, offset);
    readThrough = true;
    pending = null;
    emitNarration(spread, state, now);
    return true;
  }

  function pause() {
    const now = api.time;
    const st = stateAt(now);
    cancelResumes();
    readThrough = false;
    pending = null;
    if (!st.playing) return false;
    st.entry.pausedAt = now;
    stopAudio();
    emitNarration(st.spread, 'pause', now);
    return true;
  }

  function toggle() {
    return stateAt(api.time).playing ? Promise.resolve(pause()) : play();
  }

  /* Say one word: a slice of the take. Returns the say entry (start, end,
     duration, at) or null. If the take is playing it pauses for the slice
     and resumes on its own from the same position. */
  async function sayWord(spread, i) {
    const now = api.time;
    const tm = timings.has(spread) ? timings.get(spread) : await loadTimings(spread);
    if (!tm || !tm.words[i]) return null;
    if (live && audioEnabled) { resumeAudio(); await loadBuffer(spread); }
    const slice = sliceFor(tm.words, i, tm.duration);
    const st = stateAt(now);
    const hadPending = log.some((e) => e.type === 'say' && e.resumeAt != null && !e.resumed);
    cancelResumes();
    let resumeAt = null;
    if (st.playing) {
      st.entry.pausedAt = now;
      stopAudio();
      emitNarration(st.spread, 'pause', now);
      resumeAt = now + slice.duration + SAY_GAP;
    } else if (hadPending && st.paused && !st.stopped) {
      resumeAt = now + slice.duration + SAY_GAP;
    }
    const entry = pushLog({
      type: 'say', spread, i, text: tm.words[i].text, at: now,
      start: slice.offset, end: slice.end, duration: slice.duration,
      resumeAt, resumed: false, closedAt: null,
    });
    if (live && audioEnabled) {
      const buf = buffers.get(spread);
      stopSlice();
      if (buf) sliceHandle = playBuffer(buf, { offset: slice.offset, duration: slice.duration, fade: 0.01, destination: bus('narration') });
    }
    return entry;
  }

  function revealEndFor(p) {
    const cs = api.card && typeof api.card.state === 'function' ? api.card.state() : null;
    if (cs && cs.spread === p.spread && Number.isFinite(cs.revealEndsAt)) return cs.revealEndsAt + BREATH;
    const tm = timings.get(p.spread);
    return p.settledAt + revealPlan(tm ? tm.words.length : 60).total + BREATH;
  }

  /* Per frame. Everything here compares the log against time. */
  function update(time) {
    stamp = time;
    const st = stateAt(time);

    if (st.entry && st.ended && !st.entry.endedEmitted) {
      st.entry.endedEmitted = true;
      handle = null;
      emitNarration(st.spread, 'end', st.endAt);
      if (!(autoAdvance && hasTake(st.spread + 1))) readThrough = false;
    }

    if (live && st.entry && st.ended && autoAdvance && readThrough && !st.entry.advanced
        && time >= st.endAt + ADVANCE_AFTER) {
      st.entry.advanced = true;
      if (hasTake(st.spread + 1) && api.turn && api.book.spread === st.spread) api.turn.next();
    }

    for (const e of log) {
      if (e.type !== 'say' || e.resumeAt == null || e.resumed || time < e.resumeAt) continue;
      e.resumed = true;
      const ps = stateAt(e.resumeAt);
      if (!ps.paused || ps.stopped) continue;
      pushLog({ type: 'take', spread: ps.spread, startedAt: e.resumeAt, offset: ps.position, duration: ps.entry.duration });
      startAudio(ps.spread, ps.position + (time - e.resumeAt));
      emitNarration(ps.spread, 'resume', e.resumeAt);
    }

    if (pending && time >= revealEndFor(pending)) {
      const s = pending.spread;
      pending = null;
      play(s);
    }
  }

  /* ---- book events ---------------------------------------------------- */

  events.on('settle', ({ spread }) => {
    preload(spread);
    preload(spread + 1);
    pending = readThrough && hasTake(spread) ? { spread, settledAt: api.time } : null;
  });

  events.on('turnStart', ({ to }) => {
    preload(to);
    stopTake(stateAt(api.time), api.time);
    stopSlice();
    cancelResumes();
    pending = null;
  });

  events.on('jump', ({ spread }) => {
    preload(spread);
    stopTake(stateAt(api.time), api.time);
    stopSlice();
    cancelResumes();
    pending = null;
    readThrough = false;
  });

  if (live) {
    const unlock = () => {
      unlocked = true;
      preload(api.book.spread);
      preload(api.book.spread + 1);
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true, passive: true });
  }

  /* Timings are small; having them all resident makes capture-mode seeks
     and the first Read to me synchronous. */
  for (let s = 0; s <= STORY_LAST; s += 1) loadTimings(s);

  const narration = {
    play,
    pause,
    toggle,
    sayWord,
    stateAt,
    state() { return { ...stateAt(api.time), autoAdvance, readThrough }; },
    update,
    get playing() { return stateAt(api.time).playing; },
    get autoAdvance() { return autoAdvance; },
    set autoAdvance(v) { autoAdvance = !!v; },
    get audioEnabled() { return audioEnabled; },
    set audioEnabled(v) { audioEnabled = !!v; if (!audioEnabled) { stopAudio(); stopSlice(); } },
    get readThrough() { return readThrough; },
    log,
    hasTake,
    loadTimings,
    timings: (s) => timings.get(s) || null,
    sayAt,
    closeSay,
    takeUrl,
    get handles() { return { take: handle, slice: sliceHandle }; },
  };

  frameHook(api).add((t) => { if (stamp !== t) update(t); });
  return narration;
}
