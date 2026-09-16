/* props.js — the nook's furniture: the lamp, the foot of the bed, the room
 * shell. scene.js owns the table, the lights and the post chain; this file
 * owns everything that stands on or beyond the table and the canvases those
 * things are painted with.
 *
 * Frame: the table top is the XZ plane at y = 0, Y up, the book at the
 * origin. The camera's rest poses look down at the book from the front-right
 * at 38 to 63 degrees, and the top edge of the frame is a line on the table
 * about 2.7 units beyond the book, so a vertical at the lamp's spot leaves
 * the frame half a unit up. The lamp is drawn full height all the same: what
 * the rest poses see is its base, the foot of its stem, the fringe of its
 * halo and its pool on the oak, which is the shot (a lamp above the frame
 * lighting the desk in it); flights to a cut-out see the rest.
 *
 * Beyond the table's far edge the floor drops 3.4 units (a 75 cm desk), the
 * foot of a child's bed stands 1.2 units past the edge with its quilt top
 * just below table height, and the back wall carries a dusk gradient. All
 * of it lives inside scene.fog, so it reads as depth and never as detail;
 * the wall is fully dissolved from every rest pose and surfaces only when a
 * flight looks past the book from low down. The window is light, never
 * geometry (see createRoom).
 *
 * Two toys keep the lamp company in the same quiet register: a plush bear
 * sitting against the lamp's base and a wooden train parked beyond the
 * counting tray, both built from merged primitives and painted in the
 * book's palette. Neither enters the tray's keep-out or the book's
 * footprint.
 *
 * Draw calls: lamp 5 (base, step, stem, shade, halo), bear 2, train 4, bed
 * 3, room 2, plus one baked shadow blob under the lamp, the bear and the
 * train. No shadow maps. Every canvas is seeded (js/rng.js) so the reel
 * paints the same fibres in every frame.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './rng.js';

/* Behind the book's far-left corner, where the landscape home pose (with its
   headroom, camera.js HEADROOM) shows the whole lamp, shade included, clear
   of the title lockup at the frame's top-left. */
export const LAMP_AT = new THREE.Vector3(-1.35, 0, -1.75);
/* The bear sits against the lamp's base on its viewer side, facing the
   book, half a unit out from the stem: clear of the base's rim, 0.45 from
   the book's far-left corner, and (measured in the portrait home pose)
   a quarter unit outside the frame's left edge, so no fragment of it peeks
   into the reel. The train is parked beyond the tray zone's far side, nose
   turned a quarter toward the book. */
export const BEAR_AT = new THREE.Vector3(LAMP_AT.x + 0.24, 0, LAMP_AT.z + 0.46);
export const BEAR_FACING = 0.95;
export const TRAIN_AT = new THREE.Vector3(2.2, 0, -1.5);
export const TRAIN_HEADING = -2.7;
export const BULB_Y = 1.32;
export const LAMP_COLOR = 0xFFD08A;
/* Candela, decay 2, with a 2.9 unit cutoff: the cutoff's quartic roll-off
   keeps the pool on the desk round the base (1.4 units from the bulb) and
   takes most of the lamp off the page's centre (2.4 units away), so the pool
   can be bold without brightening the pages. Measured in tools/
   snap-scene.html: the oak at the base reads about a third brighter than
   the oak below the book, the page's top-left corner a tenth. */
export const LAMP_CANDELA = 2.0;
export const LAMP_REACH = 2.9;
export const FLOOR_Y = -3.4;
export const WALL_Z = -10.6;
export const BED = { xMin: 0.5, xMax: 4.6, zNear: -4.0, zFar: -10.5, top: -0.45 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---- geometry ------------------------------------------------------------ */

/* A BoxGeometry with its edges rounded to radius r: each vertex is clamped
   to the inner box (the box shrunk by r) and pushed back out along the
   offset to sit r away from it, which is a sphere at the corners, a cylinder
   along the edges and the flat face elsewhere. Only vertices within r of an
   edge move, so segment spacing under r gives a true round and coarser
   spacing gives a chamfer, which is all a table edge needs. UVs are the
   box's own. */
export function roundedBox(w, h, d, r, sx = 8, sy = 4, sz = 8) {
  const g = new THREE.BoxGeometry(w, h, d, sx, sy, sz);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const hx = w / 2 - r; const hy = h / 2 - r; const hz = d / 2 - r;
  const p = new THREE.Vector3(); const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    p.fromBufferAttribute(pos, i);
    c.set(clamp(p.x, -hx, hx), clamp(p.y, -hy, hy), clamp(p.z, -hz, hz));
    p.sub(c);
    if (p.lengthSq() > 1e-12) p.normalize(); else p.set(0, 1, 0);
    nor.setXYZ(i, p.x, p.y, p.z);
    p.multiplyScalar(r).add(c);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  return g;
}

/* ---- canvases ------------------------------------------------------------ */

function canvasTexture(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* A white disc with a soft alpha edge; the material's colour tints it. */
export function blobTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasTexture(c, false);
}

/* The lamp's halo: a radial falloff with a hot core, drawn additively. */
export function glowTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.26)');
  g.addColorStop(0.74, 'rgba(255,255,255,0.06)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasTexture(c);
}

/* Pleats: a cosine ridge-and-valley profile across the tile, ridges a shade
   lighter and valleys a shade darker than the cream, plus seeded linen
   flecks. Repeated twice round the shade it gives 64 pleats, about a
   centimetre each on a 20 cm shade. */
export function pleatTexture(seed) {
  const w = 512; const h = 64; const period = 16;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#F5E7CC';
  ctx.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += 1) {
    const v = 0.5 + 0.5 * Math.cos((2 * Math.PI * x) / period);
    ctx.fillStyle = `rgba(120, 82, 46, ${(0.13 * (1 - v)).toFixed(3)})`;
    ctx.fillRect(x, 0, 1, h);
    ctx.fillStyle = `rgba(255, 252, 240, ${(0.10 * v).toFixed(3)})`;
    ctx.fillRect(x, 0, 1, h);
  }
  const rnd = mulberry32(seed + 404);
  for (let i = 0; i < 700; i += 1) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(110,80,50,0.07)';
    ctx.fillRect(rnd() * w, rnd() * h, 1, 1 + rnd() * 2);
  }
  const t = canvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  return t;
}

/* Patchwork: an 8 x 8 grid of squares in the book's own muted palette, no
   square the colour of its left or upper neighbour, each with a soft
   padded highlight, a stitch line inset from its edge and a seeded weave.
   One tile is 4.1 units across the bed, so a square is about 11 cm. */
export function quiltTexture(seed) {
  const size = 512; const n = 8; const cell = size / n;
  const palette = ['#5A7F7C', '#B26F55', '#D8CBB0', '#7A9990', '#C9A88A', '#A8624F'];
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed + 505);
  const grid = [];
  for (let j = 0; j < n; j += 1) {
    grid.push([]);
    for (let i = 0; i < n; i += 1) {
      let k = Math.floor(rnd() * palette.length);
      for (let tries = 0; tries < 6; tries += 1) {
        const left = i > 0 ? grid[j][i - 1] : -1;
        const up = j > 0 ? grid[j - 1][i] : -1;
        if (k !== left && k !== up) break;
        k = (k + 1 + Math.floor(rnd() * (palette.length - 1))) % palette.length;
      }
      grid[j].push(k);
      const x = i * cell; const y = j * cell;
      ctx.fillStyle = palette[k];
      ctx.fillRect(x, y, cell, cell);
      const g = ctx.createRadialGradient(x + cell * 0.5, y + cell * 0.45, 2, x + cell * 0.5, y + cell * 0.5, cell * 0.75);
      g.addColorStop(0, 'rgba(255,250,240,0.16)');
      g.addColorStop(1, 'rgba(60,40,30,0.18)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cell, cell);
      ctx.strokeStyle = 'rgba(50,34,26,0.32)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,246,228,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 7.5, y + 7.5, cell - 15, cell - 15);
      ctx.setLineDash([]);
    }
  }
  for (let i = 0; i < 5000; i += 1) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(40,25,20,0.06)';
    ctx.fillRect(rnd() * size, rnd() * size, 1, 1 + rnd() * 2);
  }
  const t = canvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* The back wall: plum-grey at the skirting, deepening to near-black high up.
   Drawn bottom to top in the canvas so v = 0 is the floor. */
export function wallTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 256, 0, 0);
  g.addColorStop(0, '#3B2E3A');
  g.addColorStop(0.30, '#33283A');
  g.addColorStop(0.62, '#271E2C');
  g.addColorStop(1, '#1E1720');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  return canvasTexture(c);
}

/* ---- the lamp ------------------------------------------------------------ */

/* A walnut base and stem, a pleated cream shade (a truncated cone, open at
   both ends, lit from inside by the real point light and warmed by its own
   emissive so it glows without bloom), an additive halo sprite at the
   shade's centre, and a blob shadow under the base. About 34 cm tall with a
   23 cm shade: a small desk lamp. Nothing flickers: the light's intensity
   is a constant and the halo is a texture. */
export function createLamp(seed) {
  const group = new THREE.Group();
  group.name = 'lamp';
  const walnut = new THREE.MeshStandardMaterial({ color: 0x4A2D1C, roughness: 0.48, metalness: 0 });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.34, 0.06, 40), walnut);
  base.position.y = 0.03;
  const step = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.25, 0.05, 32), walnut);
  step.position.y = 0.085;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.046, 1.06, 18), walnut);
  stem.position.y = 0.11 + 0.53;
  group.add(base, step, stem);

  const shadeMaterial = new THREE.MeshStandardMaterial({
    map: pleatTexture(seed),
    color: 0xFFF4E2,
    emissive: new THREE.Color(0xFFB466),
    emissiveIntensity: 0.62,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.52, 0.46, 48, 1, true), shadeMaterial);
  shade.position.y = 1.30;
  group.add(shade);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(),
    color: 0xFFC27A,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    depthTest: true,
  }));
  glow.position.y = 1.30;
  glow.scale.set(2.3, 2.3, 1);
  group.add(glow);

  const light = new THREE.PointLight(LAMP_COLOR, LAMP_CANDELA, LAMP_REACH, 2);
  light.position.y = BULB_Y;
  group.add(light);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0x2A1A0E, transparent: true, depthWrite: false, opacity: 0.30 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.04, 0.0006, 0.04);
  shadow.scale.set(1.0, 0.9, 1);
  group.add(shadow);

  group.position.copy(LAMP_AT);
  return { group, light, shade, glow };
}

/* ---- the bear and the train ---------------------------------------------- */

/* Plush: a seeded speckle over the brown so the bear reads as fur rather
   than paint at the 90 px it gets in a landscape frame. */
function furTexture(seed) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8F6240';
  ctx.fillRect(0, 0, size, size);
  const rnd = mulberry32(seed + 606);
  for (let i = 0; i < 9000; i += 1) {
    const light = rnd() > 0.5;
    ctx.fillStyle = light ? `rgba(255,220,180,${(0.05 + rnd() * 0.12).toFixed(3)})` : `rgba(60,34,18,${(0.05 + rnd() * 0.12).toFixed(3)})`;
    ctx.fillRect(rnd() * size, rnd() * size, 1, 1 + rnd() * 3);
  }
  const t = canvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

/* Bakes a transform into a primitive so the parts can be merged: one draw
   call per material for the whole prop. */
function part(geometry, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
  geometry.applyMatrix4(m);
  return geometry;
}

function blobShadow(sx, sz, opacity) {
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0x2A1A0E, transparent: true, depthWrite: false, opacity }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.0006;
  shadow.scale.set(sx, sz, 1);
  return shadow;
}

/* A low-poly teddy sitting up, about 0.56 tall: spheres for body, head,
   muzzle, ears, arms and legs in one plush mesh, nose and eyes in a dark
   one. It leans back a little against the lamp's base. */
export function createBear(seed) {
  const group = new THREE.Group();
  group.name = 'bear';
  const sphere = (r, w = 14, h = 10) => new THREE.SphereGeometry(r, w, h);
  const plushParts = [
    part(sphere(0.165, 18, 14), 0, 0.20, 0, 1, 1.12, 0.92),
    part(sphere(0.135, 18, 14), 0, 0.44, 0.02),
    part(sphere(0.065), 0, 0.405, 0.125, 1.15, 0.85, 0.9),
    part(sphere(0.048), -0.105, 0.55, -0.01),
    part(sphere(0.048), 0.105, 0.55, -0.01),
    part(sphere(0.058), -0.175, 0.21, 0.06, 1, 1.6, 1, 0, 0, 0.35),
    part(sphere(0.058), 0.175, 0.21, 0.06, 1, 1.6, 1, 0, 0, -0.35),
    part(sphere(0.07), -0.105, 0.075, 0.16, 1, 0.75, 1.5),
    part(sphere(0.07), 0.105, 0.075, 0.16, 1, 0.75, 1.5),
  ];
  const plush = new THREE.Mesh(
    mergeGeometries(plushParts),
    new THREE.MeshStandardMaterial({ map: furTexture(seed), color: 0xE8CDB0, roughness: 0.96, metalness: 0 }),
  );
  const darkParts = [
    part(sphere(0.022, 10, 8), 0, 0.415, 0.185),
    part(sphere(0.015, 8, 6), -0.05, 0.46, 0.135),
    part(sphere(0.015, 8, 6), 0.05, 0.46, 0.135),
  ];
  const dark = new THREE.Mesh(
    mergeGeometries(darkParts),
    new THREE.MeshStandardMaterial({ color: 0x2A1C14, roughness: 0.35, metalness: 0 }),
  );
  const body = new THREE.Group();
  body.add(plush, dark);
  body.rotation.x = -0.2;
  body.position.y = 0.01;
  group.add(body);
  group.add(blobShadow(0.55, 0.5, 0.28));
  group.position.copy(BEAR_AT);
  group.rotation.y = BEAR_FACING;
  return group;
}

/* A wooden engine and one carriage, 0.92 long, painted in the book's
   palette: teal boiler and cab, terracotta carriage and running boards,
   cream wheels and cab roof, dark hubs, chimney and coupling. Four merged
   meshes; the nose is local +x. */
export function createTrain() {
  const group = new THREE.Group();
  group.name = 'train';
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const wheel = (x, z) => part(new THREE.CylinderGeometry(0.06, 0.06, 0.035, 18), x, 0.06, z, 1, 1, 1, Math.PI / 2, 0, 0);
  const hub = (x, z) => part(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 10), x, 0.06, z, 1, 1, 1, Math.PI / 2, 0, 0);
  const axles = [[0.10, 0.115], [0.10, -0.115], [0.38, 0.115], [0.38, -0.115], [-0.15, 0.115], [-0.15, -0.115], [-0.41, 0.115], [-0.41, -0.115]];
  const teal = [
    part(new THREE.CylinderGeometry(0.085, 0.085, 0.28, 20), 0.31, 0.17, 0, 1, 1, 1, 0, 0, Math.PI / 2),
    part(box(0.16, 0.22, 0.2), 0.08, 0.205, 0),
  ];
  const terracotta = [
    part(box(0.44, 0.035, 0.2), 0.24, 0.0775, 0),
    part(box(0.36, 0.035, 0.2), -0.28, 0.0775, 0),
    part(box(0.32, 0.14, 0.18), -0.28, 0.165, 0),
  ];
  const cream = [part(box(0.19, 0.03, 0.23), 0.08, 0.33, 0), ...axles.map(([x, z]) => wheel(x, z))];
  const dark = [
    part(new THREE.CylinderGeometry(0.03, 0.026, 0.09, 12), 0.40, 0.30, 0),
    part(box(0.1, 0.02, 0.03), -0.05, 0.08, 0),
    ...axles.map(([x, z]) => hub(x, z)),
  ];
  const paint = (color, roughness = 0.45) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
  group.add(
    new THREE.Mesh(mergeGeometries(teal), paint(0x5E8F8A)),
    new THREE.Mesh(mergeGeometries(terracotta), paint(0xC4704E)),
    new THREE.Mesh(mergeGeometries(cream), paint(0xEADCBD)),
    new THREE.Mesh(mergeGeometries(dark), paint(0x3A2A22, 0.6)),
  );
  group.add(blobShadow(1.1, 0.42, 0.28));
  group.position.copy(TRAIN_AT);
  group.rotation.y = TRAIN_HEADING;
  return group;
}

/* ---- the bed ------------------------------------------------------------- */

/* One rounded box from the floor to the quilt top, the bedspread reaching
   the floor: the top face and the foot get the patchwork at its own scale,
   the long sides a stretched copy that fog never lets anyone read. */
export function createBed(seed, maxAniso) {
  const w = BED.xMax - BED.xMin;
  const d = BED.zNear - BED.zFar;
  const h = BED.top - FLOOR_Y;
  const geometry = roundedBox(w, h, d, 0.28, 14, 10, 22);
  const quilt = quiltTexture(seed);
  quilt.anisotropy = Math.min(4, maxAniso);
  const top = quilt.clone();
  top.repeat.set(1, d / w);
  const foot = quilt.clone();
  foot.repeat.set(1, h / w);
  const side = quilt.clone();
  side.repeat.set(d / w, h / w);
  /* Dimmed well below the quilt's own colours: the bed is a ghost in the
     dusk even where the fog is thin (the portrait closed pose). */
  const mat = (map) => new THREE.MeshLambertMaterial({ map, color: 0x6F6358 });
  const sideMat = mat(side);
  const footMat = mat(foot);
  const mesh = new THREE.Mesh(geometry, [sideMat, sideMat, mat(top), sideMat, footMat, footMat]);
  mesh.name = 'bed';
  mesh.position.set((BED.xMin + BED.xMax) / 2, FLOOR_Y + h / 2, (BED.zNear + BED.zFar) / 2);
  return mesh;
}

/* ---- the room shell ------------------------------------------------------ */

/* Floor and back wall. The wall is an unlit plane: its canvas is the colour
   wanted on screen, and fog does the rest. The brief's window was built and
   measured out: on the back wall it sits twelve units from every rest pose,
   past the fog's far distance, and no flight ever looks that way, so the
   plane never reached a pixel. Chanel's rule took the plane; the window
   stays as the cool directional light in scene.js. */
export function createRoom() {
  const group = new THREE.Group();
  group.name = 'room';

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshLambertMaterial({ color: 0x2F2426 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  group.add(floor);

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 16),
    new THREE.MeshBasicMaterial({ map: wallTexture() }),
  );
  wall.position.set(0, FLOOR_Y + 8, WALL_Z);
  group.add(wall);

  return group;
}
