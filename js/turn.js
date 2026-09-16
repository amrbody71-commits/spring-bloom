/* turn.js — one page turn at a time: tween, drag, throw, hold.
 *
 * Owns the live state machine for the turning leaf and the pointer and
 * keyboard input that drives it. The settled spread lives in book.base and
 * the in-flight turn here; every frame the two are folded into one view and
 * handed to book.apply(), which is the only thing that moves geometry.
 *
 * Kinds of turn:
 *   tween   0.9 s power2.inOut as a function of book.time (buttons, keys,
 *           taps, turn.to). Capture mode only ever sees this kind.
 *   drag    pointer x projected onto the page plane maps to t; the grab
 *           point reaches the far edge at t = 1.
 *   spring  after a release: k 150, c 22 toward 0 or 1, seeded with the
 *           drag velocity. Commit rule from MengTo's sketchbook:
 *           t > 0.42 or velocity > 1.1 commits, a flick back cancels, a tap
 *           (under 6 px) turns the page.
 *   hold    the probe page's turn.set(t): parked at t until told otherwise.
 *
 * Before a turn starts `beforeTurn` is emitted and the largest number any
 * listener returns is waited out (a later unit folds pop-up layers flat in
 * that window). `settle` fires when the leaf comes to rest either way.
 *
 * Twist is the one quantity that is not a function of time: a filtered
 * response to drag velocity, clamped to 0.12, live mode only.
 */

import * as THREE from 'three';
import { LEAF_COUNT, PAGE_W } from './leaf.js';
import { easeInOut, clamp01 } from './book.js';
import { vw, vh } from './viewport.js';

const TURN_S = 0.9;
const SPRING_K = 150;
const SPRING_C = 22;
const COMMIT_T = 0.42;
const COMMIT_V = 1.1;
const TAP_PX = 6;
const TWIST_MAX = 0.12;
const THROW_MAX = 3;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createTurn({ book, pool, clock, events, camera, canvas, reduced = false, live = true }) {
  let active = null;
  let twist = 0;
  let goal = null;
  let drag = null;

  const spread = () => book.base.spread;

  function apply() {
    const view = active
      ? {
        spread: active.from,
        active: { leaf: active.leaf, from: active.from, to: active.to, t: clamp01(active.t), twist },
      }
      : { spread: spread(), active: null };
    book.apply(view, clock.time);
  }

  function begin(dir, kind, t0 = 0) {
    const from = spread();
    const to = from + dir;
    if (to < 0 || to >= LEAF_COUNT) return null;
    const answers = events.emit('beforeTurn', { from, to, dir });
    const delay = kind === 'hold' ? 0 : Math.max(0, ...answers.filter((n) => typeof n === 'number'));
    active = {
      dir, from, to,
      leaf: dir > 0 ? from : to,
      t: t0,
      kind,
      start: clock.time + delay,
      dur: reduced ? 0 : TURN_S,
      v: 0,
      target: 1,
      released: 0,
    };
    pool.want(from, to);
    /* `at` is when the sheet starts moving in book time, so a sound can be
       scheduled to land on it rather than on the fold that precedes it. */
    events.emit('turnStart', { from, to, dir, kind, at: active.start });
    return active;
  }

  function settle(target) {
    const a = active;
    active = null;
    twist = 0;
    const s = target ? a.to : a.from;
    book.base.spread = s;
    if (target) {
      const t0 = a.kind === 'tween' ? a.start : a.released;
      book.log.push({ type: 'turn', t: t0, from: a.from, to: a.to, dur: Math.max(0, clock.time - t0) });
    }
    pool.want(s);
    apply();
    events.emit('settle', { spread: s, from: a.from, to: a.to, committed: !!target });
    if (goal !== null && goal !== s) begin(goal > s ? 1 : -1, 'tween');
    else goal = null;
  }

  function release(vel = 0) {
    if (!active) return;
    const a = active;
    const back = vel < -COMMIT_V;
    const go = !back && (a.t > COMMIT_T || vel > COMMIT_V);
    const target = go ? 1 : 0;
    if (reduced || !live) {
      a.t = target;
      settle(target);
      return;
    }
    a.kind = 'spring';
    a.target = target;
    a.v = clamp(vel, -THROW_MAX, THROW_MAX);
    a.released = clock.time;
  }

  let captureView = null;
  function update(dt, time) {
    if (!live) {
      /* The log is the truth in capture mode; the settle event still has to
         fire when a logged turn ends, because the card, the interface, the
         narration and the tray all take their cue from it. */
      const view = book.resolve(time);
      book.apply(view, time);
      if (!view.active && captureView && captureView.active) {
        const a = captureView.active;
        events.emit('settle', { spread: view.spread, from: a.from, to: a.to, committed: true });
      }
      captureView = view;
      return;
    }
    if (active) {
      const a = active;
      if (time >= a.start) {
        if (a.kind === 'tween') {
          const k = a.dur > 0 ? clamp01((time - a.start) / a.dur) : 1;
          a.t = easeInOut(k);
          if (k >= 1) { settle(1); return; }
        } else if (a.kind === 'spring' && dt > 0) {
          const x = a.t - a.target;
          a.v += (-SPRING_K * x - SPRING_C * a.v) * dt;
          a.t += a.v * dt;
          if (Math.abs(a.t - a.target) < 0.002 && Math.abs(a.v) < 0.02) {
            a.t = a.target;
            settle(a.target);
            return;
          }
        }
      }
      const want = a.kind === 'drag' ? clamp(a.v * 0.03 * a.dir, -TWIST_MAX, TWIST_MAX) : 0;
      if (dt > 0) twist += (want - twist) * (1 - Math.exp(-dt * 14));
    } else {
      twist = 0;
    }
    apply();
  }

  /* ---- pointer and keys --------------------------------------------- */

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  function project(e) {
    ndc.set((e.clientX / vw()) * 2 - 1, -((e.clientY / vh()) * 2 - 1));
    ray.setFromCamera(ndc, camera);
    const fp = book.footprint();
    plane.constant = -fp.top;
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, z: hit.z, fp };
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const h = project(e);
    if (!h) return;
    const over = h.x >= h.fp.xMin && h.x <= h.fp.xMax && h.z >= h.fp.zMin && h.z <= h.fp.zMax;
    if (!over) return;
    e.preventDefault();
    if (!book.isOpen) {
      if (book.state === 'closed') book.openCover();
      return;
    }
    if (active) return;
    const a = begin(h.x >= 0 ? 1 : -1, 'drag');
    if (!a) return;
    /* A synthetic PointerEvent (tests, the probe) has no active pointer to
       capture and the call throws; the drag works without capture. */
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* see above */ }
    drag = { id: e.pointerId, x0: h.x, px: e.clientX, py: e.clientY, moved: 0, vel: 0, stamp: e.timeStamp };
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!active) { drag = null; return; }
    const h = project(e);
    if (!h) return;
    drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.px, e.clientY - drag.py));
    const raw = active.dir > 0
      ? (drag.x0 - h.x) / (drag.x0 + PAGE_W)
      : (h.x - drag.x0) / (PAGE_W - drag.x0);
    const t = clamp01(raw);
    const secs = Math.max(0.004, (e.timeStamp - drag.stamp) / 1000);
    drag.vel = drag.vel * 0.4 + ((t - active.t) / secs) * 0.6;
    drag.stamp = e.timeStamp;
    if (clock.time >= active.start) active.t = t;
    active.v = drag.vel;
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!active) return;
    if (d.moved < TAP_PX) {
      active.kind = 'tween';
      active.start = Math.max(active.start, clock.time);
      active.v = 0;
      return;
    }
    release(d.vel);
  }

  function onKey(e) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    /* Space on a focused button (a word on the card, a control in the bar)
       belongs to that button; only the arrows turn pages from there. */
    if (tag === 'BUTTON' && e.key === ' ') return;
    /* app.js hooks beforeNext/beforePrev so the arrows step the story card's
       text boxes first and turn the page only past the last one. */
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); if (!(turn.beforeNext && turn.beforeNext())) turn.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (!(turn.beforePrev && turn.beforePrev())) turn.prev(); }
  }

  events.on('jump', () => { active = null; goal = null; drag = null; twist = 0; });

  const turn = {
    get active() { return active; },
    get t() { return active ? active.t : 0; },
    get spread() { return spread(); },
    get twist() { return twist; },

    next() {
      if (!book.isOpen) {
        if (book.state === 'closed') book.openCover();
        return false;
      }
      if (active) return false;
      if (!live) return turn.record(1);
      return !!begin(1, 'tween');
    },

    prev() {
      if (active) return false;
      if (spread() === 0) return book.closeCover();
      if (!live) return turn.record(-1);
      return !!begin(-1, 'tween');
    },

    to(s) {
      const target = clamp(Math.round(s), 0, LEAF_COUNT - 1);
      if (target === spread() && !active) return false;
      goal = target;
      if (!active) begin(target > spread() ? 1 : -1, 'tween');
      return true;
    },

    /* Capture mode: a turn is a log entry, replayed from time. */
    record(dir) {
      const last = book.resolve(clock.time);
      if (last.active) return false;
      const from = last.spread;
      const to = from + dir;
      if (to < 0 || to >= LEAF_COUNT) return false;
      book.log.push({ type: 'turn', t: clock.time, from, to, dur: reduced ? 0 : TURN_S });
      pool.want(from, to);
      return true;
    },

    /* Probe hooks: park the leaf at t, then release or settle it. */
    set(t, dir = 1) {
      if (!active) begin(dir, 'hold');
      if (!active) return false;
      active.kind = 'hold';
      active.t = clamp01(t);
      apply();
      return true;
    },
    release,
    settle(target = 1) {
      if (!active) return false;
      active.t = target ? 1 : 0;
      settle(target ? 1 : 0);
      return true;
    },

    update,
    apply,

    attach() {
      if (!live) return;
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      canvas.addEventListener('dragstart', (e) => e.preventDefault());
      window.addEventListener('keydown', onKey);
    },
  };

  return turn;
}
