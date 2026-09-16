/* audio-core.js — the one AudioContext, decoded-buffer cache, master gain.
 *
 * Every module that makes sound (narration, word slices, effects, ambience,
 * the bed) plays through here so one mute silences everything and one
 * resume() after the first tap unlocks all of it. Buffers are decoded once
 * and shared. Nothing here depends on book time; callers schedule.
 */

let ctx = null;
let master = null;
const buffers = new Map();
const pending = new Map();

export function context() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function masterGain() { context(); return master; }

/* Browsers keep the context suspended until a user gesture; call on the
   first pointerdown or key press. Safe to call repeatedly. */
export async function resume() {
  const c = context();
  if (c.state !== 'running') { try { await c.resume(); } catch (e) { /* not yet allowed */ } }
  return c.state;
}

export function muted() { return master ? master.gain.value === 0 : false; }
export function setMuted(on) { masterGain().gain.value = on ? 0 : 1; }

/* Decode once; concurrent callers share the same promise. */
export function load(url) {
  if (buffers.has(url)) return Promise.resolve(buffers.get(url));
  if (pending.has(url)) return pending.get(url);
  const p = fetch(url)
    .then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.arrayBuffer(); })
    .then((ab) => context().decodeAudioData(ab))
    .then((buf) => { buffers.set(url, buf); pending.delete(url); return buf; });
  pending.set(url, p);
  return p;
}

/* Play a decoded buffer. Returns a handle with stop() and a `done` promise.
   offset/duration cut a slice (used for single words out of a narration take);
   fade adds short ramps at both ends so slices never click. */
export function play(buffer, { gain = 1, when = 0, offset = 0, duration, loop = false, fade = 0.01, destination } = {}) {
  const c = context();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.loop = loop;
  const g = c.createGain();
  const t0 = c.currentTime + Math.max(0, when);
  const len = duration ?? (buffer.duration - offset);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + fade);
  if (!loop) {
    g.gain.setValueAtTime(Math.max(0.0001, gain), t0 + Math.max(fade, len - fade));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
  }
  src.connect(g);
  g.connect(destination || master);
  if (loop) src.start(t0, offset); else src.start(t0, offset, len);
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) { /* already gone */ } resolveDone(); };
  return {
    source: src,
    gainNode: g,
    done,
    stop(rampSeconds = 0.03) {
      const t = c.currentTime;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + rampSeconds);
        src.stop(t + rampSeconds + 0.005);
      } catch (e) { /* stopped already */ }
    },
  };
}

/* A named bus (a GainNode into master) so a module can fade its whole group:
   'narration', 'sfx', 'ambience', 'bed'. */
const buses = new Map();
export function bus(name, gain = 1) {
  if (!buses.has(name)) {
    const g = context().createGain();
    g.gain.value = gain;
    g.connect(masterGain());
    buses.set(name, g);
  }
  return buses.get(name);
}
