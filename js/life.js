/* life.js — one living moment per story spread, over the idle breathing.
 *
 * popup.js keeps every cut-out breathing (a bob, a sway, an occasional hop).
 * This module adds one noticeable event per spread on top: the meerkats duck
 * and pop up, the young falcon takes off and circles, leaves and petals
 * drift down, an apple drops from the tree and rolls, a crab scuttles, soap
 * bubbles rise and pop, the boat drifts on ripples while a fish jumps,
 * water drips from the cave roof among fireflies, butterflies flit between
 * flowers, a bat flutters across the cave mouth, dusk fireflies rise, and
 * the car reverses out once the last text box has been read.
 *
 * Time. Nothing here carries state between frames. Every pose is a function
 * of `st.since` (seconds since the spread settled, frozen while folding) and
 * of seeded phases from mulberry32 keyed on api.seed and the spread, so the
 * reel renderer draws the same frame at the same second, and a seek lands
 * on the right one. The one exception is spread 15's car, which is keyed on
 * api.time against the logged `box` event, so it is still a function of the
 * log. Reduced motion never reaches this module: popup's setPieces returns
 * before calling it.
 *
 * Budget. At most three extra draw calls per spread. Particle effects are
 * one mesh each: a small "batch" of quads with a per-vertex RGBA colour, so
 * one draw call carries a dozen leaves that each fade on their own, or a
 * Points cloud with per-point colour for glows. Every texture is a canvas.
 *
 * Space. Objects live in the spread's `e.group` (popup.js shows it only
 * while that spread is up), in book space: x across the spread, z down the
 * page, y up. Cut-out layers hand over their foot, box and page height, so
 * a point on a standing cut-out can be found from its spread fractions.
 * Draw order follows popup.js: plates 1, shadows 2, this module 3, sparkles 4.
 */

import * as THREE from 'three';
import { PAGE_W, PAGE_H } from './leaf.js';
import { mulberry32 } from './rng.js';

const LAYER_LIFT = 0.0028;      // popup.js: a flat layer above the page
const START = 2.5;              // first event: the rise ends at 1.3, then a breath
const ORDER = 3;                // renderOrder for everything transparent here
const HIDE_Y = -0.6;            // parked points sit under the table

const deg = THREE.MathUtils.degToRad;
const TAU = Math.PI * 2;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (k) => { const c = clamp01(k); return c * c * (3 - 2 * c); };
const easeOut = (k) => 1 - Math.pow(1 - clamp01(k), 3);
const easeIn = (k) => Math.pow(clamp01(k), 3);
const backOut = (k) => { const u = clamp01(k) - 1; return 1 + 2.2 * u * u * u + 1.2 * u * u; };
const lerp = (a, b, k) => a + (b - a) * k;
const X = (u) => (u * 2 - 1) * PAGE_W;
const Z = (v) => (v - 0.5) * PAGE_H;
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

/* ---- canvas textures ------------------------------------------------------ */

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* Alpha falls off from the centre; `k` is the radius fraction at half. */
function softDisc(ctx, w, h, k = 0.5, rgb = '255,255,255') {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, `rgba(${rgb},1)`);
  g.addColorStop(k, `rgba(${rgb},0.55)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

const TEXTURES = {
  glow: () => canvasTexture(32, 32, (ctx, w, h) => softDisc(ctx, w, h, 0.4)),
  disc: () => canvasTexture(64, 64, (ctx, w, h) => softDisc(ctx, w, h, 0.55)),
  /* a thin bright ring: ripples and splashes */
  ring: () => canvasTexture(64, 64, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const r = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2);
        const a = Math.exp(-((r - 24) * (r - 24)) / 7);
        const o = (y * w + x) * 4;
        img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
        img.data[o + 3] = Math.round(255 * a);
      }
    }
    ctx.putImageData(img, 0, 0);
  }),
  /* a soap bubble: a faint fill, a bright rim and a highlight */
  bubble: () => canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = 'rgba(220,240,255,0.16)';
    ctx.beginPath(); ctx.arc(32, 32, 27, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(32, 32, 26, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(190,225,255,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(32, 32, 22, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.ellipse(23, 21, 6, 4, -0.7, 0, TAU); ctx.fill();
  }),
  /* a water drop, point up */
  drop: () => canvasTexture(32, 32, (ctx) => {
    ctx.fillStyle = '#DCEEFF';
    ctx.beginPath();
    ctx.moveTo(16, 2);
    ctx.quadraticCurveTo(27, 18, 24, 24);
    ctx.arc(16, 22, 8, 0.3, Math.PI - 0.3, false);
    ctx.quadraticCurveTo(5, 18, 16, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(70,110,150,0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.ellipse(13, 20, 2.2, 3.2, 0.3, 0, TAU); ctx.fill();
  }),
  /* a pale leaf; the batch tints it green, yellow or rust */
  leaf: () => canvasTexture(64, 64, (ctx) => {
    ctx.translate(32, 32);
    ctx.rotate(-0.55);
    ctx.fillStyle = '#E9E9DD';
    ctx.beginPath(); ctx.ellipse(0, 0, 11, 26, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(70,80,40,0.5)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(0, 24); ctx.stroke();
    for (let i = -3; i <= 3; i += 1) {
      ctx.beginPath(); ctx.moveTo(0, i * 6); ctx.lineTo(7, i * 6 - 5); ctx.moveTo(0, i * 6); ctx.lineTo(-7, i * 6 - 5); ctx.stroke();
    }
  }),
  /* a crab from above, claws toward the top of the canvas */
  crab: () => canvasTexture(128, 96, (ctx) => {
    const red = '#D94B47'; const dark = '#A83430';
    ctx.strokeStyle = dark; ctx.lineWidth = 4; ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i += 1) {
        const y = 36 + i * 12;
        ctx.beginPath();
        ctx.moveTo(64 + s * 20, y);
        ctx.quadraticCurveTo(64 + s * 42, y - 6 + i * 2, 64 + s * 54, y + 10);
        ctx.stroke();
      }
      /* claw arm and pincer */
      ctx.beginPath(); ctx.moveTo(64 + s * 16, 40); ctx.quadraticCurveTo(64 + s * 34, 28, 64 + s * 36, 16); ctx.stroke();
      ctx.fillStyle = red;
      ctx.beginPath(); ctx.arc(64 + s * 38, 12, 8, 0, TAU); ctx.fill();
      ctx.strokeStyle = dark; ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#F6D4C8';
      ctx.beginPath(); ctx.moveTo(64 + s * 38, 12); ctx.lineTo(64 + s * 44, 2); ctx.lineTo(64 + s * 30, 4); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = dark; ctx.lineWidth = 4;
    }
    ctx.fillStyle = red;
    ctx.beginPath(); ctx.ellipse(64, 54, 28, 22, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = dark; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.ellipse(56, 46, 12, 7, -0.4, 0, TAU); ctx.fill();
    for (const s of [-1, 1]) {
      ctx.strokeStyle = dark; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(64 + s * 8, 36); ctx.lineTo(64 + s * 10, 26); ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.arc(64 + s * 10, 24, 4.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(64 + s * 10, 24, 2.2, 0, TAU); ctx.fill();
    }
  }),
  /* a small fish facing right */
  fish: () => canvasTexture(64, 32, (ctx) => {
    ctx.fillStyle = '#F2A544';
    ctx.beginPath(); ctx.moveTo(6, 16); ctx.lineTo(16, 7); ctx.lineTo(16, 25); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.ellipse(34, 16, 20, 9.5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#F7C978';
    ctx.beginPath(); ctx.ellipse(34, 19, 14, 5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#E48A2E';
    ctx.beginPath(); ctx.moveTo(28, 8); ctx.lineTo(38, 3); ctx.lineTo(40, 9); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(110,60,20,0.7)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(34, 16, 20, 9.5, 0, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(45, 13, 3.4, 0, TAU); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(46, 13, 1.8, 0, TAU); ctx.fill();
  }),
  /* a pale butterfly from above, body up the canvas; the batch tints it */
  butterfly: () => canvasTexture(64, 64, (ctx) => {
    const wing = (x, y, rx, ry, rot) => {
      ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, TAU); ctx.fill(); ctx.stroke();
    };
    ctx.fillStyle = '#F4F1EA';
    ctx.strokeStyle = 'rgba(40,22,22,0.95)';
    ctx.lineWidth = 3.5;
    wing(19, 24, 14, 11, -0.5);
    wing(45, 24, 14, 11, 0.5);
    wing(22, 42, 10, 9, 0.4);
    wing(42, 42, 10, 9, -0.4);
    ctx.fillStyle = 'rgba(40,22,22,0.7)';
    for (const [x, y] of [[14, 22], [50, 22], [21, 44], [43, 44]]) { ctx.beginPath(); ctx.arc(x, y, 3.4, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#2A1A1A';
    ctx.beginPath(); ctx.ellipse(32, 33, 3.6, 14, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#2A1A1A'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(32, 20); ctx.lineTo(26, 10); ctx.moveTo(32, 20); ctx.lineTo(38, 10); ctx.stroke();
  }),
  /* a bat, wings spread, seen head-on */
  bat: () => canvasTexture(64, 40, (ctx) => {
    ctx.fillStyle = '#4C5466';
    ctx.strokeStyle = 'rgba(190,200,225,0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(32, 14);
    ctx.quadraticCurveTo(44, 2, 62, 6);
    ctx.quadraticCurveTo(58, 16, 54, 22);
    ctx.quadraticCurveTo(50, 18, 46, 26);
    ctx.quadraticCurveTo(42, 22, 38, 28);
    ctx.lineTo(32, 30);
    ctx.lineTo(26, 28);
    ctx.quadraticCurveTo(22, 22, 18, 26);
    ctx.quadraticCurveTo(14, 18, 10, 22);
    ctx.quadraticCurveTo(6, 16, 2, 6);
    ctx.quadraticCurveTo(20, 2, 32, 14);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(32, 22, 6, 10, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(32, 12, 5.5, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(28, 8); ctx.lineTo(26, 1); ctx.lineTo(31, 6); ctx.moveTo(36, 8); ctx.lineTo(38, 1); ctx.lineTo(33, 6); ctx.stroke();
    ctx.fillStyle = '#F0E6C8';
    ctx.beginPath(); ctx.arc(29.5, 12, 1.4, 0, TAU); ctx.arc(34.5, 12, 1.4, 0, TAU); ctx.fill();
  }),
};

/* ---- a batch of quads in one draw call ------------------------------------ */

/* n quads with position, uv and RGBA colour per vertex (three reads a
   4-component colour attribute as colour with alpha), so every quad can be
   placed, sized, tinted and faded on its own each frame. Lit batches carry
   a normal per quad for MeshLambertMaterial. */
function makeBatch(n, material, lit = false) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 12);
  const col = new Float32Array(n * 16);
  const uvs = new Float32Array(n * 8);
  const nor = lit ? new Float32Array(n * 12) : null;
  const idx = new Uint16Array(n * 6);
  for (let i = 0; i < n; i += 1) {
    uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const posA = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const colA = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
  const norA = nor ? new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage) : null;
  geo.setAttribute('position', posA);
  geo.setAttribute('color', colA);
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (norA) geo.setAttribute('normal', norA);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = ORDER;
  const nrm = new THREE.Vector3();
  return {
    mesh,
    /* corners c ± r*hw ± u*hh; uv (0,0) sits at c - r*hw - u*hh, so the
       texture's top edge is on the `u` side */
    set(i, c, r, u, hw, hh, R, G, B, A) {
      const o = i * 12;
      const rx = r.x * hw; const ry = r.y * hw; const rz = r.z * hw;
      const ux = u.x * hh; const uy = u.y * hh; const uz = u.z * hh;
      pos[o] = c.x - rx - ux; pos[o + 1] = c.y - ry - uy; pos[o + 2] = c.z - rz - uz;
      pos[o + 3] = c.x + rx - ux; pos[o + 4] = c.y + ry - uy; pos[o + 5] = c.z + rz - uz;
      pos[o + 6] = c.x + rx + ux; pos[o + 7] = c.y + ry + uy; pos[o + 8] = c.z + rz + uz;
      pos[o + 9] = c.x - rx + ux; pos[o + 10] = c.y - ry + uy; pos[o + 11] = c.z - rz + uz;
      for (let k = 0; k < 4; k += 1) {
        const q = i * 16 + k * 4;
        col[q] = R; col[q + 1] = G; col[q + 2] = B; col[q + 3] = A;
      }
      if (nor) {
        nrm.crossVectors(r, u).normalize();
        for (let k = 0; k < 4; k += 1) { nor[o + k * 3] = nrm.x; nor[o + k * 3 + 1] = nrm.y; nor[o + k * 3 + 2] = nrm.z; }
      }
    },
    hide(i) {
      pos.fill(0, i * 12, i * 12 + 12);
      for (let k = 0; k < 4; k += 1) col[i * 16 + k * 4 + 3] = 0;
    },
    commit() {
      posA.needsUpdate = true;
      colA.needsUpdate = true;
      if (norA) norA.needsUpdate = true;
    },
    dispose() { geo.dispose(); material.dispose(); },
  };
}

function makePoints(n, material) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) pos[i * 3 + 1] = HIDE_Y;
  const posA = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const colA = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posA);
  geo.setAttribute('color', colA);
  const obj = new THREE.Points(geo, material);
  obj.frustumCulled = false;
  obj.renderOrder = ORDER + 1;
  return {
    obj,
    set(i, x, y, z, R, G, B, A) {
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      col[i * 4] = R; col[i * 4 + 1] = G; col[i * 4 + 2] = B; col[i * 4 + 3] = A;
    },
    hide(i) { pos[i * 3] = 0; pos[i * 3 + 1] = HIDE_Y; pos[i * 3 + 2] = 0; col[i * 4 + 3] = 0; },
    commit() { posA.needsUpdate = true; colA.needsUpdate = true; },
    dispose() { geo.dispose(); material.dispose(); },
  };
}

/* Transparent and double-sided would normally be drawn twice (back faces,
   then front); forceSinglePass keeps each batch at one draw call. */
function spriteMaterial(map, { lit = false, blending = THREE.NormalBlending } = {}) {
  const opts = {
    map: map || null, vertexColors: true, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, blending, alphaTest: map ? 0.02 : 0,
  };
  const mat = lit ? new THREE.MeshLambertMaterial(opts) : new THREE.MeshBasicMaterial(opts);
  mat.forceSinglePass = true;
  return mat;
}

function pointsMaterial(map, size, blending = THREE.NormalBlending) {
  return new THREE.PointsMaterial({
    map, size, sizeAttenuation: true, vertexColors: true, transparent: true,
    depthWrite: false, blending, alphaTest: 0.02,
  });
}

/* ---- the module ------------------------------------------------------------ */

export function createLife({ api, root }) {
  const reduced = !!api.reduced;
  const seed0 = (api.seed || 7) >>> 0;
  const textures = new Map();
  const T = (name) => {
    if (!textures.has(name)) textures.set(name, TEXTURES[name]());
    return textures.get(name);
  };
  const recs = new Map();     // spread -> { e, run, dispose }

  /* One seed per spread and salt; a per-cycle seed feeds a fresh mulberry so
     each apple drops from a new place while the sequence stays fixed. */
  const seedFor = (spread, salt = 0) => (Math.imul(seed0, 2654435761) ^ Math.imul(spread + 1, 40503) ^ Math.imul(salt + 1, 0x9E3779B1)) >>> 0;

  /* Camera right, up and forward in book space, for billboards. */
  const camR = new THREE.Vector3(); const camU = new THREE.Vector3(); const camF = new THREE.Vector3();
  const rootInv = new THREE.Matrix4();
  function camBasis() {
    rootInv.copy(root.matrixWorld).invert();
    camR.setFromMatrixColumn(api.camera.matrixWorld, 0).transformDirection(rootInv);
    camU.setFromMatrixColumn(api.camera.matrixWorld, 1).transformDirection(rootInv);
    camF.crossVectors(camR, camU).normalize();
  }

  const surf = (e, u) => (u < 0.5 ? e.plateL : e.plateR).position.y;   // page top, a hair up
  /* A point of a standing cut-out's image, from its spread fractions. */
  function onLayer(L, u, v, out) {
    const h = (L.box[3] - v) * PAGE_H;
    const t = deg(L.tilt);
    out.set(L.x + (u - L.foot[0]) * 2 * PAGE_W, L.pageY + LAYER_LIFT + h * Math.sin(t), L.z - h * Math.cos(t));
    return out;
  }

  const v0 = new THREE.Vector3(); const v1 = new THREE.Vector3(); const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3(); const v4 = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  /* ---- spread 15's car, from the card's box events --------------------- */

  /* Each entry says where the car is heading from `t` on and the offset it
     starts from (found from the entries before it, so the whole thing stays
     a pure function of the log): out = reversing off the page, in = driving
     back to its place. A step to a middle box leaves the car where it is. */
  const CAR_RUN = 0.95; const CAR_OUT_S = 2.6; const CAR_IN_S = 1.9;
  const carLog = [];          // { t, out, from } in book seconds
  function carAt(time) {
    const last = carLog.length ? carLog[carLog.length - 1] : null;
    if (!last) return { x: 0, moving: false, gone: false };
    if (last.out) {
      const k = (time - last.t) / CAR_OUT_S;
      if (k <= 0) return { x: last.from, moving: false, gone: false };
      if (k >= 1) return { x: -CAR_RUN, moving: false, gone: true };
      return { x: last.from + (-CAR_RUN - last.from) * Math.pow(k, 2.2) + 0.015 * Math.sin(Math.PI * Math.min(1, k * 3)), moving: true, gone: false };
    }
    if (!Number.isFinite(last.t)) return { x: 0, moving: false, gone: false };
    const k = (time - last.t) / CAR_IN_S;
    if (k <= 0) return { x: last.from, moving: false, gone: false };
    if (k < 1) return { x: last.from * (1 - easeOut(k)), moving: true, gone: false };
    const b = time - last.t - CAR_IN_S;
    return { x: 0.012 * (Math.abs(last.from) / CAR_RUN) * Math.sin(b * 9) * Math.exp(-b * 3), moving: false, gone: false };
  }
  api.events.on('box', (p) => {
    if (!p || p.spread !== 15 || !Number.isFinite(p.count)) return;
    const at = Number.isFinite(p.at) ? p.at : null;
    if (p.box === p.count - 1) {
      const t = (at == null ? api.time : at) + 1.5;
      carLog.push({ t, out: true, from: carAt(t).x });
    } else if (at == null) {
      carLog.push({ t: -Infinity, out: false, from: 0 });
    } else {
      carLog.push({ t: at, out: false, from: carAt(at).x });
    }
    if (carLog.length > 8) carLog.splice(0, carLog.length - 8);
  });
  api.events.on('jump', () => { carLog.length = 0; });

  /* ---- the moments -------------------------------------------------------- */

  /* 1. The meerkats duck into the sand and pop back up for a look round. */
  function meerkatPeek(e) {
    const L = e.byId.get('meerkats');
    if (!L) return null;
    const P = 8; const T0 = 3.8;
    return {
      e,
      dispose() {},
      run(s, gain) {
        if (s < T0 || gain <= 0) return;
        const a = (s - T0) % P;
        let dip = 0; let lift = 0; let wig = 0;
        if (a < 0.35) dip = easeIn(a / 0.35);
        else if (a < 1.6) dip = 1;
        else if (a < 2.0) { const b = backOut((a - 1.6) / 0.4); dip = Math.max(0, 1 - b); lift = Math.max(0, b - 1) * 0.08; }
        else if (a < 3.6) { const w = a - 2.0; wig = deg(5) * Math.sin(TAU * 1.3 * w) * Math.exp(-w * 1.4); }
        dip *= gain;
        L.pivot.position.y += lift * gain - dip * L.h * 1.06;
        L.mesh.rotation.z += wig * gain;
        L.shadow.material.opacity *= 1 - dip;
      },
    };
  }

  /* 2. The young falcon bursts out of the canopy, circles in front of the
        trees and lands back on its branch. */
  function falconFlight(e) {
    const L = e.byId.get('falcon');
    if (!L) return null;
    const P = 11; const T0 = 2.8; const F = 6.5;
    const sx = L.shadow.position.x; const sz = L.shadow.position.z;
    return {
      e,
      dispose() {},
      run(s, gain) {
        let dx = 0; let dy = 0; let dz = 0; let bank = 0; let face = 1;
        if (s >= T0 && gain > 0) {
          const a = (s - T0) % P;
          if (a < F) {
            const k = a / F;
            const th = TAU * k;
            dx = 0.55 * Math.sin(th);
            dz = 0.31 * (1 - Math.cos(th));
            dy = 0.5 * Math.pow(Math.sin(Math.PI * k), 0.8) + 0.012 * Math.sin(TAU * 3.2 * a) * Math.sin(Math.PI * k);
            bank = deg(11) * Math.sin(th);
            face = Math.max(-1, Math.min(1, Math.cos(th) * 4));
            dx *= gain; dy *= gain; dz *= gain; bank *= gain;
            face = lerp(1, face, gain);
          }
        }
        L.pivot.position.x = L.x + dx;
        L.pivot.position.z = L.z + dz;
        L.pivot.position.y += dy;
        L.mesh.rotation.z += bank;
        L.mesh.scale.x = Math.abs(L.mesh.scale.x) * (face === 0 ? 0.02 : face);
        L.shadow.position.x = sx + dx;
        L.shadow.position.z = sz + dz;
        L.shadow.material.opacity *= clamp01(1 - dy / 0.6);
      },
    };
  }

  /* 3. Leaves drift down from the canopy, tumble, land and fade. */
  function leafFall(e) {
    const wall = e.byId.get('wall');
    if (!wall) return null;
    const N = 10; const P = 9;
    const rnd = mulberry32(seedFor(3));
    const tints = [lin(0x7FB35A), lin(0x9CC46A), lin(0xC9B94A), lin(0xD9A23E), lin(0xB8743A)];
    const leaves = [];
    for (let i = 0; i < N; i += 1) {
      const left = rnd() < 0.3;
      leaves.push({
        u: left ? 0.03 + rnd() * 0.16 : 0.5 + rnd() * 0.45,
        v: 0.26 + rnd() * 0.2,
        delay: rnd() * P,
        fall: 2.6 + rnd() * 1.0,
        rest: 1.0 + rnd() * 0.9,
        amp: 0.03 + rnd() * 0.04,
        freq: 0.9 + rnd() * 0.7,
        ph: rnd() * TAU,
        spin: (rnd() - 0.5) * 3,
        size: 0.8 + rnd() * 0.5,
        tint: tints[Math.floor(rnd() * tints.length)],
      });
    }
    const B = makeBatch(N, spriteMaterial(T('leaf'), { lit: true }), true);
    e.group.add(B.mesh);
    return {
      e,
      dispose() { e.group.remove(B.mesh); B.dispose(); },
      run(s, gain) {
        for (let i = 0; i < N; i += 1) {
          const Lf = leaves[i];
          const t = s - START - Lf.delay;
          if (t < 0 || gain <= 0) { B.hide(i); continue; }
          const a = t % P;
          const life = Lf.fall + Lf.rest + 0.6;
          if (a > life) { B.hide(i); continue; }
          onLayer(wall, Lf.u, Lf.v, v0);
          const yPage = surf(e, Lf.u) + 0.004;
          const k = clamp01(a / Lf.fall);
          const y = lerp(v0.y, yPage, k);
          const x = v0.x + Lf.amp * Math.sin(TAU * Lf.freq * Math.min(a, Lf.fall) + Lf.ph);
          const z = wall.z + 0.03 + 0.12 * k;
          const a1 = Lf.ph + 0.9 * Lf.spin * Math.min(a, Lf.fall);
          const a2 = 0.35 + 0.5 * Math.sin(1.3 * Lf.spin * Math.min(a, Lf.fall));
          v1.set(Math.cos(a1), 0, -Math.sin(a1));
          v2.set(Math.sin(a1) * Math.sin(a2), Math.cos(a2), Math.cos(a1) * Math.sin(a2));
          const flat = smooth((k - 0.85) / 0.15);
          v3.set(Math.sin(a1), 0, Math.cos(a1));
          v2.lerp(v3, flat).normalize();
          v4.set(x, y, z);
          const alpha = gain * (a > Lf.fall + Lf.rest ? 1 - (a - Lf.fall - Lf.rest) / 0.6 : 1);
          B.set(i, v4, v1, v2, 0.028 * Lf.size, 0.018 * Lf.size, Lf.tint[0], Lf.tint[1], Lf.tint[2], clamp01(alpha));
        }
        B.commit();
      },
    };
  }

  /* 4 and 13. An apple drops from the tree, bounces, rolls to rest, then a
        new one falls from another branch. */
  function appleDrop(e, spread, { u: [u0, u1], v: [va, vb], zLand: [z0, z1], dir, T0 = 3.2, P = 9 }) {
    const wall = e.byId.get('wall');
    if (!wall) return null;
    const R = 0.027; const G = 1.5; const BOUNCE = 0.42;
    const app = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(R, 14, 10), new THREE.MeshStandardMaterial({ color: 0xD8362B, roughness: 0.45, metalness: 0 }));
    body.scale.set(1, 0.92, 1);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0035, 0.014, 5), new THREE.MeshStandardMaterial({ color: 0x5B3A1E, roughness: 0.9, metalness: 0 }));
    stem.position.y = R * 0.92 + 0.005;
    stem.rotation.z = deg(12);
    app.add(body, stem);
    app.visible = false;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: T('disc'), color: 0x000000, transparent: true, depthWrite: false, opacity: 0.3 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 2;
    shadow.visible = false;
    e.group.add(app, shadow);
    const axis = new THREE.Vector3(); const dirV = new THREE.Vector3(dir[0], 0, dir[1]).normalize();
    axis.crossVectors(UP, dirV).normalize();
    return {
      e,
      dispose() {
        e.group.remove(app, shadow);
        body.geometry.dispose(); body.material.dispose();
        stem.geometry.dispose(); stem.material.dispose();
        shadow.geometry.dispose(); shadow.material.dispose();
      },
      run(s, gain) {
        if (s < T0 || gain <= 0) { app.visible = false; shadow.visible = false; return; }
        const cyc = Math.floor((s - T0) / P);
        const a = s - T0 - cyc * P;
        const rnd = mulberry32(seedFor(spread, cyc));
        const u = lerp(u0, u1, rnd());
        const v = lerp(va, vb, rnd());
        const zLand = lerp(z0, z1, rnd());
        const roll = 0.10 + rnd() * 0.12;
        const spinPre = rnd() * TAU;
        onLayer(wall, u, v, v0);
        const yg = surf(e, u) + R * 0.92 + 0.002;
        const h0 = Math.max(0.05, v0.y - yg);
        const t1 = Math.sqrt(2 * h0 / G);
        const vb1 = G * t1 * BOUNCE;
        const t2 = 2 * vb1 / G;
        const vb2 = vb1 * BOUNCE;
        const t3 = 2 * vb2 / G;
        const tRoll = t1 + t2 + t3;
        const rollT = 1.3;
        let y; let sq = 0; let d = 0;
        if (a < t1) y = v0.y - 0.5 * G * a * a;
        else if (a < t1 + t2) { const b = a - t1; y = yg + vb1 * b - 0.5 * G * b * b; sq = 0.22 * Math.exp(-b * 18); }
        else if (a < tRoll) { const b = a - t1 - t2; y = yg + vb2 * b - 0.5 * G * b * b; sq = 0.12 * Math.exp(-b * 18); }
        else { y = yg; d = roll * easeOut((a - tRoll) / rollT); sq = 0.06 * Math.exp(-(a - tRoll) * 18); }
        /* the fall drifts a little forward; the bounces carry on the roll line */
        const kf = clamp01(a / tRoll);
        const x = v0.x + dirV.x * (0.03 * kf + d);
        const z = lerp(v0.z, zLand, clamp01(a / t1)) + dirV.z * (0.03 * kf + d);
        const fade = clamp01((P - 0.15 - a) / 0.45);
        const sc = gain * fade;
        app.position.set(x, y, z);
        app.quaternion.setFromAxisAngle(axis, spinPre + 0.8 * Math.min(a, tRoll) + d / R);
        app.scale.set(sc * (1 + sq * 0.6), sc * (1 - sq), sc * (1 + sq * 0.6));
        app.visible = sc > 0.01;
        const height = Math.max(0, y - yg);
        const ss = R * 2.6 * (1 + 0.6 * height / 0.4) * sc;
        shadow.position.set(x, yg - R * 0.92 + 0.001, z);
        shadow.scale.set(ss, ss * 0.85, 1);
        shadow.material.opacity = 0.3 * clamp01(1 - height / 0.55) * sc;
        shadow.visible = app.visible;
      },
    };
  }

  /* 5. A crab scuttles sideways along the sand, pauses, scuttles back. */
  function crabScuttle(e) {
    const B = makeBatch(1, spriteMaterial(T('crab')));
    e.group.add(B.mesh);
    const P = 8.5; const T0 = START + 0.4;
    const U0 = 0.90; const U1 = 0.62; const V = 0.865; const RUN = 2.4; const PAUSE = 1.4;
    return {
      e,
      dispose() { e.group.remove(B.mesh); B.dispose(); },
      run(s, gain) {
        if (s < T0 || gain <= 0) { B.hide(0); B.commit(); return; }
        const a = (s - T0) % P;
        let u; let moving = false; let rot = 0; let tp = 0;
        if (a < RUN) { u = lerp(U0, U1, smooth(a / RUN)); moving = true; }
        else if (a < RUN + PAUSE) { u = U1; tp = a - RUN; }
        else if (a < RUN * 2 + PAUSE) { u = lerp(U1, U0, smooth((a - RUN - PAUSE) / RUN)); moving = true; }
        else { u = U0; tp = a - RUN * 2 - PAUSE; }
        let zj = 0;
        if (moving) { zj = 0.003 * Math.sin(TAU * 9 * a); rot = deg(4) * Math.sin(TAU * 9 * a); }
        else rot = deg(6) * Math.sin(TAU * 2.5 * tp) * Math.exp(-tp * 1.2);
        v1.set(Math.cos(rot), 0, Math.sin(rot));
        v2.set(Math.sin(rot), 0, -Math.cos(rot));
        v0.set(X(u), surf(e, u) + 0.004, Z(V) + zj);
        B.set(0, v0, v1, v2, 0.05, 0.038, 1, 1, 1, gain);
        B.commit();
      },
    };
  }

  /* 6. Pink petals drift down from the pink tree's canopy. */
  function pinkPetals(e) {
    const tree = e.byId.get('tree');
    if (!tree) return null;
    const N = 14; const P = 7;
    const rnd = mulberry32(seedFor(6));
    const tints = [lin(0xE9789F), lin(0xF08DB0), lin(0xD9628F)];
    const petals = [];
    for (let i = 0; i < N; i += 1) {
      petals.push({
        u: 0.62 + rnd() * 0.36, v: 0.04 + rnd() * 0.22,
        delay: rnd() * P, fall: 2.4 + rnd() * 0.9,
        amp: 0.02 + rnd() * 0.03, freq: 1.1 + rnd() * 0.9, ph: rnd() * TAU,
        drift: -(0.05 + rnd() * 0.12), spin1: (rnd() - 0.5) * 5, spin2: (rnd() - 0.5) * 4,
        size: 0.8 + rnd() * 0.5, tint: tints[Math.floor(rnd() * tints.length)],
      });
    }
    const B = makeBatch(N, spriteMaterial(null, { lit: true }), true);
    e.group.add(B.mesh);
    return {
      e,
      dispose() { e.group.remove(B.mesh); B.dispose(); },
      run(s, gain) {
        for (let i = 0; i < N; i += 1) {
          const Pt = petals[i];
          const t = s - START - Pt.delay;
          if (t < 0 || gain <= 0) { B.hide(i); continue; }
          const a = t % P;
          if (a > Pt.fall) { B.hide(i); continue; }
          const k = a / Pt.fall;
          onLayer(tree, Pt.u, Pt.v, v0);
          const yEnd = tree.pageY + 0.15;
          const y = lerp(v0.y, yEnd, k);
          const x = v0.x + Pt.drift * k + Pt.amp * Math.sin(TAU * Pt.freq * a + Pt.ph);
          const z = tree.z + 0.03 + 0.05 * k;
          const a1 = Pt.spin1 * a + Pt.ph; const a2 = Pt.spin2 * a;
          v1.set(Math.cos(a1), Math.sin(a1) * 0.4, -Math.sin(a1) * 0.6).normalize();
          v2.set(Math.sin(a2) * 0.5, Math.cos(a2), Math.sin(a2) * 0.5).normalize();
          v4.set(x, y, z);
          const alpha = gain * clamp01((1 - k) / 0.25);
          B.set(i, v4, v1, v2, 0.016 * Pt.size, 0.011 * Pt.size, Pt.tint[0], Pt.tint[1], Pt.tint[2], alpha);
        }
        B.commit();
      },
    };
  }

  /* 7. Soap bubbles rise from the children's hands and pop. */
  function soapBubbles(e) {
    const zade = e.byId.get('zade'); const aliya = e.byId.get('aliya');
    if (!zade && !aliya) return null;
    const N = 9; const P = 8;
    const rnd = mulberry32(seedFor(7));
    const bubbles = [];
    for (let i = 0; i < N; i += 1) {
      bubbles.push({
        src: rnd() < 0.5 ? 0 : 1,
        delay: rnd() * 4.5, life: 2.6 + rnd() * 1.0, rise: 0.3 + rnd() * 0.18,
        amp: 0.01 + rnd() * 0.02, freq: 0.6 + rnd() * 0.6, ph: rnd() * TAU,
        dx: (rnd() - 0.5) * 0.12, size: 0.014 + rnd() * 0.011,
      });
    }
    const B = makeBatch(N, spriteMaterial(T('bubble')));
    e.group.add(B.mesh);
    const tint = lin(0xFFFFFF);
    return {
      e,
      dispose() { e.group.remove(B.mesh); B.dispose(); },
      run(s, gain) {
        for (let i = 0; i < N; i += 1) {
          const Bb = bubbles[i];
          const t = s - START - Bb.delay;
          if (t < 0 || gain <= 0) { B.hide(i); continue; }
          const a = t % P;
          if (a > Bb.life + 0.15) { B.hide(i); continue; }
          const src = Bb.src === 0 && zade ? zade : aliya || zade;
          if (src === zade) onLayer(zade, 0.56, 0.70, v0); else onLayer(aliya, 0.87, 0.72, v0);
          const k = clamp01(a / Bb.life);
          const x = v0.x + Bb.dx * k + Bb.amp * Math.sin(TAU * Bb.freq * a + Bb.ph);
          const y = v0.y + Bb.rise * easeOut(k * 0.9 + 0.1 * k * k);
          const z = v0.z + 0.03 + 0.02 * Math.cos(TAU * Bb.freq * 0.7 * a + Bb.ph);
          let size = Bb.size; let alpha = gain * smooth(a / 0.25);
          if (a > Bb.life) { const p = (a - Bb.life) / 0.15; size *= 1 + 0.6 * p; alpha *= 1 - p; }
          v4.set(x, y, z);
          B.set(i, v4, camR, camU, size, size, tint[0], tint[1], tint[2], clamp01(alpha));
        }
        B.commit();
      },
    };
  }

  /* 8. The boat drifts on the river over spreading ripples, and a fish
        jumps beside it once a cycle. */
  function riverLife(e) {
    const boat = e.byId.get('boat');
    if (!boat) return null;
    const P = 10; const T0 = START;
    const sx = boat.shadow.position.x; const sz = boat.shadow.position.z;
    const rings = makeBatch(5, spriteMaterial(T('ring')));
    const fish = makeBatch(1, spriteMaterial(T('fish')));
    e.group.add(rings.mesh, fish.mesh);
    const white = lin(0xFFFFFF);
    /* the leap starts at the spine and lands short of the boat's box */
    const FX = X(0.50); const FZ = Z(0.72); const JUMP_AT = 4.2; const JUMP = 0.8; const LEAP = 0.11;
    const RX = new THREE.Vector3(1, 0, 0); const RZ = new THREE.Vector3(0, 0, -1);
    return {
      e,
      dispose() { e.group.remove(rings.mesh, fish.mesh); rings.dispose(); fish.dispose(); },
      run(s, gain) {
        if (s < T0 || gain <= 0) {
          for (let i = 0; i < 5; i += 1) rings.hide(i);
          fish.hide(0); rings.commit(); fish.commit();
          boat.pivot.position.x = boat.x; boat.pivot.position.z = boat.z;
          boat.shadow.position.x = sx; boat.shadow.position.z = sz;
          return;
        }
        const a = s - T0;
        const dx = 0.06 * Math.sin(TAU * a / 12) * gain;
        const dz = 0.028 * Math.sin(TAU * a / 12 + 1.1) * gain;
        boat.pivot.position.x = boat.x + dx;
        boat.pivot.position.z = boat.z + dz;
        boat.shadow.position.x = sx + dx;
        boat.shadow.position.z = sz + dz;
        const yw = surf(e, 0.75) + 0.003;
        for (let i = 0; i < 3; i += 1) {
          const q = ((a + i * 0.9) % 2.7) / 2.7;
          const r = 0.06 + 0.2 * q;
          const alpha = 0.4 * (1 - q) * smooth(q / 0.15) * gain;
          v4.set(boat.x + dx, yw, boat.z + dz + 0.04);
          rings.set(i, v4, RX, RZ, r, r * 0.55, white[0], white[1], white[2], alpha);
        }
        const c = a % P;
        const k = (c - JUMP_AT) / JUMP;
        if (k >= 0 && k <= 1) {
          const x = FX + LEAP * k;
          const y = yw + 0.14 * Math.sin(Math.PI * k);
          const ang = Math.atan2(0.14 * Math.PI * Math.cos(Math.PI * k), LEAP);
          v1.copy(camR).multiplyScalar(Math.cos(ang)).addScaledVector(camU, Math.sin(ang));
          v2.copy(camR).multiplyScalar(-Math.sin(ang)).addScaledVector(camU, Math.cos(ang));
          v4.set(x, y, FZ);
          fish.set(0, v4, v1, v2, 0.036, 0.018, white[0], white[1], white[2], gain);
        } else fish.hide(0);
        /* a splash at the leap and one at the dive */
        const splash = (i, at, x) => {
          const q = (c - at) / 0.55;
          if (q < 0 || q > 1) { rings.hide(i); return; }
          const r = 0.012 + 0.05 * easeOut(q);
          v4.set(x, yw, FZ + 0.02);
          rings.set(i, v4, RX, RZ, r, r * 0.55, white[0], white[1], white[2], 0.65 * (1 - q) * gain);
        };
        splash(3, JUMP_AT, FX);
        splash(4, JUMP_AT + JUMP, FX + LEAP);
        rings.commit(); fish.commit();
      },
    };
  }

  /* 9. Drops fall from the cave roof and splash; fireflies drift. */
  function caveLife(e) {
    const wall = e.byId.get('wall');
    if (!wall) return null;
    const ND = 6; const NF = 14;
    const rnd = mulberry32(seedFor(9));
    const drops = [];
    for (let i = 0; i < ND; i += 1) {
      drops.push({ u: 0.05 + rnd() * 0.40, period: 2.4 + rnd() * 1.8, off: rnd() * 4, dz: rnd() * 0.02 });
    }
    const flies = [];
    for (let i = 0; i < NF; i += 1) {
      flies.push({
        x: -0.95 + rnd() * 0.95, y: 0.1 + rnd() * 0.45, z: 0.28 + rnd() * 0.3,
        f1: 0.11 + rnd() * 0.12, f2: 0.07 + rnd() * 0.1, f3: 0.09 + rnd() * 0.1,
        p1: rnd() * TAU, p2: rnd() * TAU, p3: rnd() * TAU,
        blink: 0.35 + rnd() * 0.5, bp: rnd() * TAU,
      });
    }
    const dropPts = makePoints(ND, pointsMaterial(T('drop'), 0.085));
    const splashes = makeBatch(ND, spriteMaterial(T('ring')));
    const flyPts = makePoints(NF, pointsMaterial(T('glow'), 0.16));
    e.group.add(dropPts.obj, splashes.mesh, flyPts.obj);
    const G = 1.6;
    const white = lin(0xFFFFFF); const warm = lin(0xFFE04A);
    const RX = new THREE.Vector3(1, 0, 0); const RZ = new THREE.Vector3(0, 0, -1);
    return {
      e,
      dispose() {
        e.group.remove(dropPts.obj, splashes.mesh, flyPts.obj);
        dropPts.dispose(); splashes.dispose(); flyPts.dispose();
      },
      run(s, gain) {
        const t = s - START;
        for (let i = 0; i < ND; i += 1) {
          const D = drops[i];
          if (t < 0 || gain <= 0) { dropPts.hide(i); splashes.hide(i); continue; }
          onLayer(wall, D.u, 0.03, v0);
          const yPage = surf(e, D.u) + 0.004;
          const h = v0.y - yPage;
          const tf = Math.sqrt(2 * h / G);
          const a = (t + D.off) % D.period;
          const z = wall.z + 0.03 + D.dz;
          if (a < tf) {
            const y = v0.y - 0.5 * G * a * a;
            dropPts.set(i, v0.x, y, z, white[0], white[1], white[2], gain * smooth(a / 0.15));
          } else dropPts.hide(i);
          const q = (a - tf) / 0.45;
          if (q >= 0 && q <= 1) {
            const r = 0.008 + 0.05 * easeOut(q);
            v4.set(v0.x, yPage, z);
            splashes.set(i, v4, RX, RZ, r, r * 0.55, white[0], white[1], white[2], 0.8 * (1 - q) * gain);
          } else splashes.hide(i);
        }
        for (let i = 0; i < NF; i += 1) {
          const F = flies[i];
          if (t < 0 || gain <= 0) { flyPts.hide(i); continue; }
          const x = F.x + 0.05 * Math.sin(TAU * F.f1 * t + F.p1);
          const y = F.y + 0.04 * Math.sin(TAU * F.f2 * t + F.p2);
          const z = F.z + 0.03 * Math.sin(TAU * F.f3 * t + F.p3);
          const b = Math.pow(0.5 + 0.5 * Math.sin(TAU * F.blink * t + F.bp), 3);
          flyPts.set(i, x, y, z, warm[0], warm[1], warm[2], gain * smooth(t / 1.2) * (0.15 + 0.85 * b));
        }
        dropPts.commit(); splashes.commit(); flyPts.commit();
      },
    };
  }

  /* 10. Two butterflies flit between the flowers. */
  function butterflies(e) {
    const N = 2; const W = 6;
    const rnd = mulberry32(seedFor(10));
    const tints = [lin(0xE8602A), lin(0x5A8CFF)];
    const bugs = [];
    for (let i = 0; i < N; i += 1) {
      const pts = [];
      for (let j = 0; j < W; j += 1) pts.push([-0.05 + rnd() * 0.67, 0.04 + rnd() * 0.1, 0.10 + rnd() * 0.12]);
      const legs = [];
      for (let j = 0; j < W; j += 1) legs.push([1.4 + rnd() * 0.8, 0.5 + rnd() * 0.5]);
      bugs.push({ pts, legs, total: legs.reduce((acc, l) => acc + l[0] + l[1], 0), ph: rnd() * TAU, tint: tints[i % tints.length], off: rnd() * 5 });
    }
    const B = makeBatch(N, spriteMaterial(T('butterfly')));
    e.group.add(B.mesh);
    const head = new THREE.Vector3();
    return {
      e,
      dispose() { e.group.remove(B.mesh); B.dispose(); },
      run(s, gain) {
        for (let i = 0; i < N; i += 1) {
          const Bg = bugs[i];
          const t = s - START;
          if (t < 0 || gain <= 0) { B.hide(i); continue; }
          let a = (t + Bg.off) % Bg.total;
          let j = 0; let moving = false; let k = 0;
          while (j < W) {
            const [fly, hover] = Bg.legs[j];
            if (a < fly) { moving = true; k = a / fly; break; }
            a -= fly;
            if (a < hover) { moving = false; k = 1; break; }
            a -= hover;
            j += 1;
          }
          if (j >= W) j = W - 1;
          const p0 = Bg.pts[j]; const p1 = Bg.pts[(j + 1) % W];
          const q = smooth(k);
          const x = lerp(p0[0], p1[0], q);
          const z = lerp(p0[2], p1[2], q);
          const y = surf(e, 0.75) + lerp(p0[1], p1[1], q) + 0.02 * Math.sin(TAU * 1.7 * t + Bg.ph) + (moving ? 0.03 * Math.sin(Math.PI * k) : 0);
          head.set(p1[0] - p0[0], 0, p1[2] - p0[2]);
          if (head.lengthSq() < 1e-6) head.set(1, 0, 0);
          head.normalize();
          const flap = moving ? 0.35 + 0.65 * Math.abs(Math.cos(TAU * 8 * t + Bg.ph)) : 0.4 + 0.6 * Math.abs(Math.cos(TAU * 2.2 * t + Bg.ph));
          v1.set(head.z, 0, -head.x);
          v2.set(head.x, 0.35, head.z).normalize();
          v4.set(x, y, z);
          B.set(i, v4, v1, v2, 0.04 * flap, 0.037, Bg.tint[0], Bg.tint[1], Bg.tint[2], gain * smooth(t / 0.8));
        }
        B.commit();
      },
    };
  }

  /* 11. One bat leaves the roost, flutters across the cave mouth and back. */
  function batFlight(e) {
    const B = makeBatch(1, spriteMaterial(T('bat')));
    e.group.add(B.mesh);
    const P = 10; const T0 = START + 0.6; const F = 5.2;
    const white = lin(0xFFFFFF);
    return {
      e,
      dispose() { e.group.remove(B.mesh); B.dispose(); },
      run(s, gain) {
        if (s < T0 || gain <= 0) { B.hide(0); B.commit(); return; }
        const a = (s - T0) % P;
        if (a > F) { B.hide(0); B.commit(); return; }
        const k = a / F;
        const x = 0.45 - 1.15 * Math.sin(Math.PI * k);
        const fwd = smooth(k * 4) * smooth((1 - k) * 4);
        const z = -0.15 + 0.5 * fwd;
        const y = 0.3 + 0.3 * Math.sin(Math.PI * k) + 0.025 * Math.sin(TAU * 4.5 * a);
        const flap = 0.4 + 0.6 * Math.abs(Math.sin(TAU * 7 * a));
        const roll = deg(14) * Math.cos(Math.PI * k);
        v1.copy(camR).multiplyScalar(Math.cos(roll)).addScaledVector(camU, Math.sin(roll));
        v2.copy(camR).multiplyScalar(-Math.sin(roll)).addScaledVector(camU, Math.cos(roll));
        v4.set(x, y, z);
        B.set(0, v4, v1, v2, 0.07 * flap, 0.045, white[0], white[1], white[2], gain * smooth(a / 0.4) * smooth((F - a) / 0.4));
        B.commit();
      },
    };
  }

  /* 14. Dusk fireflies rise slowly through the trees. */
  function duskFireflies(e) {
    const N = 16;
    const rnd = mulberry32(seedFor(14));
    const flies = [];
    for (let i = 0; i < N; i += 1) {
      flies.push({
        x: -0.9 + rnd() * 1.8, z: -0.1 + rnd() * 0.65, period: 6 + rnd() * 3, off: rnd() * 9,
        rise: 0.25 + rnd() * 0.25, f1: 0.15 + rnd() * 0.15, p1: rnd() * TAU, f2: 0.1 + rnd() * 0.12, p2: rnd() * TAU,
        blink: 0.5 + rnd() * 0.6, bp: rnd() * TAU,
      });
    }
    const pts = makePoints(N, pointsMaterial(T('glow'), 0.16));
    e.group.add(pts.obj);
    const warm = lin(0xFFD640);
    return {
      e,
      dispose() { e.group.remove(pts.obj); pts.dispose(); },
      run(s, gain) {
        const t = s - START;
        for (let i = 0; i < N; i += 1) {
          const F = flies[i];
          if (t < 0 || gain <= 0) { pts.hide(i); continue; }
          const a = (t + F.off) % F.period;
          const k = a / F.period;
          const x = F.x + 0.06 * Math.sin(TAU * F.f1 * a + F.p1);
          const z = F.z + 0.04 * Math.sin(TAU * F.f2 * a + F.p2);
          const y = surf(e, F.x > 0 ? 0.75 : 0.25) + 0.02 + F.rise * k;
          const env = smooth(a / 0.6) * smooth((F.period - a) / 0.9);
          const b = Math.pow(0.5 + 0.5 * Math.sin(TAU * F.blink * a + F.bp), 3);
          pts.set(i, x, y, z, warm[0], warm[1], warm[2], gain * env * (0.12 + 0.88 * b));
        }
        pts.commit();
      },
    };
  }

  /* 15. The car reverses out and drives off once the last box has been
         read (and drives back in should the reader step back); steam
         rises from the mother's cup. */
  function picnicEnd(e) {
    const car = e.byId.get('car'); const mother = e.byId.get('mother');
    const N = 5;
    const rnd = mulberry32(seedFor(15));
    const wisps = [];
    for (let i = 0; i < N; i += 1) wisps.push({ off: rnd() * 2.4, amp: 0.006 + rnd() * 0.008, freq: 0.5 + rnd() * 0.5, ph: rnd() * TAU });
    const B = mother ? makeBatch(N, spriteMaterial(T('glow'))) : null;
    if (B) e.group.add(B.mesh);
    const sx = car ? car.shadow.position.x : 0;
    const white = lin(0xFFFFFF);
    return {
      e,
      dispose() { if (B) { e.group.remove(B.mesh); B.dispose(); } },
      run(s, gain, time) {
        if (car) {
          const { x, moving, gone } = carAt(time);
          car.pivot.position.x = car.x + x;
          car.shadow.position.x = sx + x;
          if (moving) car.pivot.position.y += 0.004 * Math.abs(Math.sin(time * TAU * 4));
          if (gone) { car.mesh.visible = false; car.shadow.visible = false; }
        }
        if (B) {
          for (let i = 0; i < N; i += 1) {
            const Wp = wisps[i];
            const t = s - START;
            if (t < 0 || gain <= 0) { B.hide(i); continue; }
            const a = (t + Wp.off) % 2.4;
            const k = a / 2.4;
            onLayer(mother, 0.245, 0.752, v0);
            v4.set(v0.x + 0.02 * k + Wp.amp * Math.sin(TAU * Wp.freq * a + Wp.ph), v0.y + 0.09 * k, v0.z + 0.012);
            const size = 0.012 + 0.02 * k;
            B.set(i, v4, camR, camU, size, size, white[0], white[1], white[2], gain * 0.28 * Math.sin(Math.PI * k));
          }
          B.commit();
        }
      },
    };
  }

  const BUILDERS = {
    1: meerkatPeek,
    2: falconFlight,
    3: leafFall,
    4: (e) => appleDrop(e, 4, { u: [0.30, 0.44], v: [0.28, 0.36], zLand: [0.26, 0.34], dir: [0.35, 1] }),
    5: crabScuttle,
    6: pinkPetals,
    7: soapBubbles,
    8: riverLife,
    9: caveLife,
    10: butterflies,
    11: batFlight,
    13: (e) => appleDrop(e, 13, { u: [0.42, 0.50], v: [0.30, 0.38], zLand: [0.33, 0.40], dir: [-0.6, 1] }),
    14: duskFireflies,
    15: picnicEnd,
  };

  /* Called by popup.js from setPieces, after the breathe loop, only while
     the spread is up (rising, risen or folding). */
  function update(e, st) {
    if (reduced || !e || e.status !== 'ready' || !e.group) return;
    for (const [n, r] of recs) {
      if (r.e.disposed || (n === e.spread && r.e !== e)) { r.dispose(); recs.delete(n); }
    }
    let r = recs.get(e.spread);
    if (!r) {
      const make = BUILDERS[e.spread];
      if (!make) return;
      r = make(e);
      if (!r) return;
      recs.set(e.spread, r);
    }
    const gain = st.phase === 'risen' ? 1 : (st.phase === 'folding' ? 1 - st.fold : 0);
    camBasis();
    r.run(st.since, gain, api.time);
  }

  function dispose() {
    for (const r of recs.values()) r.dispose();
    recs.clear();
    for (const t of textures.values()) t.dispose();
    textures.clear();
  }

  return { update, dispose, get spreads() { return Array.from(recs.keys()); } };
}
