/* ledger.js — the authored camera: a ledger of poses and a log of flights.
 *
 * Every pose the camera can rest at is a row in a ledger, keyed by spread
 * and kind: `closed` (the shut book, seen from the front-right and a little
 * low, filling about 45% of the frame width), `title` and `home` (the open
 * spread with blanket around it, fitted), `card` (closer to the page half
 * that carries the story card, from card_anchor.page in assets/text) and one
 * row per pop-up layer, computed from the layer's box, foot and tilt in
 * assets/layers/NN/layers.json: the cut-out stands on its foot edge, rotated
 * up by `tilt` (90 is straight up along +Y), and the camera sits in front of
 * it at 2.2 times its height looking at the standing centre, fov 30. Rows are
 * fitted for the current aspect and rebuilt on refit; a portrait ledger
 * (aspect under 0.8) holds the book taller in frame and pans every row so
 * the lower third of the screen stays clear for the story card.
 *
 * Travel is duat's pathAt: a polyline [from, ...via, to] walked by weighted
 * legs, eased within the segment only (t*t*(3-2t)), 1.1 s to a focus and
 * 0.9 s back. A flight to a layer on a hero spread carries one `via` point
 * 0.25 above the midpoint of the home-to-layer trip, so it swoops instead of
 * sliding. Nothing cuts except a `jump`, which is a seek by definition.
 *
 * Why a log rather than state: the reel renders by seeking to arbitrary
 * times, so the pose at time t must be recomputable from t alone. The log
 * holds {kind, t, spread, ...} transitions; evaluating it walks the entries
 * in order, each one starting from wherever the previous one had reached at
 * its start time, so an interrupted flight bends into the next without a
 * jump and a seek backwards lands on the right pose. Entries store states,
 * never coordinates: on refit every row is re-fitted and the same log
 * replays against the new rows, which is what keeps a held focus held
 * across a phone rotation.
 *
 * The three layer-view constants that are judgement rather than spec: a
 * 14 degree elevation above the cut-out's normal (dead level puts the page
 * edge-on and loses the book), an 8 degree yaw toward the home side (a
 * touch of dimension, and a shorter swing from home), and a 0.5 floor on the
 * distance so a 15 cm cut-out does not put the lens inside the paper.
 */

import * as THREE from 'three';
import { PAGE_W, PAGE_H, LEAF_COUNT } from './leaf.js';
import { BOARD_W, BOARD_H, BOARD_T, BLOCK_T } from './book.js';
import {
  BOOK_CORNERS, BOOK_CORNERS_PORTRAIT, LOOK, DIR_LANDSCAPE, DIR_PORTRAIT, FOV_LANDSCAPE, FOV_PORTRAIT,
  PORTRAIT_BELOW, MARGIN, lookBasis, landscapeClears, panClears, clearFitH, clearFitV,
} from './camera.js';

const ASSETS = new URL('../assets/', import.meta.url);
/* Spreads with a layers.json today. Spread 15's cut-outs are not built yet;
   add it here when assets/layers/15/layers.json lands. Listed rather than
   probed so a missing recipe never logs a 404 in the console. */
const RECIPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const TEXTS = 17;

export const FLY_FOCUS = 1.1;
export const FLY_RELEASE = 0.9;
const ARC = 0.25;
const ARC_EVERY_LAYER = false;      // true: every layer flight swoops, hero spread or not

const CLOSED_DIR = new THREE.Vector3(0.55, 0.88, 1.00).normalize();
const CLOSED_DIR_PORTRAIT = new THREE.Vector3(0.30, 1.25, 1.00).normalize();
/* A little in front of the book's centre, so the shut book sits a touch
   high in the frame with blanket in front of it rather than behind. */
const CLOSED_LOOK = new THREE.Vector3(BOARD_W / 2, 0.03, 0.12);
const CLOSED_FILL = 0.45;
const CLOSED_FILL_PORTRAIT = 0.68;
const TITLE_DIR = new THREE.Vector3(0.30, 1.02, 1.00).normalize();
const TITLE_MARGIN = 0.94;
const CARD_MARGIN = 0.84;
const CARD_CLEAR = 0.46;           // portrait: the lower band of the frame belongs to the DOM card
const LAYER_FOV = 30;
const LAYER_FOV_PORTRAIT = 36;
const LAYER_DISTANCE = 3.6;         // times the cut-out's height
const LAYER_MIN_DISTANCE = 1.7;
const LAYER_WIDTH_FIT = 1.12;       // a wide cut-out (the back wall) fits its width too
const LAYER_ELEVATION = THREE.MathUtils.degToRad(22);
const LAYER_CLEAR = 0.12;           // portrait: the card steps aside during a focus, so little needs clearing
const LAYER_PORTRAIT_BACK = 1.35;   // portrait frames are narrow; stand further back from a cut-out
const LAYER_YAW = THREE.MathUtils.degToRad(8);
const POINT_HEIGHT = 0.45;          // framing height for a point on a large layer
const PLATE_DISTANCE = 0.8;         // a point on the flat page
const LOG_MAX = 240;
const SAME = 1e-4;

const REST_KINDS = new Set(['closed', 'title', 'home']);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const pad = (n) => String(n).padStart(2, '0');

/* The shut book: boards, block and spine strip, lying to the right of x = 0. */
const CLOSED_CORNERS = [];
for (const x of [-0.01, BOARD_W]) {
  for (const y of [0, BOARD_T * 2 + BLOCK_T]) {
    for (const z of [-BOARD_H / 2, BOARD_H / 2]) CLOSED_CORNERS.push(new THREE.Vector3(x, y, z));
  }
}

/* ---- paths (duat, reference/duat-index.html:3215) ----------------------- */

function lerpV(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

/* Walk a polyline [from, ...via, to] at 0..1. Even parameter spacing per leg
   rather than by arc length, and legs can be weighted so the one that
   matters takes most of the transition. */
export function pathAt(out, from, via, to, f, w) {
  if (!via || !via.length) { lerpV(out, from, to, f); return; }
  const legs = via.length + 1;
  let acc = 0; let tot = 0;
  for (let k = 0; k < legs; k += 1) tot += (w && w[k]) || 1;
  const target = f * tot;
  for (let seg = 0; seg < legs; seg += 1) {
    const width = (w && w[seg]) || 1;
    if (target <= acc + width || seg === legs - 1) {
      const lf = Math.min(1, Math.max(0, (target - acc) / width));
      const A = seg === 0 ? from : via[seg - 1];
      const B = seg === legs - 1 ? to : via[seg];
      lerpV(out, A, B, lf);
      return;
    }
    acc += width;
  }
}

/* ---- init ----------------------------------------------------------------- */

export function init(api) {
  const camera = api.camera;
  const book = api.book;
  const live = api.mode === 'live';
  const reduced = !!api.reduced;

  const ledger = {
    aspect: camera.aspect || 16 / 9,
    portrait: false,
    rows: { closed: null, title: null, home: null },
    recipes: new Map(),   // spread -> layers.json
    anchors: new Map(),   // spread -> card_anchor
    log: [],
    base: { kind: 'closed', spread: 0 },
  };
  const log = ledger.log;
  const rowCache = new Map();

  const vA = new THREE.Vector3();
  const vCam = new THREE.Vector3();
  const vLook = new THREE.Vector3();
  const vDir = new THREE.Vector3();
  const basis = { fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };

  /* A point on the spread of a given spread number, in world space. The
     book's own pageToWorld reads the resting spread; this mirrors it with the
     spread named, so a row for spread 9 can be built while spread 4 shows. */
  function pageToWorldAt(spread, u, v, out) {
    if (book.spread === spread && !book.active) return book.pageToWorld(u, v, out);
    const x = (u * 2 - 1) * PAGE_W;
    const z = (v - 0.5) * PAGE_H;
    const k = u < 0.5 ? spread - 1 : spread;
    const y = k < 0 ? BOARD_T : book.restY(Math.min(k, LEAF_COUNT - 1), spread);
    out.set(x, y + 0.0004, z);
    return book.group.localToWorld(out);
  }

  /* Pan a pose so its look point sits `clear` of the way up the frame,
     leaving the lower `clear` of the screen empty. */
  /* Every shift a row's pose carries, accumulated while the row is built
     and written into it as [right, up] so the camera's orbit can pivot on
     the book instead of on the shifted frame centre. */
  const panAcc = new THREE.Vector3();
  function panClear(camV, lookV, fov, clear) {
    const d = camV.distanceTo(lookV);
    lookBasis(camV, lookV, basis);
    const shift = d * Math.tan(THREE.MathUtils.degToRad(fov) / 2) * clear;
    camV.addScaledVector(basis.up, -shift);
    lookV.addScaledVector(basis.up, -shift);
    panAcc.addScaledVector(basis.up, -shift);
  }

  function row(fov, extra) {
    lookBasis(vCam, vLook, basis);
    const pan = [panAcc.dot(basis.right), panAcc.dot(basis.up)];
    panAcc.set(0, 0, 0);
    return Object.assign({ cam: vCam.toArray(), look: vLook.toArray(), fov, pan }, extra);
  }

  /* Landscape rest poses also leave the top band (the lamp) and the right
     band (the reading panel) free; camera.js owns those shares. */
  function fitRow(corners, dir, look, fov, marginH, marginV, clear) {
    const lc = landscapeClears(ledger.aspect);
    const d = camera.fitDistance(corners, dir, look, fov, ledger.aspect, marginH * clearFitH(lc), marginV * (1 - clear) * clearFitV(lc));
    vCam.copy(look).addScaledVector(dir, d);
    vLook.copy(look);
    if (clear > 0) panClear(vCam, vLook, fov, clear);
    panClears(vCam, vLook, fov, ledger.aspect, d, lc, panAcc);
    return row(fov, { distance: d });
  }

  /* Distance at which the corners' projected extent is `fill` of the frame
     width. The plain fit bounds the farthest-out corner, and in perspective
     the near corners spread wider than the far ones, so on its own it
     under-fills (37% for 45% asked). The extent scales almost inversely with
     distance, so a few rounds of measure-and-scale converge on it. */
  function fitWidth(corners, dir, look, fov, fill, marginV) {
    const lc = landscapeClears(ledger.aspect);
    const fillH = fill * clearFitH(lc);
    const fitV = marginV * clearFitV(lc);
    let d = camera.fitDistance(corners, dir, look, fov, ledger.aspect, fillH, fitV);
    const tanV = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const tanH = tanV * ledger.aspect;
    for (let i = 0; i < 6; i += 1) {
      vCam.copy(look).addScaledVector(dir, d);
      lookBasis(vCam, look, basis);
      let xMin = Infinity; let xMax = -Infinity; let yMax = 0;
      for (const c of corners) {
        vA.subVectors(c, look);
        const depth = d + vA.dot(basis.fwd);
        const x = vA.dot(basis.right) / (depth * tanH);
        xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
        yMax = Math.max(yMax, Math.abs(vA.dot(basis.up)) / (depth * tanV));
      }
      d *= Math.max((xMax - xMin) / (2 * fillH), yMax / fitV);
    }
    vCam.copy(look).addScaledVector(dir, d);
    vLook.copy(look);
    panClears(vCam, vLook, fov, ledger.aspect, d, lc, panAcc);
    return row(fov, { distance: d });
  }

  function rebuild(aspect) {
    ledger.aspect = aspect;
    ledger.portrait = aspect < PORTRAIT_BELOW;
    const p = ledger.portrait;
    const fov = p ? FOV_PORTRAIT : FOV_LANDSCAPE;
    const clear = p ? CARD_CLEAR : 0;
    ledger.rows.closed = p
      ? fitWidth(CLOSED_CORNERS, CLOSED_DIR_PORTRAIT, CLOSED_LOOK, fov, CLOSED_FILL_PORTRAIT, 0.62)
      : fitWidth(CLOSED_CORNERS, CLOSED_DIR, CLOSED_LOOK, fov, CLOSED_FILL, 0.90);
    ledger.rows.title = fitRow(p ? BOOK_CORNERS_PORTRAIT : BOOK_CORNERS, p ? DIR_PORTRAIT : TITLE_DIR, LOOK, fov, TITLE_MARGIN, TITLE_MARGIN, clear);
    ledger.rows.home = fitRow(p ? BOOK_CORNERS_PORTRAIT : BOOK_CORNERS, p ? DIR_PORTRAIT : DIR_LANDSCAPE, LOOK, fov, MARGIN, MARGIN, clear);
    rowCache.clear();
  }

  function cardRow(spread) {
    const anchor = ledger.anchors.get(spread);
    const page = anchor && anchor.page === 'left' ? 'left' : 'right';
    const x0 = page === 'left' ? -PAGE_W : 0;
    const corners = [];
    for (const x of [x0, x0 + PAGE_W]) for (const y of [0.02, 0.08]) for (const z of [-PAGE_H / 2, PAGE_H / 2]) corners.push(new THREE.Vector3(x, y, z));
    vA.set(x0 + PAGE_W / 2, 0.06, 0);
    const p = ledger.portrait;
    return fitRow(corners, p ? DIR_PORTRAIT : DIR_LANDSCAPE, vA.clone(), p ? FOV_PORTRAIT : FOV_LANDSCAPE, CARD_MARGIN, CARD_MARGIN, p ? CARD_CLEAR : 0);
  }

  /* Viewing direction for a cut-out at `tilt`: its plane normal lifted by
     LAYER_ELEVATION and turned by LAYER_YAW toward +x, the home side. */
  function layerDir(tiltRad, out) {
    const phi = (Math.PI / 2 - tiltRad) + LAYER_ELEVATION;
    return out.set(Math.sin(LAYER_YAW) * Math.cos(phi), Math.sin(phi), Math.cos(LAYER_YAW) * Math.cos(phi));
  }

  function withArc(r, hero) {
    if (!(hero || ARC_EVERY_LAYER) || !ledger.rows.home) return r;
    const h = ledger.rows.home.cam;
    r.via = [[(h[0] + r.cam[0]) / 2, (h[1] + r.cam[1]) / 2 + ARC, (h[2] + r.cam[2]) / 2]];
    r.viaW = [1, 1];
    return r;
  }

  /* The line a layer hinges on: its own foot, or the wall's when the figure
     is printed above the wall's horizon and rides the wall (popup.js puts
     it there, lifted by the page distance between the two lines). */
  function hingeOf(recipe, L) {
    const wall = recipe && recipe.layers ? recipe.layers.find((l) => l.id === 'wall') : null;
    if (!wall || L === wall || L.foot[1] >= wall.foot[1] - 0.01) return { u: L.foot[0], v: L.foot[1], tilt: L.tilt, lift: 0 };
    return { u: L.foot[0], v: wall.foot[1], tilt: wall.tilt, lift: (wall.foot[1] - L.foot[1]) * PAGE_H };
  }

  function layerRow(spread, L, recipe) {
    const [u0, v0, u1, v1] = L.box;
    const w = (u1 - u0) * 2 * PAGE_W;
    const h = (v1 - v0) * PAGE_H;
    const hg = hingeOf(recipe, L);
    const foot = pageToWorldAt(spread, hg.u, hg.v, vA);
    const tilt = THREE.MathUtils.degToRad(hg.tilt);
    const up = hg.lift + h / 2;
    vLook.set(foot.x, foot.y + up * Math.sin(tilt), foot.z - up * Math.cos(tilt));
    layerDir(tilt, vDir);
    const fov = ledger.portrait ? LAYER_FOV_PORTRAIT : LAYER_FOV;
    const tanH = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * ledger.aspect;
    const d = Math.max(LAYER_DISTANCE * h, LAYER_MIN_DISTANCE, (LAYER_WIDTH_FIT * w) / (2 * tanH)) * (ledger.portrait ? LAYER_PORTRAIT_BACK : 1);
    vCam.copy(vLook).addScaledVector(vDir, d);
    if (ledger.portrait) panClear(vCam, vLook, fov, LAYER_CLEAR);
    return withArc(row(fov, { distance: d, size: [w, h] }), recipe.hero);
  }

  /* A point (u, v) on the spread: on a known layer it is stood up with the
     cut-out about its foot edge; on the plate, or an unknown layer, it is a
     point on the flat page seen from the home direction. */
  function pointRow(spread, layerId, at) {
    const recipe = ledger.recipes.get(spread);
    const L = recipe && recipe.layers.find((l) => l.id === layerId);
    const fov = ledger.portrait ? LAYER_FOV_PORTRAIT : LAYER_FOV;
    let d;
    if (L) {
      const h = (L.box[3] - L.box[1]) * PAGE_H;
      const hg = hingeOf(recipe, L);
      const foot = pageToWorldAt(spread, hg.u, hg.v, vA);
      const rise = Math.max(0, hg.v - at[1]) * PAGE_H;
      const tilt = THREE.MathUtils.degToRad(hg.tilt);
      vLook.set(foot.x + (at[0] - hg.u) * 2 * PAGE_W, foot.y + rise * Math.sin(tilt), foot.z - rise * Math.cos(tilt));
      layerDir(tilt, vDir);
      d = Math.max(LAYER_DISTANCE * Math.min(h, POINT_HEIGHT), LAYER_MIN_DISTANCE) * (ledger.portrait ? LAYER_PORTRAIT_BACK : 1);
    } else {
      pageToWorldAt(spread, at[0], at[1], vLook);
      vDir.copy(ledger.portrait ? DIR_PORTRAIT : DIR_LANDSCAPE);
      d = PLATE_DISTANCE;
    }
    vCam.copy(vLook).addScaledVector(vDir, d);
    if (ledger.portrait) panClear(vCam, vLook, fov, LAYER_CLEAR);
    return withArc(row(fov, { distance: d }), !!(recipe && recipe.hero && L));
  }

  /* The resting row for a state {kind, spread, at?}. Unknown layers fall
     back to home so a stray focus can never leave the camera nowhere. */
  function rowFor(state) {
    const { kind, spread } = state;
    if (REST_KINDS.has(kind)) return ledger.rows[kind];
    if (kind === 'card') {
      const key = `card/${spread}`;
      if (!rowCache.has(key)) rowCache.set(key, cardRow(spread));
      return rowCache.get(key);
    }
    const recipe = ledger.recipes.get(spread);
    if (state.at) {
      const key = `at/${spread}/${kind}/${state.at[0]},${state.at[1]}`;
      if (!rowCache.has(key)) {
        const r = pointRow(spread, kind, state.at);
        if (recipe) rowCache.set(key, r);
        return r;
      }
      return rowCache.get(key);
    }
    const key = `layer/${spread}/${kind}`;
    if (rowCache.has(key)) return rowCache.get(key);
    const L = recipe && recipe.layers.find((l) => l.id === kind);
    if (!L) return ledger.rows.home;
    const r = layerRow(spread, L, recipe);
    rowCache.set(key, r);
    return r;
  }

  /* 1 while a focus (a layer, a point, the card) is the target; 0 at rest. */
  const holdOf = (state) => (REST_KINDS.has(state.kind) ? 0 : 1);

  /* ---- evaluation ------------------------------------------------------ */

  const P = { cam: [0, 0, 0], look: [0, 0, 0], fov: FOV_LANDSCAPE, held: 0, pan: [0, 0] };
  const Q = { cam: [0, 0, 0], look: [0, 0, 0], fov: FOV_LANDSCAPE, held: 0, pan: [0, 0] };

  function stateAt(time) {
    let s = ledger.base;
    for (const e of log) {
      if (e.t > time) break;
      s = e;
    }
    return s;
  }

  /* The base pose at `time`: walk the log, each entry starting from where
     the previous one had reached when it began. */
  function evalAt(time, out) {
    let from = P;
    let cur = Q;
    const r0 = rowFor(ledger.base);
    from.cam[0] = r0.cam[0]; from.cam[1] = r0.cam[1]; from.cam[2] = r0.cam[2];
    from.look[0] = r0.look[0]; from.look[1] = r0.look[1]; from.look[2] = r0.look[2];
    from.fov = r0.fov;
    from.held = holdOf(ledger.base);
    from.pan[0] = r0.pan ? r0.pan[0] : 0;
    from.pan[1] = r0.pan ? r0.pan[1] : 0;
    for (let i = 0; i < log.length; i += 1) {
      const e = log[i];
      if (e.t > time) break;
      const target = rowFor(e);
      const next = log[i + 1];
      const until = next && next.t <= time ? next.t : time;
      const f = e.dur > 0 ? ease(clamp01((until - e.t) / e.dur)) : 1;
      pathAt(cur.cam, from.cam, target.via, target.cam, f, target.viaW);
      lerpV(cur.look, from.look, target.look, f);
      cur.fov = from.fov + (target.fov - from.fov) * f;
      cur.held = from.held + (holdOf(e) - from.held) * f;
      const tp0 = target.pan ? target.pan[0] : 0;
      const tp1 = target.pan ? target.pan[1] : 0;
      cur.pan[0] = from.pan[0] + (tp0 - from.pan[0]) * f;
      cur.pan[1] = from.pan[1] + (tp1 - from.pan[1]) * f;
      const swap = from; from = cur; cur = swap;
    }
    out.cam.set(from.cam[0], from.cam[1], from.cam[2]);
    out.look.set(from.look[0], from.look[1], from.look[2]);
    out.fov = from.fov;
    out.held = from.held;
    if (!out.pan) out.pan = [0, 0];
    out.pan[0] = from.pan[0];
    out.pan[1] = from.pan[1];
    return out;
  }

  const probe = { cam: new THREE.Vector3(), look: new THREE.Vector3(), fov: 0, held: 0 };

  function sameState(a, b) {
    if (a.kind !== b.kind || a.spread !== b.spread) return false;
    if (!!a.at !== !!b.at) return false;
    return !a.at || (Math.abs(a.at[0] - b.at[0]) < SAME && Math.abs(a.at[1] - b.at[1]) < SAME);
  }

  /* Live mode only: time never runs backwards, so once an entry has landed
     nothing before it can matter again. Fold the oldest into the base. */
  function prune(now) {
    if (log.length <= LOG_MAX) return;
    let j = -1;
    for (let i = 0; i < log.length; i += 1) if (log[i].t + log[i].dur <= now) j = i;
    if (j < 0) return;
    const e = log[j];
    ledger.base = { kind: e.kind, spread: e.spread, at: e.at };
    log.splice(0, j + 1);
  }

  /* Log a flight to a state. Returns false when the camera is already bound
     there, so a repeated settle or a second tap on the same layer cannot
     restart a flight. A call at a time earlier than the last entry rewrites
     what came after it: a seek followed by a new action is a new history. */
  function go(kind, opts = {}) {
    const t = opts.t !== undefined ? opts.t : api.time;
    const cur = stateAt(t);
    const entry = {
      kind,
      t,
      spread: opts.spread !== undefined ? opts.spread : cur.spread,
      dur: reduced ? 0 : (opts.dur !== undefined ? opts.dur : FLY_FOCUS),
    };
    if (opts.at) entry.at = [Number(opts.at[0]), Number(opts.at[1])];
    if (opts.name) entry.name = opts.name;
    if (!REST_KINDS.has(kind) && kind !== 'card') entry.layer = kind;
    if (sameState(cur, entry)) return false;
    while (log.length && log[log.length - 1].t > t) log.pop();
    log.push(entry);
    if (live) prune(t);
    return true;
  }

  const restKind = (spread) => (spread === 0 ? 'title' : 'home');

  /* ---- the camera API --------------------------------------------------- */

  camera.ledger = ledger;

  camera.poseFor = (spread, kind) => {
    const s = Number.isFinite(spread) ? spread : book.spread;
    if (!REST_KINDS.has(kind) && kind !== 'card') {
      const recipe = ledger.recipes.get(s);
      if (!recipe || !recipe.layers.some((l) => l.id === kind)) return null;
    }
    const r = rowFor({ kind, spread: s });
    if (!r) return null;
    const out = { cam: r.cam.slice(), look: r.look.slice(), fov: r.fov };
    if (r.via) { out.via = r.via.map((v) => v.slice()); out.viaW = r.viaW.slice(); }
    if (r.distance !== undefined) out.distance = r.distance;
    return out;
  };

  camera.focusOn = ({ spread, layer, at, name, t } = {}) => {
    const s = Number.isFinite(spread) ? spread : book.spread;
    if (layer === 'card') return go('card', { spread: s, name, t, dur: FLY_FOCUS });
    const recipe = ledger.recipes.get(s);
    const known = !!(layer && recipe && recipe.layers.some((l) => l.id === layer));
    if (at && at.length === 2) return go(layer || 'plate', { spread: s, at, name, t, dur: FLY_FOCUS });
    if (known) return go(layer, { spread: s, name, t, dur: FLY_FOCUS });
    return false;
  };

  camera.release = ({ t } = {}) => {
    const now = t !== undefined ? t : api.time;
    const cur = stateAt(now);
    if (cur.kind === 'closed') return false;
    return go(restKind(cur.spread), { spread: cur.spread, t: now, dur: FLY_RELEASE });
  };

  camera.stateAt = stateAt;
  camera.evalAt = (time) => evalAt(time, probe);
  camera.flights = { focus: FLY_FOCUS, release: FLY_RELEASE };

  /* Distance between the base pose the camera is at and the row its current
     state rests at: large mid-flight, near zero once landed. */
  camera.poseError = () => {
    const r = rowFor(stateAt(api.time));
    const p = camera.pose;
    const dCam = Math.hypot(p.cam.x - r.cam[0], p.cam.y - r.cam[1], p.cam.z - r.cam[2]);
    const dLook = Math.hypot(p.look.x - r.look[0], p.look.y - r.look[1], p.look.z - r.look[2]);
    return Math.max(dCam, dLook, Math.abs(p.fov - r.fov) / 100);
  };

  camera.driver = { poseAt: (time, pose) => evalAt(time, pose) };
  camera.onRefit = (aspect) => rebuild(aspect);

  /* ---- events ------------------------------------------------------------ */

  api.events.on('focus', (p) => camera.focusOn(p || {}));
  api.events.on('unfocus', () => camera.release());
  api.events.on('cover', ({ open, t } = {}) => {
    go(open ? 'title' : 'closed', { spread: 0, t, dur: open ? FLY_FOCUS : FLY_RELEASE });
  });
  api.events.on('settle', ({ spread } = {}) => {
    const cur = stateAt(api.time);
    if (holdOf(cur) && cur.spread === spread) return;
    go(restKind(spread), { spread, dur: FLY_RELEASE });
  });
  api.events.on('jump', ({ spread } = {}) => {
    go(book.isOpen ? restKind(spread) : 'closed', { spread, dur: 0 });
  });

  /* ---- boot -------------------------------------------------------------- */

  ledger.base = { kind: book.isOpen ? restKind(book.spread) : 'closed', spread: book.spread };
  rebuild(camera.aspect || 16 / 9);

  async function loadJson(rel) {
    const res = await fetch(new URL(rel, ASSETS));
    if (!res.ok) throw new Error(`${rel}: ${res.status}`);
    return res.json();
  }
  camera.ready = Promise.all([
    ...RECIPES.map((n) => loadJson(`layers/${pad(n)}/layers.json`)
      .then((r) => { ledger.recipes.set(n, r); })
      .catch(() => { /* no recipe: focus on that spread falls back to a point or home */ })),
    ...Array.from({ length: TEXTS }, (_, n) => loadJson(`text/${pad(n)}.json`)
      .then((j) => { if (j && j.card_anchor) ledger.anchors.set(n, j.card_anchor); })
      .catch(() => { /* no anchor: the card row uses the right page */ })),
  ]).then(() => { rowCache.clear(); return camera; });

  camera.update(0, api.time);
  return camera;
}
