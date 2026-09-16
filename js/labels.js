/* labels.js — the label pill, and the pointer over the pop-up layers.
 *
 * Hover a standing layer and a small cream pill with its name floats above
 * the layer's top centre. Tap it and the name is spoken (assets/audio/labels/
 * <slug>.mp3 through audio-core's sfx bus), sparkles burst from the tap
 * point, and `tap` and `focus` go out; a second tap on the same layer, or a
 * tap on empty page, sends `unfocus`. A `focus` from someone else (the story
 * card, source 'word') raises the pill on that layer for 1.5 s.
 *
 * The pointer is read once per frame from the latest pointermove, so a
 * moving mouse costs one raycast a frame; the pill's screen position (a
 * transform, never a layout) is refreshed at 12 fps unless the hovered layer
 * changes, in which case it moves at once.
 *
 * The tap has to win against the page turn: turn.js begins a drag on any
 * pointerdown over the book. This module listens in the capture phase and
 * stops the event when the pointer is on an opaque texel of a standing
 * layer, so a tap on the fox says "the red fox" and turns nothing.
 *
 * Live mode only: in capture mode there is no pointer and the pill stays
 * hidden, since the reel mixes its own captions.
 */

import * as THREE from 'three';
import { resume, load, play, bus } from './audio-core.js';

const ROOT = new URL('../', import.meta.url);
const HOLD_S = 1.5;
const LAYOUT_FPS = 12;
const TAP_PX = 6;
const PILL_GAP = 10;

export const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/* The pill reads "car", "camel", "young falcon": the recipe names keep their
   article for the spoken label and the sentences, the tag drops it. */
export const shortName = (name) => String(name).replace(/^(the|a|an)\s+/i, '');

export function initLabels(api, popup) {
  const live = api.mode === 'live';
  const canvas = api.renderer.domElement;
  const { events } = api;

  if (!document.querySelector('link[data-labels-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('css/labels.css', ROOT).href;
    link.dataset.labelsCss = '1';
    document.head.appendChild(link);
  }
  const pill = document.createElement('div');
  pill.className = 'layer-label';
  pill.setAttribute('aria-hidden', 'true');
  document.body.appendChild(pill);

  let pointer = null;     // latest pointer position in client px
  let dirty = false;      // pointer moved since the last test
  let lastTest = -1;
  let hovered = null;     // layer record under the pointer
  let hold = null;        // {layer, at, name, key, until}: raised by a tap or a word focus
  let focused = null;     // {spread, id}
  let shown = null;       // what the pill shows now
  let lastLayout = -1;
  let down = null;
  let voice = null;
  let cursorOn = false;
  const tmp = new THREE.Vector3();

  function project() {
    tmp.project(api.camera);
    return { x: ((tmp.x + 1) / 2) * api.vw(), y: ((1 - tmp.y) / 2) * api.vh(), behind: tmp.z > 1 };
  }

  /* Screen anchor: the layer's top centre, or a point on the page. */
  function anchorOf(target) {
    if (target.layer) {
      tmp.set(0, target.layer.h, 0);
      target.layer.pivot.localToWorld(tmp);
      return project();
    }
    api.book.pageToWorld(target.at[0], target.at[1], tmp);
    return project();
  }

  function place(target) {
    const a = anchorOf(target);
    if (a.behind) { pill.classList.remove('is-on'); return; }
    pill.style.transform = `translate3d(${a.x.toFixed(1)}px, ${(a.y - PILL_GAP).toFixed(1)}px, 0) translate(-50%, -100%)`;
    pill.classList.add('is-on');
  }

  function hide() {
    if (shown) { shown = null; pill.classList.remove('is-on'); }
  }

  function setCursor(on) {
    if (on === cursorOn) return;
    cursorOn = on;
    canvas.style.cursor = on ? 'pointer' : '';
  }

  function update(t, st) {
    if (!live) { hide(); return; }
    if (hovered && (st.phase === 'hidden' || hovered.spread !== st.spread)) hovered = null;
    if (!pointer) hovered = null;
    else if (dirty || t - lastTest >= 1 / LAYOUT_FPS) {
      dirty = false;
      lastTest = t;
      hovered = st.phase === 'hidden' ? null : popup.hitTest(pointer);
    }
    if (hold && (t >= hold.until || st.phase === 'hidden' || (hold.layer && hold.layer.spread !== st.spread))) hold = null;
    let target = null;
    if (hovered) target = { layer: hovered, name: hovered.name, key: `${hovered.spread}:${hovered.id}` };
    else if (hold) target = hold;
    setCursor(!!hovered);
    if (!target) { hide(); return; }
    if (!shown || shown.key !== target.key) {
      shown = target;
      pill.textContent = shortName(target.name);
      place(target);
      lastLayout = t;
    } else if (t - lastLayout >= 1 / LAYOUT_FPS) {
      place(target);
      lastLayout = t;
    }
  }

  /* ---- sound ----------------------------------------------------------- */

  function say(name) {
    if (!live) return;
    const url = new URL(`assets/audio/labels/${slug(name)}.mp3`, ROOT).href;
    resume()
      .then(() => load(url))
      .then((buf) => {
        if (voice) voice.stop();
        voice = play(buf, { destination: bus('sfx') });
      })
      .catch(() => { /* a missing clip stays silent */ });
  }

  /* ---- tap -------------------------------------------------------------- */

  function tap(L, point) {
    const t = api.time;
    const at = L.foot.slice();
    events.emit('tap', { spread: L.spread, layer: L.id, name: L.name, at });
    say(L.name);
    popup.burst(point, t);
    hold = { layer: L, at: null, name: L.name, key: `${L.spread}:${L.id}`, until: t + HOLD_S };
    if (focused && focused.spread === L.spread && focused.id === L.id) {
      focused = null;
      events.emit('unfocus', {});
    } else {
      focused = { spread: L.spread, id: L.id };
      events.emit('focus', { spread: L.spread, layer: L.id, at, name: L.name, source: 'layer' });
    }
  }

  /* ---- pointer ---------------------------------------------------------- */

  function onMove(e) {
    if (e.pointerType === 'touch') return;
    pointer = { x: e.clientX, y: e.clientY };
    dirty = true;
  }
  function onLeave() { pointer = null; dirty = true; }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const L = popup.hitTest(e);
    if (!L) { down = { id: e.pointerId, x: e.clientX, y: e.clientY, layer: null, point: null }; return; }
    e.stopImmediatePropagation();
    e.preventDefault();
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, layer: L, point: L.hit.clone() };
  }

  function onUp(e) {
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= TAP_PX) return;
    if (d.layer) {
      e.stopImmediatePropagation();
      tap(d.layer, d.point);
    } else if (focused) {
      focused = null;
      events.emit('unfocus', {});
    }
  }

  function onCancel() { down = null; }

  if (live) {
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown, { capture: true });
    canvas.addEventListener('pointerup', onUp, { capture: true });
    canvas.addEventListener('pointercancel', onCancel, { capture: true });
    window.addEventListener('blur', onLeave);
  }

  /* ---- events from the others ------------------------------------------ */

  events.on('focus', (p) => {
    if (!p || p.source === 'layer') return;
    const L = popup.layers(p.spread).find((x) => x.id === p.layer) || null;
    const name = p.name || (L && L.name);
    if (!name) return;
    if (!L && !(Array.isArray(p.at) && p.at.length >= 2)) return;
    hold = { layer: L, at: L ? null : p.at, name, key: `focus:${p.spread}:${p.layer}`, until: api.time + HOLD_S };
    focused = { spread: p.spread, id: p.layer };
  });

  events.on('unfocus', () => {
    focused = null;
    if (hold && hold.key.startsWith('focus:')) hold = null;
  });

  events.on('fold', () => {
    hold = null;
    if (focused) {
      focused = null;
      events.emit('unfocus', {});
    }
  });

  return {
    pill,
    update,
    hide,
    say,
    slug,
    get hovered() { return hovered; },
    get focused() { return focused; },
    get shown() { return shown; },
  };
}
