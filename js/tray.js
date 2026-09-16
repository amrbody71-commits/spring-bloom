/* tray.js — the counting tray, the book's place-value abacus.
 *
 * A shallow oiled-wood tray lies on the blanket to the right of the book. In
 * it, left to right: a dish of pebbles (hundreds), a dish of twigs (tens) and
 * a dish of shells (ones), each with a paper digit tile standing behind it,
 * so the readout above the dishes is the number the dishes hold. A carry
 * moves leftward, the way it does on paper.
 *
 * Everything the tray shows is a pure function of `api.time` and a log of
 * targets. `set(n, at)` and `add(n, at)` append an intent; the log compiles
 * into eras (snaps: a jump, a decrease, or reduced motion) and a list of
 * shell drops, each with a start time and a seed. From those, stateAt(t)
 * derives the landed total, which shells are in the air, which ten are
 * gathering into a twig and which ten twigs into a pebble, and the fold of
 * each digit tile. The meshes are posed from that every frame, so a seek in
 * capture mode lands on exactly the frame a real-time run would have shown.
 * The only randomness is mulberry32 seeded from the intent's time.
 *
 * Schedule of a change of n shells (KTD10): the first 12 drop one by one at
 * 90 ms, the rest in handfuls of 5 at a spacing chosen so the last landing,
 * carry and digit flip all finish inside 2.4 s. Each shell falls a parabola
 * from 0.18 above the dish over 260 ms and settles with a squash; a carry
 * gathers ten shells to the twig dish over 400 ms while the twig grows;
 * ten twigs become a pebble the same way, 200 ms after the hundredth shell
 * lands.
 *
 * Draw calls: shadow, tray, dishes (3 instances), three tiles, and three
 * InstancedMeshes for shells, twigs and pebbles: nine when the tray holds
 * anything, six when it is empty.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './rng.js';
import { createCountEvents } from './count-events.js';

/* ---- layout, in the tray's own frame (x right, z toward the reader) ---- */

/* Front-left of the book, where the landscape frame has empty desk once the
   reading panel takes the right; scene.js keeps the oak's grain and pool
   clear of the same spot (TRAY_KEEP_OUT). */
export const TRAY_AT = new THREE.Vector3(-1.85, 0, 0.9);
const TRAY_W = 0.6;
const TRAY_D = 0.42;
const FLOOR_T = 0.012;
const RIM_H = 0.034;
const RIM_T = 0.018;
const BEVEL = 0.004;
const DISH_X = [-0.2, 0, 0.2];          // pebbles, twigs, shells
const DISH_Z = 0.075;
const DISH_LIFT = -0.002;               // the lathe's foot ring sits at y = 0.002
const TILE_Z = -0.135;
const TILE_W = 0.078;
const TILE_H = 0.092;
const TILE_LEAN = 0.14;                 // radians back from vertical at rest
const PEBBLE_DISH = 0;
const TWIG_DISH = 1;
const SHELL_DISH = 2;

/* ---- timing, seconds (KTD10) ---- */

export const ARC = 0.26;
export const DROP_H = 0.18;
export const SINGLE_GAP = 0.09;
export const SINGLES = 12;
export const HANDFUL = 5;
export const HANDFUL_STAGGER = 0.015;
export const HANDFUL_GAP_MAX = 0.075;
export const SETTLE = 0.12;
export const CARRY = 0.4;
export const PEBBLE_DELAY = 0.2;
export const FLIP = 0.22;
export const CHANGE_MAX = 2.4;
const GROW_LAG = 0.1;                   // a twig or pebble starts growing this long into its carry

const SHELL_CAP = 512;
const TWIG_CAP = 96;
const PEBBLE_CAP = 24;

const CELLS = 11;                       // digit atlas: 0..9 and a blank cell for the tile's back
const CELL_W = 128;
const CELL_H = 160;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, k) => a + (b - a) * k;
const easeOut = (s) => 1 - (1 - s) * (1 - s);
const smooth = (s) => s * s * (3 - 2 * s);
const backOut = (s) => { const c1 = 1.70158; const c3 = c1 + 1; const x = s - 1; return 1 + c3 * x * x * x + c1 * x * x; };
const hash2 = (a, b) => (Math.imul((a ^ 0x9E3779B9) >>> 0, 0x85EBCA6B) ^ Math.imul((b + 0x7F4A7C15) >>> 0, 0xC2B2AE35)) >>> 0;

/* ---- resting slots inside each dish ---- */

const SHELL_SLOTS = [];
for (let i = 0; i < 7; i += 1) {
  const a = (i / 7) * Math.PI * 2 + 0.4;
  SHELL_SLOTS.push({ x: Math.cos(a) * 0.034, z: Math.sin(a) * 0.034, y: 0 });
}
for (let i = 0; i < 3; i += 1) {
  const a = (i / 3) * Math.PI * 2 + 1.2;
  SHELL_SLOTS.push({ x: Math.cos(a) * 0.012, z: Math.sin(a) * 0.012, y: 0 });
}
const TWIG_SLOTS = [];
for (let i = 0; i < 5; i += 1) TWIG_SLOTS.push({ x: 0, z: -0.024 + i * 0.012, y: 0 });
for (let i = 0; i < 4; i += 1) TWIG_SLOTS.push({ x: 0, z: -0.018 + i * 0.012, y: 0.0062 });
TWIG_SLOTS.push({ x: 0, z: 0, y: 0.0124 });
const PEBBLE_SLOTS = [];
for (let j = 0; j < 3; j += 1) for (let i = 0; i < 3; i += 1) PEBBLE_SLOTS.push({ x: (i - 1) * 0.034, z: (j - 1) * 0.03, y: 0 });
PEBBLE_SLOTS.push({ x: 0, z: 0, y: 0.011 });

/* The dish profile, (radius, height) from the foot to the inner floor. */
const DISH_PROFILE = [
  [0, 0.002], [0.046, 0.002], [0.058, 0.004], [0.064, 0.010], [0.066, 0.018],
  [0.0655, 0.0225], [0.062, 0.024], [0.0585, 0.0225], [0.055, 0.017],
  [0.045, 0.011], [0.030, 0.0078], [0, 0.0065],
];
const LIP_INDEX = 6;
const INNER = [[0, 0.0065], [0.030, 0.0078], [0.045, 0.011], [0.055, 0.017], [0.0585, 0.0225]];
function dishFloor(r) {
  for (let i = 1; i < INNER.length; i += 1) {
    if (r <= INNER[i][0]) {
      const k = (r - INNER[i - 1][0]) / (INNER[i][0] - INNER[i - 1][0]);
      return lerp(INNER[i - 1][1], INNER[i][1], k);
    }
  }
  return INNER[INNER.length - 1][1];
}

/* ---- canvas textures, all seeded ---- */

function srgb(t) {
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function woodTexture(seed, maxAniso) {
  const w = 512; const h = 512;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const rnd = mulberry32(seed);
  const ph = [rnd() * 6.283, rnd() * 6.283, rnd() * 6.283, rnd() * 6.283];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const u = x / w; const v = y / h;
      const wob = 0.02 * Math.sin(u * 12.0 + ph[0]) + 0.012 * Math.sin(u * 31.0 + ph[1]);
      const ring = 0.5 + 0.5 * Math.sin((v + wob) * 6.283 * 9 + 1.6 * Math.sin((v + wob) * 6.283 * 2.3 + ph[2]));
      const fine = 0.5 + 0.5 * Math.sin((v + wob * 0.5) * 6.283 * 70 + ph[3]);
      const noise = (rnd() - 0.5) * 0.07;
      const tone = 0.66 + 0.24 * ring + 0.08 * fine * fine + noise;
      const o = (y * w + x) * 4;
      img.data[o] = Math.min(255, 182 * tone + 10);
      img.data[o + 1] = Math.min(255, 116 * tone);
      img.data[o + 2] = Math.min(255, 62 * tone);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = srgb(new THREE.CanvasTexture(c));
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  t.anisotropy = Math.min(8, maxAniso);
  return t;
}

function glazeTexture() {
  const w = 4; const h = 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#F6EEDC';
  ctx.fillRect(0, 0, w, h);
  /* The lathe's v runs along the profile; flipY puts v = 0 at the bottom row. */
  const lipV = LIP_INDEX / (DISH_PROFILE.length - 1);
  const yLip = (1 - lipV) * h;
  const g = ctx.createLinearGradient(0, yLip - 7, 0, yLip + 7);
  g.addColorStop(0, 'rgba(201, 176, 132, 0)');
  g.addColorStop(0.5, 'rgba(201, 176, 132, 0.75)');
  g.addColorStop(1, 'rgba(201, 176, 132, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, yLip - 7, w, 14);
  /* A shade warmer inside the bowl, as glaze pools. */
  const inner = ctx.createLinearGradient(0, yLip, 0, 0);
  inner.addColorStop(0, 'rgba(226, 205, 165, 0)');
  inner.addColorStop(1, 'rgba(226, 205, 165, 0.35)');
  ctx.fillStyle = inner;
  ctx.fillRect(0, 0, w, yLip);
  return srgb(new THREE.CanvasTexture(c));
}

function shellTexture(seed) {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#F5EAD6';
  ctx.fillRect(0, 0, s, s);
  const rnd = mulberry32(seed);
  /* One soft peach stripe with two faint companions, across the ridges. */
  for (const [y, hgt, a] of [[62, 16, 0.42], [40, 5, 0.2], [88, 6, 0.22]]) {
    const g = ctx.createLinearGradient(0, y - hgt, 0, y + hgt);
    g.addColorStop(0, `rgba(240, 168, 128, 0)`);
    g.addColorStop(0.5, `rgba(240, 168, 128, ${a})`);
    g.addColorStop(1, `rgba(240, 168, 128, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, y - hgt, s, hgt * 2);
  }
  /* Ridge shading follows the nine ridges of the geometry (u runs around). */
  for (let k = 0; k < 9; k += 1) {
    const x = ((k + 0.5) / 9) * s;
    const g = ctx.createLinearGradient(x - 6, 0, x + 6, 0);
    g.addColorStop(0, 'rgba(150, 110, 80, 0)');
    g.addColorStop(0.5, 'rgba(150, 110, 80, 0.13)');
    g.addColorStop(1, 'rgba(150, 110, 80, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 6, 0, 12, s);
  }
  for (let i = 0; i < 400; i += 1) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.25)' : 'rgba(160,120,90,0.08)';
    ctx.fillRect(rnd() * s, rnd() * s, 1, 1);
  }
  return srgb(new THREE.CanvasTexture(c));
}

function barkTexture(seed) {
  const w = 64; const h = 32;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8C6A46';
  ctx.fillRect(0, 0, w, h);
  const rnd = mulberry32(seed);
  for (let i = 0; i < 26; i += 1) {
    const x = rnd() * w;
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(60, 40, 22, 0.35)' : 'rgba(200, 170, 130, 0.22)';
    ctx.fillRect(x, 0, 1 + rnd() * 1.5, h);
  }
  for (let i = 0; i < 120; i += 1) {
    ctx.fillStyle = 'rgba(50, 32, 18, 0.18)';
    ctx.fillRect(rnd() * w, rnd() * h, 1, 1 + rnd() * 3);
  }
  const t = srgb(new THREE.CanvasTexture(c));
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function stoneTexture(seed) {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8D9B87';
  ctx.fillRect(0, 0, s, s);
  const rnd = mulberry32(seed);
  for (let i = 0; i < 700; i += 1) {
    const v = rnd();
    ctx.fillStyle = v > 0.66 ? 'rgba(240, 244, 236, 0.30)' : (v > 0.33 ? 'rgba(70, 82, 66, 0.28)' : 'rgba(120, 130, 110, 0.25)');
    ctx.fillRect(rnd() * s, rnd() * s, 1, 1);
  }
  const t = srgb(new THREE.CanvasTexture(c));
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function drawAtlas(canvas, seed) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width; const h = canvas.height;
  ctx.fillStyle = '#F8F0DE';
  ctx.fillRect(0, 0, w, h);
  const rnd = mulberry32(seed);
  for (let i = 0; i < 9000; i += 1) {
    const dark = rnd() > 0.55;
    ctx.fillStyle = dark ? 'rgba(120, 90, 50, 0.07)' : 'rgba(255, 255, 255, 0.2)';
    ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1);
  }
  for (let d = 0; d < CELLS; d += 1) {
    /* A faint darker margin so each tile reads as a cut card. */
    ctx.strokeStyle = 'rgba(120, 90, 50, 0.16)';
    ctx.lineWidth = 3;
    ctx.strokeRect(d * CELL_W + 1.5, 1.5, CELL_W - 3, CELL_H - 3);
  }
  ctx.font = "600 118px 'Fredoka', 'Nunito', system-ui, sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(92, 56, 25, 0.94)';
  for (let d = 0; d < 10; d += 1) ctx.fillText(String(d), d * CELL_W + CELL_W / 2, CELL_H / 2 + 6);
}

function shadowTexture() {
  const w = 256; const h = 192;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.filter = 'blur(14px)';
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.roundRect(30, 34, w - 60, h - 68, 22);
  ctx.fill();
  return new THREE.CanvasTexture(c);
}

/* ---- geometry ---- */

function roundedRect(path, w, h, r) {
  const x = -w / 2; const y = -h / 2;
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
  return path;
}

function trayGeometry() {
  const outer = roundedRect(new THREE.Shape(), TRAY_W, TRAY_D, 0.04);
  const hole = roundedRect(new THREE.Path(), TRAY_W - 2 * RIM_T, TRAY_D - 2 * RIM_T, 0.028);
  outer.holes.push(hole);
  const rim = new THREE.ExtrudeGeometry(outer, {
    depth: RIM_H - 2 * BEVEL, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelOffset: 0, bevelSegments: 3, curveSegments: 10, steps: 1,
  });
  rim.rotateX(-Math.PI / 2);
  rim.translate(0, BEVEL, 0);
  const floor = new THREE.ExtrudeGeometry(roundedRect(new THREE.Shape(), TRAY_W - 2 * RIM_T, TRAY_D - 2 * RIM_T, 0.028), {
    depth: FLOOR_T, bevelEnabled: false, curveSegments: 10, steps: 1,
  });
  floor.rotateX(-Math.PI / 2);
  const merged = mergeGeometries([rim, floor], false);
  rim.dispose(); floor.dispose();
  return merged;
}

function dishGeometry() {
  const pts = DISH_PROFILE.map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 40);
}

function shellGeometry() {
  const g = new THREE.SphereGeometry(1, 28, 14);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i += 1) {
    let x = p.getX(i); let y = p.getY(i); let z = p.getZ(i);
    const th = Math.atan2(z, x);
    const ridge = 1 + 0.07 * Math.sin(th * 9) * (0.4 + 0.6 * (1 - Math.abs(y)));
    x *= ridge; z *= ridge;
    if (y < 0) y *= 0.35;
    p.setXYZ(i, x * 0.0175, y * 0.011, z * 0.0125);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  return g;
}

function twigGeometry() {
  const g = new THREE.CylinderGeometry(0.0022, 0.0036, 0.09, 7, 6, false);
  g.rotateZ(Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i += 1) {
    const x = p.getX(i);
    const k = x / 0.045;
    p.setZ(i, p.getZ(i) + 0.004 * k * k - 0.002);
    p.setY(i, p.getY(i) * (1 + 0.12 * Math.sin(k * 7.3)));
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  return g;
}

function pebbleGeometry(seed) {
  const g = new THREE.SphereGeometry(1, 18, 12);
  const rnd = mulberry32(seed);
  const a = [rnd() * 6.283, rnd() * 6.283, rnd() * 6.283];
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i += 1) {
    let x = p.getX(i); let y = p.getY(i); let z = p.getZ(i);
    const bump = 1 + 0.05 * Math.sin(3 * x + a[0]) * Math.cos(2 * z + a[1]) + 0.04 * Math.sin(4 * y + a[2]);
    x *= bump; y *= bump; z *= bump;
    if (y < 0) y *= 0.6;
    p.setXYZ(i, x * 0.0225, y * 0.0105, z * 0.017);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  return g;
}

/* A paper tile: a digit on the front, blank paper on the back, pivot at the
   bottom edge. Two quads, one material; the digit is chosen by moving the
   front quad's UVs to a cell of the atlas. */
function tileGeometry() {
  const hw = TILE_W / 2; const h = TILE_H; const t = 0.0008;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([
    -hw, 0, t, hw, 0, t, hw, h, t, -hw, h, t,
    hw, 0, -t, -hw, 0, -t, -hw, h, -t, hw, h, -t,
  ]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
  const uv = new Float32Array(16);
  const b0 = (10 + 0.03) / CELLS; const b1 = (10 + 0.97) / CELLS;
  uv.set([b0, 0.02, b1, 0.02, b1, 0.98, b0, 0.98], 8);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

function setTileDigit(tile, d) {
  if (tile.userData.digit === d) return;
  tile.userData.digit = d;
  const uv = tile.geometry.attributes.uv;
  const u0 = (d + 0.03) / CELLS; const u1 = (d + 0.97) / CELLS;
  uv.setXY(0, u0, 0.02); uv.setXY(1, u1, 0.02); uv.setXY(2, u1, 0.98); uv.setXY(3, u0, 0.98);
  uv.needsUpdate = true;
}

/* ---- the schedule of one change ---- */

const tailFor = (num) => (num % 100 === 0 ? PEBBLE_DELAY + CARRY : (num % 10 === 0 ? CARRY : FLIP));

/* Start offsets for n new shells, the first landing as number from + 1. */
function schedule(n, from) {
  const offs = new Array(n);
  const singles = Math.min(n, SINGLES);
  for (let k = 0; k < singles; k += 1) offs[k] = k * SINGLE_GAP;
  if (n <= SINGLES) return offs;
  const t0 = SINGLES * SINGLE_GAP;
  let gap = HANDFUL_GAP_MAX;
  for (let k = SINGLES; k < n; k += 1) {
    const h = Math.floor((k - SINGLES) / HANDFUL);
    const m = (k - SINGLES) % HANDFUL;
    if (h < 1) continue;
    const budget = CHANGE_MAX - t0 - ARC - m * HANDFUL_STAGGER - tailFor(from + k + 1);
    gap = Math.min(gap, budget / h);
  }
  gap = Math.max(gap, 0.002);
  /* Handfuls can overlap once the gap is short, so the list is sorted and
     numbered in landing order, then the gap is tightened until the last
     landing, carry and flip all sit inside the budget. */
  for (let tries = 0; tries < 16; tries += 1) {
    for (let k = SINGLES; k < n; k += 1) {
      const h = Math.floor((k - SINGLES) / HANDFUL);
      const m = (k - SINGLES) % HANDFUL;
      offs[k] = t0 + h * gap + m * HANDFUL_STAGGER;
    }
    offs.sort((a, b) => a - b);
    let end = 0;
    for (let k = 0; k < n; k += 1) end = Math.max(end, offs[k] + ARC + tailFor(from + k + 1));
    if (end <= CHANGE_MAX + 1e-9 || gap <= 0.002) break;
    gap = Math.max(0.002, gap * 0.92);
  }
  return offs;
}

/* Number of drops whose start is <= x (drops sorted by start). */
function upperBound(drops, x) {
  let lo = 0; let hi = drops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (drops[mid].start <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* ---- the module ---- */

export function init(api) {
  const seed = (api.seed || 7) >>> 0;
  const maxAniso = api.renderer ? api.renderer.capabilities.getMaxAnisotropy() : 1;
  const reduced = !!api.reduced;

  /* -- log -- */
  const intents = [];               // { id, t, kind, value, snap }
  let nextId = 1;
  let compiled = null;

  const seedOf = (it) => hash2(seed, Math.round(it.t * 1000));

  function addIntent(kind, value, at, opts) {
    const t = Number.isFinite(at) ? at : api.time;
    const v = Math.max(0, Math.round(Number(value) || 0));
    const it = { id: nextId, t, kind, value: v, snap: !!(opts && opts.snap) || reduced };
    nextId += 1;
    let i = intents.length;
    while (i > 0 && intents[i - 1].t > t) i -= 1;
    intents.splice(i, 0, it);
    compiled = null;
    return it.id;
  }

  function remove(id) {
    const i = intents.findIndex((x) => x.id === id);
    if (i < 0) return false;
    intents.splice(i, 1);
    compiled = null;
    return true;
  }

  function compile() {
    const eras = [{ t: -Infinity, total: 0, prev: 0, seed, drops: [], end: -Infinity }];
    const targets = [];
    let target = 0;
    for (const it of intents) {
      const era = eras[eras.length - 1];
      const ti = it.t;
      while (era.drops.length && era.drops[era.drops.length - 1].start > ti) era.drops.pop();
      const started = era.total + era.drops.length;
      const to = it.kind === 'set' ? it.value : target + it.value;
      if (it.snap || to < started) {
        const landedNow = era.total + upperBound(era.drops, ti - ARC);
        eras.push({ t: ti, total: to, prev: landedNow, seed: seedOf(it), drops: [], end: ti + FLIP });
      } else if (to > started) {
        const n = to - started;
        const rng = mulberry32(seedOf(it));
        const offs = schedule(n, started);
        for (let k = 0; k < n; k += 1) {
          era.drops.push({ n: started + k + 1, start: ti + offs[k], seed: (rng() * 4294967296) >>> 0 });
        }
      }
      const cur = eras[eras.length - 1];
      let end = Number.isFinite(cur.t) ? cur.t + FLIP : -Infinity;
      for (const d of cur.drops) end = Math.max(end, d.start + ARC + tailFor(d.n));
      cur.end = end;
      target = to;
      targets.push({ t: ti, total: to });
    }
    compiled = { eras, targets };
    return compiled;
  }
  const ensure = () => compiled || compile();

  function eraAt(t) {
    const { eras } = ensure();
    let i = eras.length - 1;
    while (i > 0 && eras[i].t > t) i -= 1;
    return eras[i];
  }

  function targetAt(t) {
    const { targets } = ensure();
    let v = 0;
    for (const x of targets) { if (x.t > t) break; v = x.total; }
    return v;
  }

  function resolve(t) {
    const era = eraAt(t);
    const D = era.drops;
    const landedIdx = upperBound(D, t - ARC);
    const startedIdx = upperBound(D, t);
    return { era, D, landedIdx, startedIdx, L: era.total + landedIdx };
  }

  const seedForNumber = (era, n) => (n > era.total ? era.drops[n - era.total - 1].seed : hash2(era.seed, n));
  const landTimeOf = (era, n) => (n > era.total ? era.drops[n - era.total - 1].start + ARC : -Infinity);

  /* Anything moving at t: a snap's digit flip, a shell in the air, or a
     recent landing whose settle, carry or flip is still running. Targets
     logged for later never count. */
  function busyAt(t, r) {
    const { era, D, landedIdx, startedIdx } = r;
    if (Number.isFinite(era.t) && t < era.t + FLIP) return true;
    if (startedIdx > landedIdx) return true;
    for (let j = landedIdx - 1; j >= 0; j -= 1) {
      const land = D[j].start + ARC;
      if (land <= t - CARRY - PEBBLE_DELAY) break;
      if (land + tailFor(era.total + j + 1) > t) return true;
    }
    return false;
  }

  function stateAt(t) {
    const r = resolve(t);
    const L = r.L;
    return {
      total: targetAt(t),
      landed: L,
      shells: L % 10,
      twigs: Math.floor(L / 10) % 10,
      pebbles: Math.floor(L / 100),
      digits: [Math.floor(L / 100) % 10, Math.floor(L / 10) % 10, L % 10],
      animating: busyAt(t, r),
    };
  }

  /* -- textures and materials -- */
  const wood = woodTexture(hash2(seed, 0x77), maxAniso);
  const glaze = glazeTexture();
  const shellMap = shellTexture(hash2(seed, 0x51));
  const bark = barkTexture(hash2(seed, 0x33));
  const stone = stoneTexture(hash2(seed, 0x19));
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = CELLS * CELL_W; atlasCanvas.height = CELL_H;
  drawAtlas(atlasCanvas, hash2(seed, 0x91));
  const atlas = srgb(new THREE.CanvasTexture(atlasCanvas));
  atlas.anisotropy = Math.min(8, maxAniso);

  const woodMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.5, metalness: 0 });
  const glazeMat = new THREE.MeshStandardMaterial({ map: glaze, roughness: 0.32, metalness: 0 });
  const shellMat = new THREE.MeshStandardMaterial({ map: shellMap, roughness: 0.6, metalness: 0 });
  const twigMat = new THREE.MeshStandardMaterial({ map: bark, roughness: 0.92, metalness: 0 });
  const pebbleMat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.45, metalness: 0 });
  const paperMat = new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.9, metalness: 0 });
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), color: 0x2A1A0E, transparent: true, depthWrite: false, opacity: 0.5 });

  /* -- meshes -- */
  const group = new THREE.Group();
  group.name = 'tray';
  group.position.copy(TRAY_AT);

  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(TRAY_W + 0.14, TRAY_D + 0.14), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.012, 0.0008, 0.01);
  group.add(shadow);

  const tray = new THREE.Mesh(trayGeometry(), woodMat);
  tray.frustumCulled = false;
  tray.renderOrder = -1;
  group.add(tray);

  const dishes = new THREE.InstancedMesh(dishGeometry(), glazeMat, 3);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 3; i += 1) {
    dummy.position.set(DISH_X[i], FLOOR_T + DISH_LIFT, DISH_Z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    dishes.setMatrixAt(i, dummy.matrix);
  }
  dishes.instanceMatrix.needsUpdate = true;
  dishes.frustumCulled = false;
  group.add(dishes);

  const shells = new THREE.InstancedMesh(shellGeometry(), shellMat, SHELL_CAP);
  const twigs = new THREE.InstancedMesh(twigGeometry(), twigMat, TWIG_CAP);
  const pebbles = new THREE.InstancedMesh(pebbleGeometry(hash2(seed, 0x61)), pebbleMat, PEBBLE_CAP);
  for (const m of [shells, twigs, pebbles]) {
    m.count = 0;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }

  const tiles = [];
  for (let i = 0; i < 3; i += 1) {
    const tile = new THREE.Mesh(tileGeometry(), paperMat);
    tile.position.set(DISH_X[i], FLOOR_T + 0.0004, TILE_Z);
    tile.rotation.x = -TILE_LEAN;
    tile.frustumCulled = false;
    tile.userData.digit = -1;
    setTileDigit(tile, 0);
    group.add(tile);
    tiles.push(tile);
  }

  api.scene.add(group);

  /* The digits are drawn again once Fredoka is resident. Before that the
     atlas shows the fallback face; `ready` resolves after the redraw. */
  const fontReady = (document.fonts && document.fonts.load)
    ? document.fonts.load("600 118px 'Fredoka'").catch(() => []).then(() => {
      drawAtlas(atlasCanvas, hash2(seed, 0x91));
      atlas.needsUpdate = true;
    })
    : Promise.resolve();

  /* -- posing -- */
  const dishBase = (i) => FLOOR_T + DISH_LIFT;
  const rest = { x: 0, y: 0, z: 0, yaw: 0, lat: 0, latR: 0, spin: 1, pitch: 0 };

  function shellRest(era, n, out = rest) {
    const rng = mulberry32(seedForNumber(era, n));
    const slot = SHELL_SLOTS[(n - 1) % 10];
    const x = slot.x + (rng() - 0.5) * 0.008;
    const z = slot.z + (rng() - 0.5) * 0.008;
    out.yaw = rng() * Math.PI * 2;
    out.lat = rng() * Math.PI * 2;
    out.latR = 0.02 + rng() * 0.03;
    out.spin = rng() < 0.5 ? -1 : 1;
    out.x = DISH_X[SHELL_DISH] + x;
    out.z = DISH_Z + z;
    out.y = dishBase(SHELL_DISH) + dishFloor(Math.hypot(x, z));
    out.pitch = 0;
    return out;
  }

  function twigRest(era, k, out = rest) {
    const rng = mulberry32(hash2(seedForNumber(era, 10 * k), 0x2C));
    const slot = TWIG_SLOTS[(k - 1) % 10];
    const x = slot.x + (rng() - 0.5) * 0.012;
    const z = slot.z + (rng() - 0.5) * 0.004;
    out.yaw = (rng() - 0.5) * 0.44;
    out.spin = rng() < 0.5 ? -1 : 1;
    out.x = DISH_X[TWIG_DISH] + x;
    out.z = DISH_Z + z;
    out.y = dishBase(TWIG_DISH) + dishFloor(Math.hypot(0.045, z)) + slot.y;
    out.pitch = (rng() - 0.5) * 0.06;
    return out;
  }

  function pebbleRest(era, p, out = rest) {
    const rng = mulberry32(hash2(seedForNumber(era, 100 * p), 0x4D));
    const slot = PEBBLE_SLOTS[(p - 1) % 10];
    const x = slot.x + (rng() - 0.5) * 0.006;
    const z = slot.z + (rng() - 0.5) * 0.006;
    out.yaw = rng() * Math.PI * 2;
    out.spin = 1;
    out.x = DISH_X[PEBBLE_DISH] + x;
    out.z = DISH_Z + z;
    out.y = dishBase(PEBBLE_DISH) + dishFloor(Math.hypot(x, z)) + slot.y;
    out.pitch = (rng() - 0.5) * 0.1;
    return out;
  }

  const growth = (t, since) => (since === -Infinity ? 1 : backOut(clamp01((t - since - GROW_LAG) / (CARRY - GROW_LAG))));

  let si = 0; let ti = 0; let pi = 0;
  function put(mesh, i, x, y, z, yaw, pitch, scale, squash) {
    dummy.position.set(x, y, z);
    dummy.rotation.set(pitch, yaw, 0);
    dummy.scale.set(scale, scale * squash, scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  const putShell = (x, y, z, yaw, pitch, scale, squash = 1) => { if (si < SHELL_CAP) put(shells, si++, x, y, z, yaw, pitch, scale, squash); };
  const putTwig = (x, y, z, yaw, pitch, scale) => { if (ti < TWIG_CAP) put(twigs, ti++, x, y, z, yaw, pitch, scale, 1); };
  const putPebble = (x, y, z, yaw, pitch, scale) => { if (pi < PEBBLE_CAP) put(pebbles, pi++, x, y, z, yaw, pitch, scale, 1); };

  const target = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  function poseItems(t, r) {
    const { era, D, landedIdx, startedIdx, L } = r;
    si = 0; ti = 0; pi = 0;

    /* Shells at rest in the dish, the newest still settling. */
    for (let n = L - (L % 10) + 1; n <= L; n += 1) {
      shellRest(era, n);
      const land = landTimeOf(era, n);
      let squash = 1; let yaw = rest.yaw;
      if (t - land < SETTLE) {
        const u = clamp01((t - land) / SETTLE);
        squash = 1 - 0.3 * Math.sin(Math.PI * u);
        yaw += 0.35 * (1 - u) * rest.spin;
      }
      putShell(rest.x, rest.y, rest.z, yaw, 0, 1, squash);
    }

    /* Shells in the air: a parabola from 0.18 above the dish. */
    for (let j = landedIdx; j < startedIdx; j += 1) {
      const d = D[j];
      const s = clamp01((t - d.start) / ARC);
      shellRest(era, era.total + j + 1);
      const e = easeOut(s);
      const x = lerp(rest.x + Math.cos(rest.lat) * rest.latR, rest.x, e);
      const z = lerp(rest.z + Math.sin(rest.lat) * rest.latR, rest.z, e);
      const y = rest.y + DROP_H * (1 - s * s);
      putShell(x, y, z, rest.yaw + (1 - s) * 2.0 * rest.spin, (1 - s) * 0.9 * rest.spin, 1);
    }

    /* Carries in progress: ten shells gathering into a twig, ten twigs into
       a pebble. Walk back through recent landings. */
    for (let j = landedIdx - 1; j >= 0; j -= 1) {
      const d = D[j];
      const land = d.start + ARC;
      if (land <= t - CARRY - PEBBLE_DELAY) break;
      const n = era.total + j + 1;
      if (n % 10 === 0 && land > t - CARRY) {
        const s = clamp01((t - land) / CARRY);
        const e = smooth(s);
        const k = n / 10;
        twigRest(era, k, target);
        for (let m = n - 9; m <= n; m += 1) {
          shellRest(era, m);
          const x = lerp(rest.x, target.x, e);
          const z = lerp(rest.z, target.z, e);
          const y = lerp(rest.y, target.y + 0.004, e) + 0.035 * Math.sin(Math.PI * s);
          putShell(x, y, z, lerp(rest.yaw, target.yaw, e), 0, 1 - 0.85 * s);
        }
      }
      if (n % 100 === 0) {
        const tc = land + PEBBLE_DELAY;
        if (tc <= t && tc > t - CARRY) {
          const s = clamp01((t - tc) / CARRY);
          const e = smooth(s);
          const p = n / 100;
          pebbleRest(era, p, target);
          for (let k = p * 10 - 9; k <= p * 10; k += 1) {
            twigRest(era, k);
            const g = growth(t, landTimeOf(era, 10 * k));
            if (g <= 0) continue;
            const x = lerp(rest.x, target.x, e);
            const z = lerp(rest.z, target.z, e);
            const y = lerp(rest.y, target.y + 0.004, e) + 0.03 * Math.sin(Math.PI * s);
            putTwig(x, y, z, lerp(rest.yaw, target.yaw, e), rest.pitch, g * (1 - 0.8 * s));
          }
        }
      }
    }

    /* Twigs at rest: those not yet gathered into a pebble whose carry has
       started. A twig grows in over its own carry. */
    const T = Math.floor(L / 10);
    const P = Math.floor(L / 100);
    let pStarted = 0;
    for (let p = 1; p <= P; p += 1) {
      const tc = landTimeOf(era, 100 * p);
      if (tc === -Infinity || tc + PEBBLE_DELAY <= t) pStarted = p;
    }
    for (let k = 10 * pStarted + 1; k <= T; k += 1) {
      const g = growth(t, landTimeOf(era, 10 * k));
      if (g <= 0) continue;
      twigRest(era, k);
      putTwig(rest.x, rest.y, rest.z, rest.yaw, rest.pitch, g);
    }

    /* Pebbles at rest. */
    for (let p = 1; p <= P; p += 1) {
      const tc = landTimeOf(era, 100 * p);
      const g = growth(t, tc === -Infinity ? -Infinity : tc + PEBBLE_DELAY);
      if (g <= 0) continue;
      pebbleRest(era, p);
      putPebble(rest.x, rest.y, rest.z, rest.yaw, rest.pitch, g);
    }

    shells.count = si; shells.instanceMatrix.needsUpdate = true;
    twigs.count = ti; twigs.instanceMatrix.needsUpdate = true;
    pebbles.count = pi; pebbles.instanceMatrix.needsUpdate = true;
  }

  /* The fold of one digit tile at time t: a cluster of recent changes to
     that digit, simulated forward. The tile folds to flat over the first
     half of FLIP and rises over the second; a change that lands mid-rise
     mirrors the phase so the angle never jumps, and the face shows the digit
     that was current at the last pass through flat. */
  const DIV = [100, 10, 1];
  const cluster = [];
  function flipFor(pos, r, t) {
    const div = DIV[pos];
    const { era, D, landedIdx, L } = r;
    const cur = Math.floor(L / div) % 10;
    if (reduced) return { angle: 0, shown: cur };
    cluster.length = 0;
    let lastT = t;
    let j = landedIdx - 1;
    for (; j >= 0; j -= 1) {
      const n = era.total + j + 1;
      if (n % div !== 0) continue;
      const ct = D[j].start + ARC;
      if (lastT - ct >= FLIP) break;
      cluster.push({ t: ct, value: Math.floor(n / div) % 10, before: Math.floor((n - 1) / div) % 10 });
      lastT = ct;
    }
    if (j < 0 && Number.isFinite(era.t) && lastT - era.t < FLIP) {
      const v = Math.floor(era.total / div) % 10;
      const b = Math.floor(era.prev / div) % 10;
      if (v !== b) cluster.push({ t: era.t, value: v, before: b });
    }
    if (!cluster.length) return { angle: 0, shown: cur };
    cluster.reverse();
    let p = 0;
    let shown = cluster[0].before;
    for (let i = 0; i < cluster.length; i += 1) {
      const c = cluster[i];
      const next = i + 1 < cluster.length ? cluster[i + 1].t : t;
      if (i > 0) { if (p >= 1) p = 0; else if (p >= 0.5) p = 1 - p; }
      const pn = p + (next - c.t) / FLIP;
      if (p < 0.5 && pn >= 0.5) shown = c.value;
      p = pn;
    }
    if (p >= 1) return { angle: 0, shown: cur };
    return { angle: Math.sin(Math.PI * p), shown };
  }

  function poseTiles(t, r) {
    for (let i = 0; i < 3; i += 1) {
      const f = flipFor(i, r, t);
      const tile = tiles[i];
      tile.rotation.x = -TILE_LEAN + (Math.PI / 2 + TILE_LEAN) * f.angle;
      setTileDigit(tile, f.shown);
      tile.updateMatrixWorld(true);
    }
  }

  function poseAt(t) {
    const r = resolve(t);
    poseItems(t, r);
    poseTiles(t, r);
    return r;
  }

  /* -- count events, from the landings between two frame times -- */
  function emitBetween(t0, t1) {
    const { eras } = ensure();
    for (let e = 0; e < eras.length; e += 1) {
      const era = eras[e];
      if (era.t > t1) break;
      const eraEnd = e + 1 < eras.length ? eras[e + 1].t : Infinity;
      const D = era.drops;
      for (let j = Math.max(0, upperBound(D, t0 - ARC - CARRY - PEBBLE_DELAY - 0.01) - 1); j < D.length; j += 1) {
        const land = D[j].start + ARC;
        if (land > t1) break;
        if (land > eraEnd) break;
        const n = era.total + j + 1;
        if (land > t0) {
          api.events.emit('count', { kind: 'shell', total: n, at: land });
          if (n % 10 === 0) api.events.emit('count', { kind: 'carry', total: n, at: land });
        }
        if (n % 10 === 0) {
          const tw = land + CARRY;
          if (tw > t0 && tw <= t1 && tw <= eraEnd) api.events.emit('count', { kind: 'twig', total: n, at: tw });
        }
        if (n % 100 === 0) {
          const tp = land + PEBBLE_DELAY + CARRY;
          if (tp > t0 && tp <= t1 && tp <= eraEnd) api.events.emit('count', { kind: 'pebble', total: n, at: tp });
        }
      }
    }
  }

  let lastTime = -Infinity;
  function update(t) {
    poseAt(t);
    if (t > lastTime && lastTime > -Infinity && t - lastTime <= 0.5) emitBetween(lastTime, t);
    lastTime = t;
  }
  /* Runs once per render, before any of the tray's other meshes draw
     (renderOrder -1, never culled), so instance matrices and tile folds set
     here are what this frame shows. */
  tray.onBeforeRender = () => { update(api.time); };

  /* -- API -- */
  const obj = {
    group,
    get total() { return targetAt(api.time); },
    totalAt: targetAt,
    set: (n, at, opts) => addIntent('set', n, at, opts),
    add: (n, at, opts) => addIntent('add', n, at, opts),
    remove,
    stateAt,
    poseAt: (t) => { poseAt(t); },
    log: () => intents.map((it) => ({ ...it })),
    load(entries) {
      intents.length = 0;
      for (const e of entries || []) {
        const id = Number.isFinite(e.id) ? e.id : nextId;
        nextId = Math.max(nextId, id) + 1;
        const it = { id, t: Number(e.t) || 0, kind: e.kind === 'add' ? 'add' : 'set', value: Math.max(0, Math.round(Number(e.value) || 0)), snap: !!e.snap || reduced };
        let i = intents.length;
        while (i > 0 && intents[i - 1].t > it.t) i -= 1;
        intents.splice(i, 0, it);
      }
      compiled = null;
      lastTime = -Infinity;
    },
    schedule,
    meshes: { tray, dishes, shells, twigs, pebbles, tiles, shadow },
    constants: { ARC, DROP_H, SINGLE_GAP, SINGLES, HANDFUL, SETTLE, CARRY, PEBBLE_DELAY, FLIP, CHANGE_MAX },
    story: null,
    ready: null,
  };
  obj.story = createCountEvents(api, obj);
  obj.ready = Promise.all([fontReady, obj.story.ready]).then(() => obj);
  api.tray = obj;
  return obj;
}
