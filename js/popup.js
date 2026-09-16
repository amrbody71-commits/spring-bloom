/* popup.js — the pop-up layers: paper cut-outs that rise from the page.
 *
 * Every spread with a recipe (assets/layers/NN/layers.json) is a small paper
 * theatre: a back wall, mid layers, characters, a foreground piece. Each
 * layer is one PlaneGeometry sized to its box on the spread (width
 * (u1 - u0) * 2, height (v1 - v0) * 1.27) and textured with its alpha WebP.
 * It hinges at its foot edge, the bottom edge of its box. Flat (rotation 0)
 * it lies inside the box and overlaps the printed art exactly; standing it
 * is rotated about the hinge by `tilt` degrees so its top points up with a
 * slight lean back. Under the standing copies two "plate" quads (the page
 * with the layers inpainted out) cross-fade in, so no character is printed
 * twice while its cut-out stands.
 *
 * The wall hinges at its foot edge as well: the horizon line at the bottom
 * of its box rather than the far edge of the page. A plane hinged at the far
 * edge stands up with the sky at the bottom, facing away from the reader.
 * From the home camera (46 degrees down) a wall standing on the horizon
 * covers its own flat copy on the plate, so it reads as the backdrop at the
 * back of the stage. A wall that spans both pages sits on the lower of the
 * two page halves; the higher half hides its foot by half a centimetre, which
 * is the same step the printed spread itself has at the gutter.
 *
 * Time. Nothing here carries state between frames: the pose at book time t
 * is a function of t and a short record list ({rise | fold | snap, t,
 * spread}). In live mode the list is written by settle, beforeTurn, jump,
 * show() and fold(); in capture mode it is derived from the book's own turn
 * log (a fold in the 0.6 s before each logged turn, a rise when it lands),
 * so a seek to any second lands on the right pose. A fold runs the rise
 * backwards from wherever it was, at the rate that takes a full rise down
 * in 0.6 s, and answers `beforeTurn` with that time.
 *
 * Choreography, in seconds from the settle: plate 0 to 0.2; wall 0.1 to 0.8;
 * order 1 from 0.35 staggered 80 ms; orders 2 and 3 from 0.6; order 4 from
 * 0.9; every rise ends by 1.3. Each rise is a back.out(1.2) overshoot. A blob
 * shadow under each layer fades in with it. Set pieces are keyed on real
 * time since the settle (frozen during a fold) and seeded from api.seed.
 *
 * Draw order. Layers are opaque with alphaTest 0.36 (the DUAT rule): they
 * stay in the opaque queue and depth-sort against each other. Plates, blob
 * shadows, petals and sparkles are transparent and carry renderOrder 1..4 so
 * the renderer's per-object depth sort can never draw a plate over a shadow.
 *
 * Per-frame drive: the module chains itself onto scene.onBeforeRender, which
 * three calls once per renderer.render() before it builds the render list,
 * so no change to app.js is needed for the layers to move; `update(time)` is
 * also public and idempotent for an explicit call from the frame loop.
 */

import * as THREE from 'three';
import { PAGE_W, PAGE_H, LEAF_COUNT } from './leaf.js';
import { restY, BOARD_T } from './book.js';
import { mulberry32 } from './rng.js';
import { initLabels } from './labels.js';
import { createLife } from './life.js';

const ROOT = new URL('../', import.meta.url);

export const RISE_END = 1.3;
export const FOLD_S = 0.6;
const PLATE_S = 0.2;
const STAGGER = 0.08;
const LOAD_WINDOW = 1;          // spreads either side kept loading
const KEEP_WINDOW = 3;          // beyond this, disposed
const PLATE_LIFT = 0.0005;      // plate quad above the page
const SHADOW_LIFT = 0.002;      // blob shadow above the page
const LAYER_LIFT = 0.0028;      // a flat layer above the page (over both)
const SHADOW_OPACITY = 0.35;
const ALPHA_TEST = 0.36;
const BACK_S = 1.2;             // back.out overshoot strength
const HOVER_MIN_P = 0.6;        // a layer is hoverable once mostly up
const SPARKLE_N = 40;
const SPARKLE_LIFE = 0.7;
const PETAL_N = 20;
const PETAL_START = 0.9;
const PETAL_END = 4.0;
const MASK_W = 96;              // picking mask width in texels
const MAX_RECORDS = 32;
const CM = PAGE_W / 22;         // one centimetre in world units

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (k) => k * k * (3 - 2 * k);
const backOut = (k) => { const u = k - 1; return 1 + (BACK_S + 1) * u * u * u + BACK_S * u * u; };
const pad2 = (n) => String(n).padStart(2, '0');
const deg = THREE.MathUtils.degToRad;

/* Height of the top surface of one page half at spread s, matching
   book.pageToWorld without the 0.0004 it adds. */
function pageTop(s, side) {
  const k = side === 'left' ? s - 1 : s;
  if (k < 0) return BOARD_T;
  return restY(Math.min(k, LEAF_COUNT - 1), s);
}

function prepare(texture, maxAniso) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, maxAniso);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/* A low-resolution copy of a cut-out's alpha, so a pointer over the
   transparent part of one box falls through to the layer behind it. */
function alphaMask(image) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  const w = MASK_W;
  const h = Math.max(1, Math.round(w * ih / iw));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i += 1) a[i] = data[i * 4 + 3];
  return { w, h, a };
}

function sparkTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* Rise windows per layer, in seconds from the settle. */
function schedule(layers) {
  const seen = new Map();
  for (const L of layers) {
    const o = Math.max(0, Math.round(L.order || 0));
    const i = seen.get(o) || 0;
    seen.set(o, i + 1);
    let t0; let dur;
    if (o === 0) { t0 = 0.1; dur = 0.7; }
    else if (o === 1) { t0 = 0.35 + STAGGER * i; dur = 0.55; }
    else if (o <= 3) { t0 = 0.6 + STAGGER * i; dur = 0.5; }
    else { t0 = 0.9 + STAGGER * i; dur = 0.4; }
    const t1 = Math.min(RISE_END, t0 + dur);
    L.t0 = Math.min(t0, t1 - 0.15);
    L.t1 = t1;
  }
}

export function init(api) {
  const { scene, renderer, events, book } = api;
  const reduced = !!api.reduced;
  const live = api.mode === 'live';
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const loader = new THREE.TextureLoader();

  const root = new THREE.Group();
  root.name = 'popups';
  book.group.add(root);

  /* ---- shared resources ------------------------------------------------ */

  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  const plateGeo = new THREE.PlaneGeometry(PAGE_W, PAGE_H);
  let shadowTex = null;
  loader.load(new URL('assets/textures/blob-shadow.png', ROOT).href, (t) => {
    shadowTex = t;
    for (const e of entries.values()) {
      for (const L of e.layers) { L.shadow.material.map = t; L.shadow.material.needsUpdate = true; }
    }
  });

  /* ---- spreads: recipes, meshes, textures -------------------------------- */

  const entries = new Map();   // spread -> entry

  function entryFor(n) {
    if (entries.has(n)) return entries.get(n);
    const e = {
      spread: n, status: 'loading', json: null, layers: [], byId: new Map(),
      group: null, plateL: null, plateR: null, disposed: false, pending: 0,
    };
    entries.set(n, e);
    /* Story spreads are 1..15; the title page and the back matter have no
       cut-outs, and asking would only log a 404. */
    if (n < 1 || n > 15) { e.status = 'none'; return e; }
    fetch(new URL(`assets/layers/${pad2(n)}/layers.json`, ROOT).href)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (e.disposed) return;
        if (!json || !Array.isArray(json.layers) || !json.layers.length) { e.status = 'none'; return; }
        build(e, json);
      })
      .catch(() => { if (!e.disposed) e.status = 'none'; });
    return e;
  }

  function loadInto(e, url, onTexture) {
    e.pending += 1;
    loader.load(url, (tex) => {
      e.pending -= 1;
      if (e.disposed) { tex.dispose(); return; }
      prepare(tex, maxAniso);
      renderer.initTexture(tex);
      onTexture(tex);
    }, undefined, () => { e.pending -= 1; });
  }

  function build(e, json) {
    const s = e.spread;
    const group = new THREE.Group();
    group.name = `popup-${pad2(s)}`;
    group.visible = false;
    e.group = group;
    e.json = json;
    const yl = pageTop(s, 'left');
    const yr = pageTop(s, 'right');

    for (const spec of json.layers) {
      if (!Array.isArray(spec.box) || spec.box.length !== 4) continue;
      const [u0, v0, u1, v1] = spec.box;
      const foot = Array.isArray(spec.foot) ? spec.foot : [(u0 + u1) / 2, v1];
      const w = (u1 - u0) * 2 * PAGE_W;
      const h = (v1 - v0) * PAGE_H;
      const mat = new THREE.MeshStandardMaterial({
        roughness: 0.9, metalness: 0,
        alphaTest: ALPHA_TEST, transparent: false, depthWrite: true, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.position.y = h / 2;
      mesh.visible = false;
      mesh.name = `layer-${pad2(s)}-${spec.id}`;
      const pivot = new THREE.Group();
      pivot.name = `pivot-${pad2(s)}-${spec.id}`;
      pivot.add(mesh);
      /* A box across the gutter rests on the lower page half; a box on one
         page rests on that page. */
      const straddles = u0 < 0.5 && u1 > 0.5;
      const pageY = straddles ? Math.min(yl, yr) : (foot[0] < 0.5 ? yl : yr);
      const x = (foot[0] * 2 - 1) * PAGE_W;
      const z = (v1 - 0.5) * PAGE_H;
      pivot.position.set(x, pageY + LAYER_LIFT, z);
      pivot.rotation.x = -Math.PI / 2;

      /* The blob shadow: an ellipse as wide as the layer, pushed a little
         behind and to the right of the foot, where the key light throws it. */
      const depth = Math.min(w * 0.42, 0.26);
      const shadow = new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({
        map: shadowTex, color: 0x000000, transparent: true, depthWrite: false, opacity: 0,
      }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.scale.set(w * 1.05, depth, 1);
      shadow.position.set(x + w * 0.05, pageY + SHADOW_LIFT, z - depth * 0.28);
      shadow.renderOrder = 2;
      shadow.visible = false;
      shadow.name = `shadow-${pad2(s)}-${spec.id}`;

      const L = {
        spread: s, id: spec.id, name: spec.name || spec.id, box: spec.box.slice(), foot: foot.slice(),
        tilt: Number.isFinite(spec.tilt) ? spec.tilt : 88, order: Number.isFinite(spec.order) ? spec.order : 1,
        src: spec.src, w, h, x, z, pageY, mesh, pivot, shadow,
        textured: false, mask: null, p: 0, hit: new THREE.Vector3(), t0: 0, t1: 1,
      };
      L.alphaAt = (uv) => {
        const m = L.mask;
        if (!m) return 1;
        const col = Math.min(m.w - 1, Math.max(0, Math.floor(uv.x * m.w)));
        const row = Math.min(m.h - 1, Math.max(0, Math.floor((1 - uv.y) * m.h)));
        return m.a[row * m.w + col] / 255;
      };
      mesh.userData.layer = L;
      e.layers.push(L);
      e.byId.set(L.id, L);
      group.add(pivot, shadow);

      loadInto(e, new URL(spec.src, ROOT).href, (tex) => {
        L.mask = alphaMask(tex.image);
        mat.map = tex;
        mat.needsUpdate = true;
        L.textured = true;
      });
    }
    /* A figure printed above the wall's horizon (a falcon in the canopy)
       cannot hinge at its own foot: standing there it is behind the wall,
       whose sky hides it. It rides the wall instead: hinged on the wall's
       line, a whisker in front of it, lifted so it stands where it is
       printed; flat, the lift lays it back over its own print. No page
       shadow for a figure whose foot is in the air. */
    const wall = e.byId.get('wall');
    if (wall) {
      const wallZ = wall.pivot.position.z;
      for (const L of e.layers) {
        if (L === wall || L.foot[1] >= wall.foot[1] - 0.01) continue;
        L.rides = true;
        L.lift = (wall.foot[1] - L.foot[1]) * PAGE_H;
        L.tilt = wall.tilt;
        L.z = wallZ + CM * 0.35;
        L.pivot.position.z = L.z;
        L.mesh.position.y = L.h / 2 + L.lift;
        L.shadow.visible = false;
      }
    }
    schedule(e.layers);

    /* The plates: the page halves with the standing layers inpainted out,
       lying just above each page at its own height. Same material family as
       the leaf faces so the cross-fade changes pixels and nothing else. */
    function plate(side, y) {
      const m = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({
        roughness: 0.9, metalness: 0, transparent: true, depthWrite: false, opacity: 0,
      }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(side === 'left' ? -PAGE_W / 2 : PAGE_W / 2, y + PLATE_LIFT, 0);
      m.renderOrder = 1;
      m.visible = false;
      m.name = `plate-${pad2(s)}-${side}`;
      group.add(m);
      loadInto(e, new URL(`assets/spreads/${pad2(s)}-plate-${side}.webp`, ROOT).href, (tex) => {
        m.material.map = tex;
        m.material.needsUpdate = true;
      });
      return m;
    }
    e.plateL = plate('left', yl);
    e.plateR = plate('right', yr);
    root.add(group);
    e.status = 'ready';
  }

  function disposeEntry(e) {
    e.disposed = true;
    entries.delete(e.spread);
    if (!e.group) return;
    root.remove(e.group);
    for (const L of e.layers) {
      if (L.mesh.material.map) L.mesh.material.map.dispose();
      L.mesh.material.dispose();
      L.mesh.geometry.dispose();
      L.shadow.material.dispose();
    }
    for (const m of [e.plateL, e.plateR]) {
      if (!m) continue;
      if (m.material.map) m.material.map.dispose();
      m.material.dispose();
    }
  }

  /* Keep the current spread and one either side loading; drop anything
     more than three away. Never awaited in a render path. */
  let keepAll = false;
  function want(spread) {
    if (spread == null || !Number.isFinite(spread)) return;
    if (keepAll) return;
    for (const e of Array.from(entries.values())) {
      if (Math.abs(e.spread - spread) > KEEP_WINDOW) disposeEntry(e);
    }
    for (const n of [spread, spread + 1, spread - 1]) {
      if (n >= 0 && n < LEAF_COUNT && Math.abs(n - spread) <= LOAD_WINDOW) entryFor(n);
    }
  }

  /* The reel loads every spread's layers and plates before its first frame
     and releases nothing; `idle()` then says when they are all in. */
  function prepareAll() {
    keepAll = true;
    for (let n = 0; n < LEAF_COUNT; n += 1) entryFor(n);
  }

  /* ---- the record list and the state it implies ------------------------- */

  let records = [];      // live mode: settle, beforeTurn, jump, show(), fold()
  let manual = [];       // capture mode: show() and fold() calls, merged in
  let derived = { len: -1, base: -1, list: [] };

  const foldDur = (v0) => (reduced ? 0 : FOLD_S * clamp01(v0 / RISE_END));

  function derivedList() {
    const log = book.log;
    if (derived.len === log.length && derived.base === book.base.spread) return derived.list;
    const list = [{ type: 'snap', t: -Infinity, spread: book.base.spread }];
    let riseT = -Infinity;
    for (const ev of log) {
      if (ev.type !== 'turn') continue;
      const tf = Math.max(ev.t - FOLD_S, riseT);
      const v0 = Number.isFinite(riseT) ? Math.min(RISE_END, Math.max(0, tf - riseT)) : RISE_END;
      list.push({ type: 'fold', t: tf, spread: ev.from, v0, dur: Math.min(foldDur(v0), Math.max(0, ev.t - tf)) });
      riseT = ev.t + (ev.dur || 0);
      list.push({ type: 'rise', t: riseT, spread: ev.to });
    }
    derived = { len: log.length, base: book.base.spread, list };
    return list;
  }

  function recordsAt() {
    if (live) return records;
    const base = derivedList();
    if (!manual.length) return base;
    return base.concat(manual).sort((a, b) => a.t - b.t);
  }

  function push(r) {
    const list = live ? records : manual;
    list.push(r);
    if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
  }

  /* The pose at time t: which spread is up, in which phase, and how far
     along its rise timeline (`virtual`, 0..RISE_END). `since` is real time
     from the settle for set pieces, frozen while folding. */
  function stateAt(t) {
    const list = recordsAt();
    let cur = null;
    let rise = null;
    for (const r of list) {
      if (r.t > t) break;
      cur = r;
      if (r.type !== 'fold') rise = r;
    }
    if (!cur) return { spread: null, phase: 'hidden', virtual: 0, since: 0, fold: 0 };
    if (cur.type === 'snap') {
      return { spread: cur.spread, phase: 'risen', virtual: RISE_END, since: Number.isFinite(cur.t) ? t - cur.t : 1e9, fold: 0 };
    }
    if (cur.type === 'rise') {
      const dt = t - cur.t;
      const v = reduced ? RISE_END : Math.min(RISE_END, dt);
      return { spread: cur.spread, phase: v >= RISE_END ? 'risen' : 'rising', virtual: v, since: dt, fold: 0 };
    }
    const k = cur.dur > 0 ? (t - cur.t) / cur.dur : 1;
    const since = rise && Number.isFinite(rise.t) ? cur.t - rise.t : 1e9;
    if (k >= 1) return { spread: cur.spread, phase: 'hidden', virtual: 0, since, fold: 1 };
    return { spread: cur.spread, phase: 'folding', virtual: cur.v0 * (1 - k), since, fold: k };
  }

  /* ---- hints ---------------------------------------------------------- */

  let data = null;
  fetch(new URL('assets/data/spreads.json', ROOT).href)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      data = j;
      const st = stateAt(api.time);
      if (st.spread != null && st.phase !== 'hidden') hint(st.spread);
    })
    .catch(() => {});

  function hint(spread) {
    if (!data || !data.spreads) return;
    const s = data.spreads[pad2(spread)];
    if (s && typeof s.hint === 'string') events.emit('hint', { text: s.hint });
  }

  /* ---- sparkles: one Points pool, seeded per tap ------------------------- */

  const sparkPos = new Float32Array(SPARKLE_N * 3);
  const sparkVel = new Float32Array(SPARKLE_N * 3);
  const sparkGeo = new THREE.BufferGeometry();
  const sparkAttr = new THREE.BufferAttribute(sparkPos, 3);
  sparkAttr.setUsage(THREE.DynamicDrawUsage);
  sparkGeo.setAttribute('position', sparkAttr);
  const sparkMat = new THREE.PointsMaterial({
    map: sparkTexture(), color: 0xFFE3A0, size: 0.045, sizeAttenuation: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.name = 'sparkles';
  sparks.visible = false;
  sparks.frustumCulled = false;
  sparks.renderOrder = 4;
  root.add(sparks);
  const sparkOrigin = new THREE.Vector3();
  let burst = null;   // { at }

  /* One living moment per spread (life.js), driven from setPieces. */
  const life = createLife({ api, root });

  function burstAt(worldPoint, at = api.time) {
    const seed = ((Math.floor(at * 1000) ^ Math.imul(api.seed || 7, 2654435761)) >>> 0);
    const rnd = mulberry32(seed);
    sparkOrigin.copy(worldPoint);
    root.worldToLocal(sparkOrigin);
    for (let i = 0; i < SPARKLE_N; i += 1) {
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(1 - rnd() * 1.4);        // mostly upward
      const sp = 0.16 + rnd() * 0.3;
      sparkVel[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      sparkVel[i * 3 + 1] = Math.cos(ph) * sp;
      sparkVel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
    }
    burst = { at };
  }

  function updateSparkles(t) {
    if (!burst || t < burst.at || t > burst.at + SPARKLE_LIFE) { sparks.visible = false; return; }
    const age = t - burst.at;
    const g = -0.45;
    for (let i = 0; i < SPARKLE_N; i += 1) {
      sparkPos[i * 3] = sparkOrigin.x + sparkVel[i * 3] * age;
      sparkPos[i * 3 + 1] = sparkOrigin.y + sparkVel[i * 3 + 1] * age + 0.5 * g * age * age;
      sparkPos[i * 3 + 2] = sparkOrigin.z + sparkVel[i * 3 + 2] * age;
    }
    sparkAttr.needsUpdate = true;
    const k = age / SPARKLE_LIFE;
    sparkMat.opacity = 1 - smooth(k);
    sparkMat.size = 0.045 * (1 - 0.5 * k);
    sparks.visible = true;
  }

  /* ---- petals for spread 12 -------------------------------------------- */

  const petalRnd = mulberry32((Math.imul(api.seed || 7, 7919) + 12) >>> 0);
  const petals = [];
  for (let i = 0; i < PETAL_N; i += 1) {
    petals.push({
      u: 0.06 + petalRnd() * 0.88,
      delay: PETAL_START + petalRnd() * 1.1,
      fall: 1.6 + petalRnd() * 0.4,
      amp: 0.02 + petalRnd() * 0.035,
      freq: 1.4 + petalRnd() * 1.2,
      phase: petalRnd() * Math.PI * 2,
      spin1: (petalRnd() - 0.5) * 6,
      spin2: (petalRnd() - 0.5) * 4,
      size: 0.8 + petalRnd() * 0.5,
    });
  }
  const petalMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.024, 0.017),
    new THREE.MeshLambertMaterial({ color: 0xF4A3BF, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
    PETAL_N,
  );
  petalMesh.name = 'petals';
  petalMesh.renderOrder = 3;
  petalMesh.visible = false;
  petalMesh.frustumCulled = false;
  root.add(petalMesh);
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  function updatePetals(e, st) {
    const wall = e.byId.get('wall');
    const s = st.since;
    if (reduced || !wall || !wall.textured || wall.p < 0.99 || s < PETAL_START || s > PETAL_END) {
      petalMesh.visible = false;
      return;
    }
    const base = wall.pageY + 0.004;
    const top = wall.pageY + LAYER_LIFT + wall.h * Math.sin(deg(wall.tilt));
    let any = false;
    for (let i = 0; i < PETAL_N; i += 1) {
      const P = petals[i];
      const a = s - P.delay;
      if (a < 0) {
        scl.set(0, 0, 0); pos.set(0, 0, 0); quat.identity();
      } else {
        any = true;
        const k = clamp01(a / P.fall);
        const y = base + (top - base) * (1 - k);
        const x = wall.x - wall.w / 2 + P.u * wall.w + P.amp * Math.sin(P.freq * a + P.phase);
        const z = wall.z + 0.03 + 0.16 * k;
        pos.set(x, y, z);
        if (k >= 1) euler.set(-Math.PI / 2, 0, P.phase);
        else euler.set(P.spin1 * a, P.spin2 * a, P.phase);
        quat.setFromEuler(euler);
        scl.set(P.size, P.size, P.size);
      }
      m4.compose(pos, quat, scl);
      petalMesh.setMatrixAt(i, m4);
    }
    petalMesh.instanceMatrix.needsUpdate = true;
    const fade = (st.phase === 'folding' ? 1 - st.fold : 1) * clamp01((PETAL_END - s) / 0.4);
    petalMesh.material.opacity = fade;
    petalMesh.visible = any && fade > 0.01;
  }

  /* ---- set pieces ------------------------------------------------------- */

  const CAR_RUN = 0.95;     // world units the car drives in from
  const CAR_TAP_S = 1.4;    // seconds of the tapped run
  const carTaps = [];
  /* Every tap on a layer is remembered by spread and id so the cut-out can
     react (a hop, a flap, the car's run). Times are book seconds. */
  const taps = new Map();
  api.events.on('tap', (p) => {
    if (!p || !Number.isFinite(p.spread) || !p.layer) return;
    const at = Number.isFinite(p.at) ? p.at : api.time;
    taps.set(`${p.spread}:${p.layer}`, at);
    if (p.spread === 1 && p.layer === 'car') carTaps.push(at);
  });
  const PICK_ORDER = { character: 0, bird: 1, bat: 1, car: 2, boat: 2, bubble: 3, plant: 4 };
  /* words in a recipe name that say nothing about who it is */
  const NAME_STOP = new Set(['the', 'and', 'their', 'young', 'red', 'pink', 'party', 'picnic', 'family', 'thought', 'river', 'cave', 'flower']);
  const lastPick = new Map();   // spread -> id of the layer the last box woke
  api.events.on('jump', () => { carTaps.length = 0; taps.clear(); lastPick.clear(); });

  /* A new text box wakes the character it is about: the layer named in the
     box, or the next layer along when none is. It hops, with sparkles, so
     the page answers every step of the reading. */
  const boxTmp = new THREE.Vector3();
  api.events.on('box', (p) => {
    if (!p || !Number.isFinite(p.spread)) return;
    const e = entries.get(p.spread);
    const cast = e ? e.layers.filter((l) => kindOf(l) !== 'wall') : [];
    if (!cast.length) return;
    const text = ` ${String(p.text || '').toLowerCase()} `;
    /* Everyone the box names, people before birds before scenery; and never
       the same figure twice running, so each step wakes someone new. */
    const named = cast.filter((l) => String(l.name || '').toLowerCase().split(/[^a-z]+/)
      .some((w) => w.length >= 3 && !NAME_STOP.has(w) && text.includes(` ${w.replace(/s$/, '')}`)))
      .sort((a, b) => (PICK_ORDER[kindOf(a)] ?? 9) - (PICK_ORDER[kindOf(b)] ?? 9));
    const prev = lastPick.get(p.spread);
    let L = named.find((l) => l.id !== prev);
    if (!L) { const i = cast.findIndex((l) => l.id === prev); L = cast[(i + 1) % cast.length]; }
    lastPick.set(p.spread, L.id);
    const at = Number.isFinite(p.at) ? p.at : api.time;
    taps.set(`${p.spread}:${L.id}`, at);
    L.mesh.getWorldPosition(boxTmp);
    burstAt(boxTmp, at);
  });

  /* ---- idle life ------------------------------------------------------- */

  /* A seeded phase per layer so no two cut-outs move in step. */
  function phaseOf(L) {
    if (L.phase == null) {
      let h = 2166136261;
      for (const ch of `${L.spread}:${L.id}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
      L.phase = (h % 1000) / 1000 * Math.PI * 2;
    }
    return L.phase;
  }
  const KIND = [
    ['bat', /bats?$/],
    ['bird', /falcon|flamingo|birds/],
    ['boat', /^boat$/],
    ['car', /^car$/],
    ['bubble', /bubble/],
    ['wall', /^wall$/],
    ['plant', /reeds|plants|tree|mangroves/],
  ];
  function kindOf(L) {
    if (L.kind == null) {
      L.kind = 'character';
      for (const [k, re] of KIND) if (re.test(L.id)) { L.kind = k; break; }
    }
    return L.kind;
  }
  const TAP_S = 0.7;

  /* Small, continuous, seeded: a page that breathes rather than a page that
     merely stood up. Runs only once a layer has finished rising. */
  function breathe(L, s, e) {
    if (L.p < 1) return;
    const ph = phaseOf(L);
    const kind = kindOf(L);
    const m = L.mesh;
    const pv = L.pivot;
    switch (kind) {
      case 'character':
        pv.position.y += 0.0025 * Math.sin(2 * Math.PI * 0.9 * s + ph);
        m.rotation.z += deg(0.8) * Math.sin(2 * Math.PI * 0.45 * s + ph);
        { /* an occasional little hop */
          const period = 4.2 + (ph / (Math.PI * 2)) * 2.5;
          const k = ((s + ph) % period) / 0.32;
          if (k >= 0 && k < 1) pv.position.y += 0.022 * Math.sin(Math.PI * k);
        }
        break;
      case 'bird':
        pv.position.y += 0.006 * Math.sin(2 * Math.PI * 1.1 * s + ph);
        m.rotation.z += deg(2) * Math.sin(2 * Math.PI * 0.9 * s + ph);
        break;
      case 'bat':
        m.rotation.z += deg(4) * Math.sin(2 * Math.PI * 0.25 * s + ph);
        break;
      case 'boat':
        m.rotation.z += deg(2.2) * Math.sin(2 * Math.PI * 0.38 * s + ph);
        pv.position.y += 0.004 * Math.sin(2 * Math.PI * 0.38 * s + ph + 1.2);
        break;
      case 'bubble':
        pv.position.y += 0.008 * Math.sin(2 * Math.PI * 0.5 * s + ph);
        break;
      case 'plant':
        m.rotation.z += deg(1.3) * Math.sin(2 * Math.PI * 0.32 * s + ph);
        break;
      case 'wall':
        m.rotation.z += deg(0.25) * Math.sin(2 * Math.PI * 0.2 * s + ph);
        break;
      default:
        break;
    }
    /* the tap reaction: a hop and a squash, a flap for a bird; the backdrop
       wall only sways */
    if (kind === 'wall') return;
    const tapAt = taps.get(`${e.spread}:${L.id}`);
    let pulse = 0;
    if (tapAt != null) {
      const a = api.time - tapAt;
      if (a >= 0 && a < TAP_S) {
        const k = a / TAP_S;
        const env = 1 - k;
        if (kind === 'plant') {
          m.rotation.z += deg(3) * Math.sin(3 * Math.PI * k) * env;        // a rustle
        } else if (kind === 'boat') {
          m.rotation.z += deg(4) * Math.sin(2 * Math.PI * k) * env;        // a rock
        } else {
          pulse = 0.08 * Math.sin(Math.PI * k);
          pv.position.y += 0.045 * Math.sin(Math.PI * k);
          if (kind === 'bird' || kind === 'bat') m.rotation.z += deg(9) * Math.sin(4 * Math.PI * k) * env;
          else m.rotation.z += deg(3) * Math.sin(2 * Math.PI * k) * env;
        }
      }
    }
    const sc = 1 + pulse;
    if (m.scale.x !== sc) m.scale.set(sc, 1 + pulse * 0.6, 1);
  }

  function setPieces(e, st) {
    if (reduced) { petalMesh.visible = false; return; }
    const s = st.since;
    for (const L of e.layers) breathe(L, s, e);
    life.update(e, st);
    switch (e.spread) {
      case 1: {
        /* The car drives in from the left once the spread is up, settles
           with a bounce, idles with a soft bob, and does a little forward
           run when tapped. */
        const L = e.byId.get('car');
        if (L) {
          if (L.baseX == null) L.baseX = L.pivot.position.x;
          const d = clamp01((s - 0.9) / 1.9);
          const arrive = 1 - Math.pow(1 - d, 3);
          let x = -CAR_RUN * (1 - arrive);
          if (d >= 1) {
            const a = s - 2.8;
            x += 0.012 * Math.sin(a * 9) * Math.exp(-a * 3);          // the settle bounce
            L.pivot.position.y += 0.0035 * Math.sin(s * 2 * Math.PI * 1.3); // idle
            L.mesh.rotation.z = deg(1.1) * Math.sin(s * 2 * Math.PI * 1.3);
          } else {
            L.pivot.position.y += 0.004 * Math.abs(Math.sin(s * 2 * Math.PI * 4)); // wheels on rough sand
          }
          const tapAt = carTaps.length ? carTaps[carTaps.length - 1] : -Infinity;
          const a = api.time - tapAt;
          if (a >= 0 && a < CAR_TAP_S) {
            const k = a / CAR_TAP_S;
            x += 0.32 * Math.sin(Math.PI * k);                           // out and back
            L.pivot.position.y += 0.02 * Math.abs(Math.sin(Math.PI * k * 3));
          }
          L.pivot.position.x = L.baseX + x;
        }
        break;
      }
      case 4: {
        /* The fox rocks 4 degrees toward its tail at 2.0 s and settles. */
        const L = e.byId.get('fox');
        const a = s - 2.0;
        if (L && a > 0 && a < 1.2) L.mesh.rotation.z = deg(4) * Math.sin((2 * Math.PI * a) / 0.45) * Math.exp(-a * 4.5);
        break;
      }
      case 6: {
        /* A flamingo dips 3 degrees forward at 1.8 s. */
        const L = e.byId.get('flamingos');
        const a = s - 1.8;
        if (L && a > 0 && a < 0.6) L.pivot.rotation.x += deg(3) * Math.sin((Math.PI * a) / 0.6);
        break;
      }
      case 12:
        updatePetals(e, st);
        return;
      default:
        break;
    }
    petalMesh.visible = false;
  }

  /* ---- the frame ------------------------------------------------------- */

  let shownSpread = null;
  let plateOverride = null;
  let lastState = stateAt(0);

  function update(t = api.time) {
    const st = stateAt(t);
    lastState = st;
    if (st.spread !== shownSpread) {
      shownSpread = st.spread;
      if (st.spread != null) want(st.spread);
    }
    for (const e of entries.values()) {
      if (e.group) e.group.visible = e.spread === st.spread && st.phase !== 'hidden' && e.status === 'ready';
    }
    const e = st.spread != null ? entries.get(st.spread) : null;
    const on = !!e && e.status === 'ready' && st.phase !== 'hidden';
    if (on) {
      const v = st.virtual;
      let plateK = smooth(clamp01(v / PLATE_S));
      if (plateOverride && plateOverride.spread === e.spread) plateK = plateOverride.on ? 1 : 0;
      for (const m of [e.plateL, e.plateR]) {
        m.material.opacity = plateK;
        m.visible = plateK > 0.002 && !!m.material.map;
      }
      for (const L of e.layers) {
        const k = clamp01((v - L.t0) / (L.t1 - L.t0));
        const p = k >= 1 ? 1 : backOut(k);
        L.p = p;
        L.pivot.rotation.x = deg(-90 + p * L.tilt);
        L.pivot.position.y = L.pageY + LAYER_LIFT;
        L.mesh.rotation.z = 0;
        L.mesh.visible = L.textured;
        const so = SHADOW_OPACITY * clamp01(p);
        L.shadow.material.opacity = so;
        L.shadow.visible = !L.rides && L.textured && !!L.shadow.material.map && so > 0.004;
      }
      setPieces(e, st);
    } else {
      petalMesh.visible = false;
    }
    updateSparkles(t);
    root.updateMatrixWorld(true);
    labels.update(t, st);
    return st;
  }

  /* ---- picking ---------------------------------------------------------- */

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const candidates = [];

  function hitTest(pointer) {
    if (!pointer) return null;
    const st = lastState;
    if (!st || st.phase === 'hidden' || st.spread == null) return null;
    const e = entries.get(st.spread);
    if (!e || e.status !== 'ready') return null;
    const px = pointer.clientX ?? pointer.x;
    const py = pointer.clientY ?? pointer.y;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    ndc.set((px / api.vw()) * 2 - 1, -((py / api.vh()) * 2 - 1));
    ray.setFromCamera(ndc, api.camera);
    candidates.length = 0;
    for (const L of e.layers) if (L.textured && L.mesh.visible && L.p >= HOVER_MIN_P) candidates.push(L.mesh);
    if (!candidates.length) return null;
    const hits = ray.intersectObjects(candidates, false);
    for (const h of hits) {
      const L = h.object.userData.layer;
      if (!h.uv || L.alphaAt(h.uv) < ALPHA_TEST) continue;
      L.hit.copy(h.point);
      return L;
    }
    return null;
  }

  /* ---- the public object ------------------------------------------------ */

  function show(spread, at = api.time) {
    if (!Number.isFinite(spread)) return 0;
    push({ type: 'rise', t: at, spread });
    want(spread);
    events.emit('rise', { spread });
    return reduced ? 0 : RISE_END;
  }

  function fold(spread, at = api.time) {
    const st = stateAt(at);
    if (st.spread !== spread || (st.phase !== 'rising' && st.phase !== 'risen')) return 0;
    const e = entries.get(spread);
    const anything = !!e && e.status === 'ready' && e.layers.some((L) => L.textured);
    const v0 = st.virtual;
    const dur = anything ? foldDur(v0) : 0;
    push({ type: 'fold', t: at, spread, v0, dur });
    events.emit('fold', { spread });
    return dur;
  }

  function layers(spread) {
    const e = entries.get(spread);
    return e && e.status === 'ready' ? e.layers.slice() : [];
  }

  function settled(e) {
    return e.status !== 'loading' && e.pending === 0;
  }

  /* Resolves once a spread's recipe and every texture it names are in. For
     probes and the reel; never awaited in a render path. */
  function ready(spread) {
    const e = entryFor(spread);
    return new Promise((resolve) => {
      const check = () => { if (e.disposed || settled(e)) resolve(e.status === 'ready'); else setTimeout(check, 30); };
      check();
    });
  }

  function idle() {
    return new Promise((resolve) => {
      const check = () => {
        let busy = false;
        for (const e of entries.values()) if (!settled(e)) busy = true;
        if (busy) setTimeout(check, 30); else resolve();
      };
      check();
    });
  }

  const popup = {
    root,
    RISE_END,
    FOLD_S,
    show,
    fold,
    layers,
    hitTest,
    stateAt,
    update,
    ready,
    idle,
    burst: burstAt,
    want,
    prepareAll,
    setPlateVisible(spread, on) {
      plateOverride = on == null ? null : { spread, on: !!on };
    },
    get state() { return lastState; },
    get shown() { return lastState && lastState.phase !== 'hidden' ? lastState.spread : null; },
    entry(spread) { return entries.get(spread) || null; },
    labels: null,
    life,
  };

  const labels = initLabels(api, popup);
  popup.labels = labels;

  /* ---- events ----------------------------------------------------------- */

  events.on('jump', (p) => {
    const spread = p && Number.isFinite(p.spread) ? p.spread : book.base.spread;
    records.length = 0;
    manual.length = 0;
    if (live) records.push({ type: 'snap', t: -Infinity, spread });
    want(spread);
    hint(spread);
  });

  events.on('settle', (p) => {
    if (!p || !Number.isFinite(p.spread)) return;
    show(p.spread);
    hint(p.spread);
  });

  events.on('beforeTurn', (p) => {
    if (!p || !Number.isFinite(p.from)) return 0;
    const secs = fold(p.from);
    if (Number.isFinite(p.to)) entryFor(p.to);
    return secs;
  });

  /* Drive from the renderer: three calls scene.onBeforeRender once per
     render() before the render list is built, so poses set here are what
     this frame draws. Chained, so a sibling that hooks the same slot keeps
     working. update() is idempotent if app.js also calls it. */
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function onBeforeRender(...args) {
    if (typeof prev === 'function') prev.apply(this, args);
    update(api.time);
  };

  /* First state: whatever the book is already showing. */
  const s0 = book.spread;
  if (book.isOpen && Number.isFinite(s0)) {
    if (live) records.push({ type: 'snap', t: -Infinity, spread: s0 });
    want(s0);
  }

  return popup;
}
