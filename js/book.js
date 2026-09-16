/* book.js — the hardback: boards, spine, page blocks, seventeen leaves and
 * the two baked shadows. Owns the book's event log and the cover animation.
 *
 * Frame: the blanket is XZ, Y is up, the spine runs along Z with the book's
 * top edge at -Z. The group origin is the spine centre on the blanket. One
 * page is 1.0 x 1.27 world units (22 x 28 cm).
 *
 * The stack model, and why it is not "17 planes 0.0015 apart":
 *   Seventeen leaves at paper spacing are 0.025 thick, and a stack of planes
 *   has no sides, so the fore-edge would read as a venetian blind. Instead
 *   each side has a solid page block (0.045 thick when every leaf is on it,
 *   scaled by the number of leaves it holds, painted with fine page-edge
 *   lines) and the leaves rest on top of it: the top leaf 0.002 above the
 *   block, each one below it 0.0015 lower. Only the top three are visible;
 *   the rest sit inside the block and are hidden, which also keeps the draw
 *   count low. During a turn every height lerps between its value at the
 *   `from` spread and at the `to` spread, so nothing pops when the block
 *   gains or loses a leaf.
 *
 * Leaf k: front face (recto) is k-right, back face (verso) is (k+1)-left,
 * cream for k = 16. Spread s means leaves 0..s-1 lie on the left. The inside
 * of the front board carries 00-left, the copyright page.
 *
 * The cover opens by rotating the front board PI about the spine while its
 * pivot drops from the top of the block to the blanket; the spine strip
 * swings from vertical to flat at the same time. Both are functions of
 * `time` through the log, so a seek lands on the right pose.
 */

import * as THREE from 'three';
import { createLeaf, PAGE_W, PAGE_H, LEAF_COUNT, CREAM } from './leaf.js';
import { spreadKey } from './textures.js';

export const BOARD_W = 1.03;
export const BOARD_H = 1.31;
export const BOARD_T = 0.012;
export const BLOCK_T = 0.045;
export const LEAF_H = BLOCK_T / LEAF_COUNT;   // block thickness per leaf
export const GAP = 0.0015;                    // spacing of the visible top leaves
export const LIFT = 0.002;                    // top leaf above its block
export const COVER_S = 0.9;
const SPINE_W = BOARD_T * 2 + BLOCK_T;        // 0.069, the closed book's height
const SPINE_T = 0.008;
const BLOCK_W = PAGE_W - 0.004;               // a hair inside the leaves: no coplanar edges
const BLOCK_D = PAGE_H - 0.006;
const NAVY = 0x1F2A5C;
const SKIN = 0.0002;                          // art planes float this far off their box

export const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k));
export const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (a, b, v) => { const k = clamp01((v - a) / (b - a)); return k * k * (3 - 2 * k); };

/* Resting height of leaf k when the book is open at spread s. */
export function restY(k, s) {
  if (k >= s) return BOARD_T + (LEAF_COUNT - s) * LEAF_H + LIFT - (k - s) * GAP;
  return BOARD_T + s * LEAF_H + LIFT - (s - 1 - k) * GAP;
}
export const sideOf = (k, s) => (k >= s ? 'right' : 'left');
export const depthOf = (k, s) => (k >= s ? k - s : s - 1 - k);

/* ---- canvas textures ---------------------------------------------------- */

function pageEdgeTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#F1E8D4';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < LEAF_COUNT; i += 1) {
    const y = (i + 0.5) * (256 / LEAF_COUNT);
    ctx.fillStyle = 'rgba(118, 94, 58, 0.17)';
    ctx.fillRect(0, y - 0.5, 256, 1);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fillRect(0, y + 1.2, 256, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/* A white blob with a soft alpha edge; the material's colour tints it. */
function blobTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

/* A horizontal band, strongest down the middle, fading at every edge. */
function bandTexture() {
  const w = 256; const h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y += 1) {
    const v = y / (h - 1);
    const vert = smooth(0, 0.14, v) * smooth(1, 0.86, v);
    for (let x = 0; x < w; x += 1) {
      const u = (x / (w - 1)) * 2 - 1;
      const a = Math.pow(Math.max(0, 1 - u * u), 1.6) * vert;
      const o = (y * w + x) * 4;
      img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

function shadowMaterial(map, opacity) {
  return new THREE.MeshBasicMaterial({
    map,
    color: 0x2A1A0E,
    transparent: true,
    depthWrite: false,
    opacity,
  });
}

/* Rotate a plane's UVs by 180 degrees. Used for faces seen from below after
   the board they sit on has been flipped over. */
function flipUV(geometry) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, 1 - uv.getX(i), 1 - uv.getY(i));
  uv.needsUpdate = true;
}

function artPlane(w, h, facing, flip = false) {
  const geo = new THREE.PlaneGeometry(w, h);
  if (flip) flipUV(geo);
  const mat = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.86, metalness: 0 });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = facing === 'up' ? -Math.PI / 2 : Math.PI / 2;
  return m;
}

function setMap(material, texture) {
  const had = !!material.map;
  material.map = texture || null;
  material.color.set(texture ? 0xFFFFFF : CREAM);
  if (had !== !!texture) material.needsUpdate = true;
}

/* ---- the book ------------------------------------------------------------ */

export function createBook({ pool, clock, events, reduced = false }) {
  const group = new THREE.Group();
  group.name = 'book';

  const cloth = new THREE.MeshStandardMaterial({ color: NAVY, roughness: 0.93, metalness: 0 });

  /* Back board: static, lying on the blanket to the right of the spine. */
  const backBoard = new THREE.Group();
  const backBox = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, BOARD_T, BOARD_H), cloth);
  backBox.position.set(BOARD_W / 2, BOARD_T / 2, 0);
  const backArt = artPlane(BOARD_W, BOARD_H, 'down', true);
  backArt.position.set(BOARD_W / 2, -SKIN, 0);
  const backEndpaper = artPlane(BOARD_W, BOARD_H, 'up');
  backEndpaper.position.set(BOARD_W / 2, BOARD_T + SKIN, 0);
  backBoard.add(backBox, backArt, backEndpaper);

  /* Front board: hinged at the spine. Closed it lies on top of the block;
     open it lies on the blanket to the left. */
  const frontBoard = new THREE.Group();
  const frontBox = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, BOARD_T, BOARD_H), cloth);
  frontBox.position.set(BOARD_W / 2, BOARD_T / 2, 0);
  const frontArt = artPlane(BOARD_W, BOARD_H, 'up');
  frontArt.position.set(BOARD_W / 2, BOARD_T + SKIN, 0);
  const frontInner = artPlane(BOARD_W, BOARD_H, 'down', true);
  frontInner.position.set(BOARD_W / 2, -SKIN, 0);
  frontBoard.add(frontBox, frontArt, frontInner);

  /* Spine strip: vertical against the closed block, flat under the boards
     when open (where it cannot be seen, and does not need to be). */
  const spine = new THREE.Group();
  const spineBox = new THREE.Mesh(new THREE.BoxGeometry(SPINE_W, SPINE_T, BOARD_H), cloth);
  const spineArt = artPlane(SPINE_W, BOARD_H, 'up');
  spineArt.position.y = SPINE_T / 2 + SKIN;
  spine.add(spineBox, spineArt);
  const SPINE_CLOSED = { x: -SPINE_T / 2, y: SPINE_W / 2, rot: Math.PI / 2 };
  const SPINE_OPEN = { x: 0, y: SPINE_T / 2 - 0.003, rot: 0 };

  /* Page blocks, one per side, scaled in Y to the leaves they hold. */
  const edgeTex = pageEdgeTexture();
  function makeBlock(sign) {
    const tex = edgeTex.clone();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(BLOCK_W, 1, BLOCK_D), mat);
    m.position.x = sign * BLOCK_W / 2;
    m.userData.tex = tex;
    return m;
  }
  const rightBlock = makeBlock(1);
  const leftBlock = makeBlock(-1);
  function setBlock(block, h) {
    block.visible = h > 1e-4;
    block.scale.y = Math.max(h, 1e-4);
    block.position.y = BOARD_T + h / 2;
    block.userData.tex.repeat.y = h / BLOCK_T;
  }

  /* Contact shadow on the blanket, stretched as the cover opens. */
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMaterial(blobTexture(), 0.55));
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.0006;
  const CONTACT_CLOSED = { x: 0.55, z: -0.03, sx: 1.6, sz: 1.9 };
  const CONTACT_OPEN = { x: 0.03, z: -0.03, sx: 3.0, sz: 1.9 };

  /* The moving shadow the turning leaf drops on the page below: one band per
     side, each lying on its own stack (the two stacks differ in height by up
     to the whole block, so a single plane would sink into one of them).
     Each plane covers exactly its half of the spread and the band slides
     across it through the texture offset; clamp-to-edge sampling of a band
     whose edge columns are transparent clips it at the gutter for free. */
  const bandTex = bandTexture();
  const BAND_W = PAGE_W + 0.15;
  function makeBand(sign) {
    const tex = bandTex.clone();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMaterial(tex, 0.5));
    m.rotation.x = -Math.PI / 2;
    m.scale.set(BAND_W, PAGE_H + 0.16, 1);
    m.position.x = sign * BAND_W / 2;
    m.visible = false;
    m.userData.tex = tex;
    m.userData.x0 = sign > 0 ? 0 : -BAND_W;
    return m;
  }
  const bandR = makeBand(1);
  const bandL = makeBand(-1);
  function placeBands(cx, width, opacity, rightTop, leftTop) {
    for (const [band, top] of [[bandR, rightTop], [bandL, leftTop]]) {
      band.visible = opacity > 0.01;
      band.material.opacity = opacity;
      band.position.y = top + 0.0008;
      band.userData.tex.repeat.x = BAND_W / width;
      band.userData.tex.offset.x = (band.userData.x0 - cx) / width + 0.5;
    }
  }

  /* Leaves. */
  const leaves = [];
  for (let k = 0; k < LEAF_COUNT; k += 1) {
    const leaf = createLeaf(k);
    leaves.push(leaf);
    group.add(leaf.pivot);
    pool.subscribe(spreadKey(k, 'right'), (t) => leaf.setFront(t));
    if (k < LEAF_COUNT - 1) pool.subscribe(spreadKey(k + 1, 'left'), (t) => leaf.setBack(t));
  }
  pool.subscribe(spreadKey(0, 'left'), (t) => setMap(frontInner.material, t));

  group.add(backBoard, frontBoard, spine, rightBlock, leftBlock, contact, bandR, bandL);

  /* Cover art: loaded once, never disposed. */
  const covers = Promise.all([
    pool.load('textures/cover-front.webp').then((t) => setMap(frontArt.material, t)),
    pool.load('textures/cover-back.webp').then((t) => setMap(backArt.material, t)),
    pool.load('textures/cover-spine.webp').then((t) => setMap(spineArt.material, t)),
  ]);

  /* ---- state ---------------------------------------------------------- */

  const base = { spread: 0, cover: 0 };
  const log = [];
  let lastView = { spread: 0, active: null };
  const coverDur = () => (reduced ? 0 : COVER_S);

  function coverTarget() {
    for (let i = log.length - 1; i >= 0; i -= 1) {
      if (log[i].type === 'open') return 1;
      if (log[i].type === 'close') return 0;
    }
    return base.cover;
  }

  function coverAt(time) {
    let c = base.cover;
    for (const ev of log) {
      if (ev.type !== 'open' && ev.type !== 'close') continue;
      const target = ev.type === 'open' ? 1 : 0;
      const k = ev.dur > 0 ? clamp01((time - ev.t) / ev.dur) : (time >= ev.t ? 1 : 0);
      c = lerp(c, target, easeInOut(k));
    }
    return c;
  }

  /* Capture mode: derive spread and the in-flight turn from the log. */
  function resolve(time) {
    let spread = base.spread;
    let active = null;
    for (const ev of log) {
      if (ev.type !== 'turn') continue;
      if (time < ev.t) break;
      const k = ev.dur > 0 ? (time - ev.t) / ev.dur : 1;
      if (k >= 1) { spread = ev.to; continue; }
      active = {
        leaf: ev.to > ev.from ? ev.from : ev.to,
        from: ev.from,
        to: ev.to,
        t: easeInOut(k),
        twist: 0,
      };
      break;
    }
    return { spread, active };
  }

  function poseCover(c) {
    frontBoard.rotation.z = Math.PI * c;
    frontBoard.position.y = lerp(BOARD_T + BLOCK_T, BOARD_T, c);
    spine.rotation.z = lerp(SPINE_CLOSED.rot, SPINE_OPEN.rot, c);
    spine.position.set(lerp(SPINE_CLOSED.x, SPINE_OPEN.x, c), lerp(SPINE_CLOSED.y, SPINE_OPEN.y, c), 0);
    contact.position.x = lerp(CONTACT_CLOSED.x, CONTACT_OPEN.x, c);
    contact.position.z = lerp(CONTACT_CLOSED.z, CONTACT_OPEN.z, c);
    contact.scale.set(lerp(CONTACT_CLOSED.sx, CONTACT_OPEN.sx, c), lerp(CONTACT_CLOSED.sz, CONTACT_OPEN.sz, c), 1);
  }

  /* Height of the top surface on one side, ignoring the turning leaf. */
  function stackTop(side, spread, to, p, turningLeaf) {
    let top = BOARD_T + SKIN;
    for (let k = 0; k < LEAF_COUNT; k += 1) {
      if (k === turningLeaf || sideOf(k, spread) !== side) continue;
      top = Math.max(top, lerp(restY(k, spread), restY(k, to), p));
    }
    return top;
  }

  /* Apply a view {spread, active} at a time. `active` is
     {leaf, from, to, t, twist} with t the progress toward `to`. */
  function apply(view, time) {
    const { spread, active } = view;
    poseCover(coverAt(time));

    const to = active ? active.to : spread;
    const p = active ? clamp01(active.t) : 0;
    setBlock(rightBlock, lerp((LEAF_COUNT - spread) * LEAF_H, (LEAF_COUNT - to) * LEAF_H, p));
    setBlock(leftBlock, lerp(spread * LEAF_H, to * LEAF_H, p));

    for (let k = 0; k < LEAF_COUNT; k += 1) {
      const leaf = leaves[k];
      const y = lerp(restY(k, spread), restY(k, to), p);
      if (active && k === active.leaf) {
        const dir = active.to > active.from ? 1 : -1;
        leaf.setTurn(dir > 0 ? p : 1 - p, dir, active.twist || 0, y);
        leaf.pivot.visible = true;
      } else {
        leaf.rest(sideOf(k, spread), y);
        leaf.pivot.visible = depthOf(k, spread) <= 2 || depthOf(k, to) <= 2;
      }
    }

    if (active) {
      const dir = active.to > active.from ? 1 : -1;
      const a = dir > 0 ? p : 1 - p;
      const s = Math.sin(Math.PI * a);
      const c = Math.cos(Math.PI * a);
      /* Under the sheet's footprint, pushed a little to +x, away from the
         key light, and widest when the sheet lies flattest. */
      placeBands(
        c * 0.5 * PAGE_W + 0.10 * s,
        Math.max(0.3, Math.abs(c)) * PAGE_W + 0.4,
        0.5 * Math.pow(s, 0.8),
        stackTop('right', spread, to, p, active.leaf),
        stackTop('left', spread, to, p, active.leaf),
      );
    } else {
      bandR.visible = false;
      bandL.visible = false;
    }
    lastView = view;
  }

  const book = {
    group,
    leaves,
    log,
    base,
    events,
    covers,
    ready: Promise.all([covers, pool.ready([spreadKey(0, 'right'), spreadKey(0, 'left')])]),

    get spread() { return lastView.spread; },
    get active() { return lastView.active; },
    get isOpen() { return coverAt(clock.time) >= 1; },
    get state() {
      if (lastView.active) return 'turning';
      const c = coverAt(clock.time);
      if (c >= 1) return 'open';
      if (c <= 0) return 'closed';
      return coverTarget() === 1 ? 'opening' : 'closing';
    },

    coverAt,
    coverTarget,
    resolve,
    apply,
    restY,

    /* Jump straight to a resting state: cover open, spread s, log cleared. */
    open(s) {
      base.spread = Math.max(0, Math.min(LEAF_COUNT - 1, s));
      base.cover = 1;
      log.length = 0;
      pool.want(base.spread);
      events.emit('jump', { spread: base.spread });
      apply({ spread: base.spread, active: null }, clock.time);
    },

    /* Back to the very start: cover shut, spread 0, log cleared. The tour
       uses this when a capture seek goes backwards and replays from zero. */
    reset() {
      base.spread = 0;
      base.cover = 0;
      log.length = 0;
      pool.want(0);
      events.emit('jump', { spread: 0, reset: true });
      apply({ spread: 0, active: null }, clock.time);
    },

    openCover() {
      if (coverTarget() === 1) return false;
      log.push({ type: 'open', t: clock.time, dur: coverDur() });
      events.emit('cover', { open: true, t: clock.time });
      return true;
    },

    closeCover() {
      if (coverTarget() === 0 || lastView.active || lastView.spread !== 0) return false;
      log.push({ type: 'close', t: clock.time, dur: coverDur() });
      events.emit('cover', { open: false, t: clock.time });
      return true;
    },

    /* A point on the open spread, in world space. u runs 0..1 across the whole
       spread (0 = left page's outer edge, 0.5 = the spine, 1 = right page's
       outer edge), v runs 0..1 down the page (0 = top edge, 1 = bottom edge),
       matching the boxes in assets/text/*.json and assets/layers/NN/layers.json.
       y is the top surface of whichever stack that side of the spread shows. */
    pageToWorld(u, v, out = new THREE.Vector3()) {
      const s = lastView.spread;
      const x = (u * 2 - 1) * PAGE_W;
      const z = (v - 0.5) * PAGE_H;
      const k = u < 0.5 ? s - 1 : s;
      const y = k < 0 ? BOARD_T : (k >= LEAF_COUNT ? restY(LEAF_COUNT - 1, s) : restY(k, s));
      out.set(x, y + 0.0004, z);
      return group.localToWorld(out);
    },

    /* Where the book is on the blanket, for pointer hit tests. */
    footprint() {
      const c = coverAt(clock.time);
      return {
        xMin: lerp(-0.03, -BOARD_W - 0.03, c),
        xMax: BOARD_W + 0.03,
        zMin: -BOARD_H / 2 - 0.03,
        zMax: BOARD_H / 2 + 0.03,
        top: BOARD_T + BLOCK_T * 0.6,
      };
    },
  };

  pool.want(0);
  apply({ spread: 0, active: null }, 0);
  return book;
}
