/* scene.js — the setting: renderer, lights, fog, the oak table, the nook's
 * props, post.
 *
 * The book is the subject and the setting is a bedtime reading nook around
 * it: an oak desk under a small lamp with a plush bear against its base and
 * a wooden train parked at the far right, and past the desk's far edge a
 * bedroom at dusk (the foot of a bed, a wall, a window that is only light)
 * that fog turns into depth. One bold thing, the lamp's pool of warm light
 * on oak grain; everything else is quiet. The desk falls into shadow toward
 * the frame edges the way MengTo's Storylight desk does, painted into the
 * slab's vertex colours as the lamp's pool over a softer zone round the
 * book, so the eye stays on the pages.
 *
 * What the rest poses see was measured, not assumed (the numbers are in
 * TABLE below): every rest pose looks down at the book steeply enough that
 * a vertical at the lamp's spot leaves the frame half a unit up, so the
 * lamp's shade is above the landscape frame and the lamp is out of the
 * portrait frame altogether. The shot is the base, the stem, the bear and
 * the pool; the shade and its halo appear during flights to a cut-out.
 *
 * Lighting: the book is still lit mainly by the warm key from the front-left
 * and the fill from the front-right (the side the closed-book pose looks
 * from), so the pages and cut-outs read as before. The hemisphere went from
 * blue-over-tan to dusk-lavender-over-oak, a cool low "window" directional
 * comes from the far left, and the lamp is a real point light (candela, decay
 * 2) tuned so the oak under the lamp reads about a quarter brighter than the
 * oak beside the book. No shadow maps anywhere; every shadow is a baked
 * sprite. The table's x 1.45 to 2.05, z -0.35 to 0.35 stays empty for the
 * counting tray.
 *
 * The table is a MeshStandardMaterial at roughness 0.55 (measured against
 * Lambert this is the one surface worth the extra half millisecond: the key
 * light's broad highlight is what makes the lamp read on the wood). Its grain
 * is a seeded 1536 px canvas: wide rift-sawn planks along Z, long wavering
 * grain lines with integer wobble periods so the tile wraps without a seam,
 * open pores, a few silver-grain flecks, and a bevelled seam per plank.
 *
 * Performance policy, decided once at boot from the GPU string: an Intel or
 * Iris string (and the mobile and Apple parts, which are integrated by
 * construction) caps the pixel ratio at 1.5 and leaves bloom out of the
 * post chain; a discrete GPU gets DPR up to 2 and the bloom. The tier is
 * published as renderer.userData.gpuTier so other units can read it. The
 * lamp's glow is therefore built without bloom: an emissive shade and an
 * additive halo sprite, which bloom only sweetens where it exists.
 *
 * Post is the omr chain cut down: RenderPass into an 8-bit buffer, one
 * EffectPass with mipmap bloom (ADD, pre-tonemap, discrete GPUs only) and
 * a grade that does the single ACES tone-map, a warm vignette and 2% grain.
 * Inside the composer three's renderer-level tone mapping is inert
 * (materials compile with NoToneMapping when they render into a target), so
 * ACES runs exactly once, here, reading the renderer's toneMappingExposure.
 *
 * Every canvas texture is drawn with a seeded generator, so the same
 * `?seed=` paints the same fibres in every frame the reel renders, and
 * nothing in the setting is a function of wall-clock time.
 */

import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
} from 'postprocessing';
import { mulberry32 } from './rng.js';
import { roundedBox, createLamp, createBed, createRoom, createBear, createTrain, LAMP_AT, LAMP_CANDELA } from './props.js';

/* The room's air at dusk: fog, background, and what the far corners of the
   desk sink into. With the lamp switched off the same air goes to night. */
const DUSK = 0x2A1E21;
const NIGHT_AIR = 0x12111F;
/* Light levels with the lamp on (the tuned values below) and off: the key
   and fill drop to a moonlit remainder, the window's cool light comes up a
   little, and the desk's painted pool goes with the lamp. */
const NIGHT = { key: 0.26, fill: 0.12, hemi: 0.24, amb: 0.08, dusk: 0.55, shade: 0.0, floor: 0.2, zone: 0.42 };
const TRAY_KEEP_OUT = { xMin: -2.15, xMax: -1.55, zMin: 0.69, zMax: 1.11 };   // tray.js TRAY_AT, 0.6 x 0.42
/* Measured against the rest poses (tools/snap-scene.html): the landscape
   frame's top edge crosses the table from (-4.3, -1.5) to (2.4, -4.0) and its
   left edge reaches x -4.3; the portrait home pose's bottom edge lands at
   z 3.2. The slab covers all of that with the lean's 0.3 to spare, and its
   far edge sits where the landscape top edge crosses z -2.8 right of centre,
   so the room shows as a wedge in the top-right and nowhere else. */
const TABLE = { xMin: -5.4, xMax: 3.8, zMin: -2.8, zMax: 3.6, thick: 0.14 };
const TILE = 3.6;                 // world units per grain tile: four planks of 0.9 (20 cm)
/* The desk's brightness map, painted into the slab's vertex colours: the
   lamp's pool, full at the base and gone 3 units out, over a softer zone
   round the book and the tray at ZONE, both easing to EDGE at the frame's
   corners. The real point light adds its own gradient on top; this is the
   part a lamp on a dark evening desk would cast that no unshadowed light
   can, the rest of the room being darker than the pool. */
const POOL = { rx: 1.0, rz: 0.9, inner: 0.4, outer: 3.0 };
/* The zone reaches further toward the viewer (rzNear) than away: the
   portrait frame's lower half is table in front of the book, and at the
   symmetric radius it went nearly black under the card. */
const ZONE = { cx: 0.1, cz: 0.05, rx: 1.25, rzFar: 0.95, rzNear: 1.3, inner: 1.2, outer: 3.6, level: 0.76 };
const EDGE = 0.36;

/* ---- grade: ACES, vignette, grain ------------------------------------- */

const gradeFragment = /* glsl */ `
#include <tonemapping_pars_fragment>

uniform float uTime;
uniform float uVignette;
uniform float uGrain;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/* Corners lean into a warm brown rather than black: the dusk of the room. */
const vec3 WARM = vec3(0.118, 0.055, 0.020);

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 color = ACESFilmicToneMapping(inputColor.rgb);

  vec2 fromCenter = uv - 0.5;
  float rad = length(fromCenter) * 1.4142136;
  float vig = smoothstep(0.34, 1.12, rad) * uVignette;
  color = mix(color * (1.0 - vig), WARM, vig * 0.16);

  vec3 disp = pow(max(color, vec3(0.0)), vec3(0.4545));
  float g = hash12(floor(uv * resolution)
                 + vec2(fract(uTime * 0.9273) * 511.0,
                        fract(uTime * 0.5731) * 379.0)) - 0.5;
  disp += g * 2.0 * uGrain * (1.0 - 0.55 * luma(disp));
  color = pow(max(disp, vec3(0.0)), vec3(2.2));

  outputColor = vec4(color, inputColor.a);
}
`;

class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', gradeFragment, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['uTime', new THREE.Uniform(0)],
        ['uVignette', new THREE.Uniform(0.30)],
        ['uGrain', new THREE.Uniform(0.02)],
      ]),
    });
  }
}

/* ---- GPU tier ------------------------------------------------------------ */

function probeGpu(renderer) {
  let name = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
  } catch (err) {
    name = '';
  }
  let tier = 'unknown';
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b|radeon|\bamd\b|arc\(tm\)|intel.*\barc\b/i.test(name)) tier = 'discrete';
  else if (/intel|iris|\buhd\b|mali|adreno|powervr|apple|swiftshader|llvmpipe|videocore/i.test(name)) tier = 'integrated';
  return { tier, name };
}

/* ---- the oak ------------------------------------------------------------- */

/* One tile is TILE world units square and holds four planks, so a plank is
   0.9 units (20 cm) wide. Planks run along the tile's V axis, which the box's
   top face maps to world Z. Grain lines wander with sine terms of integer
   period in V, so the top of the tile meets its bottom without a step; the
   seams sit on the plank boundaries, one of which is the tile edge, so the
   tile wraps in U at a seam. The colour range is the brief's, #8A5A2E to
   #B07A45, each plank a seeded step inside it with a gentle gradient across
   its width (rift oak has no cathedral, only stripe). */
function oakTexture(seed, maxAniso) {
  const size = 1536;
  const planks = 4;
  const pw = size / planks;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed + 202);
  const lo = [0x8A, 0x5A, 0x2E];
  const hi = [0xB0, 0x7A, 0x45];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgb = (v, a = 1) => `rgba(${v[0]},${v[1]},${v[2]},${a})`;

  for (let p = 0; p < planks; p += 1) {
    const x0 = p * pw;
    const base = mix(lo, hi, 0.34 + 0.36 * rnd());
    const flip = rnd() > 0.5;
    const g = ctx.createLinearGradient(x0, 0, x0 + pw, 0);
    g.addColorStop(0, rgb(mix(base, flip ? hi : lo, 0.10)));
    g.addColorStop(0.5, rgb(base));
    g.addColorStop(1, rgb(mix(base, flip ? lo : hi, 0.10)));
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, pw, size);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, pw, size);
    ctx.clip();

    /* Long grain: dark lines and a few pale ones, each a sum of two sines
       of integer period in V. Width and alpha vary line to line. */
    const lines = 30 + Math.floor(rnd() * 12);
    for (let i = 0; i < lines; i += 1) {
      const xc = x0 + 4 + rnd() * (pw - 8);
      const a1 = 3 + rnd() * 10; const k1 = 1 + Math.floor(rnd() * 3); const p1 = rnd();
      const a2 = 1 + rnd() * 3; const k2 = 3 + Math.floor(rnd() * 6); const p2 = rnd();
      const dark = rnd() > 0.26;
      const alpha = dark ? 0.045 + rnd() * 0.10 : 0.03 + rnd() * 0.05;
      ctx.strokeStyle = dark ? `rgba(58,32,14,${alpha.toFixed(3)})` : `rgba(255,226,182,${alpha.toFixed(3)})`;
      ctx.lineWidth = 0.7 + rnd() * 1.7;
      ctx.beginPath();
      for (let y = 0; y <= size; y += 6) {
        const v = y / size;
        const x = xc + a1 * Math.sin(2 * Math.PI * (k1 * v + p1)) + a2 * Math.sin(2 * Math.PI * (k2 * v + p2));
        if (y === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    /* Broad soft bands: the slow change of tone along a rift board. */
    for (let i = 0; i < 3; i += 1) {
      const xc = x0 + rnd() * pw;
      const k = 1 + Math.floor(rnd() * 2); const ph = rnd();
      ctx.strokeStyle = rnd() > 0.5 ? 'rgba(70,40,18,0.04)' : 'rgba(255,220,170,0.035)';
      ctx.lineWidth = 24 + rnd() * 40;
      ctx.beginPath();
      for (let y = 0; y <= size; y += 12) {
        const v = y / size;
        const x = xc + 18 * Math.sin(2 * Math.PI * (k * v + ph));
        if (y === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    /* Open pores: short dark ticks along the grain; silver-grain flecks:
       sparse pale lenses across it. */
    for (let i = 0; i < 1400; i += 1) {
      ctx.fillStyle = `rgba(52,30,14,${(0.04 + rnd() * 0.07).toFixed(3)})`;
      ctx.fillRect(x0 + rnd() * pw, rnd() * size, 1, 3 + rnd() * 9);
    }
    for (let i = 0; i < 40; i += 1) {
      const x = x0 + rnd() * pw; const y = rnd() * size;
      ctx.fillStyle = `rgba(255,232,196,${(0.05 + rnd() * 0.06).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 2 + rnd() * 3, 10 + rnd() * 18, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* Seams: a dark joint with a pale bevel either side, at every plank edge
     including both tile edges so the wrap meets itself. */
  for (let p = 0; p <= planks; p += 1) {
    const x = p * pw;
    ctx.fillStyle = 'rgba(255,228,190,0.11)';
    ctx.fillRect(x - 4, 0, 1, size);
    ctx.fillRect(x + 3, 0, 1, size);
    ctx.fillStyle = 'rgba(36,19,8,0.50)';
    ctx.fillRect(x - 1, 0, 3, size);
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set((TABLE.xMax - TABLE.xMin) / TILE, (TABLE.zMax - TABLE.zMin) / TILE);
  t.anisotropy = Math.min(8, maxAniso);
  return t;
}

const smooth = (a, b, v) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a))); return k * k * (3 - 2 * k); };

/* Vertex colours for the slab. The pool and the zone combine as a soft
   union (one minus the product of what each leaves unlit), so the seam
   between them has no crease. Local box space is centred; add the mesh
   position to get world x, z. */
function paintFalloff(geometry, cx, cz) {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const night = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) {
    const wx = pos.getX(i) + cx;
    const wz = pos.getZ(i) + cz;
    const rl = Math.hypot((wx - LAMP_AT.x) / POOL.rx, (wz - LAMP_AT.z) / POOL.rz);
    const pool = 1 - smooth(POOL.inner, POOL.outer, rl);
    const rb = Math.hypot((wx - ZONE.cx) / ZONE.rx, (wz - ZONE.cz) / (wz > ZONE.cz ? ZONE.rzNear : ZONE.rzFar));
    const zone = ZONE.level * (1 - smooth(ZONE.inner, ZONE.outer, rb));
    const lit = 1 - (1 - pool) * (1 - zone);
    const b = EDGE + (1 - EDGE) * lit;
    colors[i * 3] = b;
    colors[i * 3 + 1] = b;
    colors[i * 3 + 2] = b;
    /* lamp off: no pool, a faint zone from the window, darker edges */
    const n = NIGHT.floor + (NIGHT.zone - NIGHT.floor) * (zone / ZONE.level);
    night[i * 3] = n;
    night[i * 3 + 1] = n;
    night[i * 3 + 2] = n;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.userData.colorDay = geometry.attributes.color;
  geometry.userData.colorNight = new THREE.BufferAttribute(night, 3);
}

/* The slab: a rounded box whose top face carries the oak and whose edges
   are end grain a shade darker. Two materials, two draw calls. */
function createTable(seed, maxAniso) {
  const w = TABLE.xMax - TABLE.xMin;
  const d = TABLE.zMax - TABLE.zMin;
  const cx = (TABLE.xMin + TABLE.xMax) / 2;
  const cz = (TABLE.zMin + TABLE.zMax) / 2;
  const geometry = roundedBox(w, TABLE.thick, d, 0.05, 46, 2, 32);
  paintFalloff(geometry, cx, cz);
  const top = new THREE.MeshStandardMaterial({
    map: oakTexture(seed, maxAniso),
    roughness: 0.55,
    metalness: 0,
    vertexColors: true,
  });
  const edge = new THREE.MeshStandardMaterial({ color: 0x6B4526, roughness: 0.62, metalness: 0, vertexColors: true });
  const mesh = new THREE.Mesh(geometry, [edge, edge, top, edge, edge, edge]);
  mesh.name = 'table';
  mesh.position.set(cx, -TABLE.thick / 2, cz);
  return mesh;
}

/* ---- scene -------------------------------------------------------------- */

export function createScene({ canvas, camera, seed = 7, reduced = false }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  const gpu = probeGpu(renderer);
  const dprCap = gpu.tier === 'integrated' ? 1.5 : 2;
  /* WebGLRenderer has no userData of its own (Object3D does); make the bag. */
  if (!renderer.userData) renderer.userData = {};
  renderer.userData.gpuTier = gpu.tier;
  renderer.userData.gpuName = gpu.name;
  renderer.userData.dprCap = dprCap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  /* 1.9, up from the 1.05 the plan pencilled in: with the KTD9 light values
     and three's physical light units, white paper landed at 0.44 linear
     (sRGB 183) and read grey. This exposure puts it at about 0.85, which is
     paper under a good lamp, and leaves every light at its specified value. */
  renderer.toneMappingExposure = 1.9;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(DUSK);
  /* Fog starts a little past the camera's home distance, which is about
     where the table's far edge is from every rest pose (setFog, called on
     every refit): the whole desk stays clean and the room past its edge
     dissolves into dusk. Offsets rather than multiples: the portrait camera
     sits half again as far away, and a multiple left its bed unfogged. */
  scene.fog = new THREE.Fog(DUSK, 5.4, 8.2);
  function setFog(distance) {
    scene.fog.near = distance + 1.6;
    scene.fog.far = distance + 4.4;
  }

  const key = new THREE.DirectionalLight(0xFFD9A8, 1.6);
  key.position.set(-2.6, 1.7, 3.0);
  /* The fill sits where the closed-book pose looks from, so the cover art
     is lit for the shot that opens the book instead of falling into the
     key's shadow side. */
  const fill = new THREE.DirectionalLight(0xFFE6CB, 0.55);
  fill.position.set(2.8, 2.0, 2.4);
  /* Dusk lavender over oak bounce, a shade under the old blue-over-tan so
     the pages keep their brightness once the window light is added. */
  const hemi = new THREE.HemisphereLight(0xC4C0E6, 0x9A6A3E, 0.64);
  const amb = new THREE.AmbientLight(0xFFE2C4, 0.30);
  /* The window: cool, low, from the far left behind the lamp. It rims the
     stem and the far edge of the desk and barely reaches the pages. */
  const dusk = new THREE.DirectionalLight(0x7C8AD4, 0.35);
  dusk.position.set(-4.5, 2.2, -3.5);
  scene.add(key, fill, hemi, amb, dusk);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const table = createTable(seed, maxAniso);
  scene.add(table);

  const lamp = createLamp(seed);
  scene.add(lamp.group);
  const bear = createBear(seed);
  scene.add(bear);
  const train = createTrain();
  scene.add(train);
  const bed = createBed(seed, maxAniso);
  scene.add(bed);
  const room = createRoom();
  scene.add(room);

  /* Measured on the laptop's Iris Xe at 2160x1350 with GPU timer queries:
     the omr chain (half-float, MSAA 2, 8-level bloom) cost 23.6 ms a frame
     against 7.3 ms for the bare scene; this chain costs 14.1 ms. The three
     savings, in order of size: no multisampling on the composer buffer
     (its resolve was the single largest cost, and at DPR 1.5 and above the
     page edges hold up without it), 8-bit buffers (the library stores them
     sRGB-encoded when the renderer outputs sRGB, so shadows keep their
     precision and nothing bands), and a 5-level bloom chain that starts at
     half resolution. On an integrated GPU the bloom is left out entirely. */
  const composer = new EffectComposer(renderer, {
    multisampling: 0,
    frameBufferType: THREE.UnsignedByteType,
  });
  composer.addPass(new RenderPass(scene, camera));
  const bloom = gpu.tier === 'integrated' ? null : new BloomEffect({
    blendFunction: BlendFunction.ADD,
    mipmapBlur: true,
    luminanceThreshold: 0.72,
    luminanceSmoothing: 0.15,
    intensity: 0.5,
    radius: 0.6,
    levels: 5,
    resolutionScale: 0.5,
  });
  const grade = new GradeEffect();
  composer.addPass(new EffectPass(camera, ...(bloom ? [bloom, grade] : [grade])));
  const uTime = grade.uniforms.get('uTime');

  function setSize(w, h, dpr) {
    /* Re-read on every resize: a hidden pane reports DPR 1 at boot and the
       real value only once it is shown. The reel passes its own ratio so a
       phone-sized composition renders at the video's full resolution. */
    renderer.setPixelRatio(dpr || Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
  }

  function render(time) {
    if (!reduced) uTime.value = time % 64;
    renderer.info.reset();
    composer.render();
  }

  /* The lamp switch. Off is bed time: the bulb, its halo, the shade's glow
     and the painted pool go out together, the room drops to moonlight from
     the window, the air goes to night. A switch is instant, so this is. */
  const DAY = { key: key.intensity, fill: fill.intensity, hemi: hemi.intensity, amb: amb.intensity, dusk: dusk.intensity, shade: lamp.shade.material.emissiveIntensity };
  let lampOn = true;
  function setLamp(on) {
    const next = !!on;
    if (next === lampOn) return false;
    lampOn = next;
    const L = next ? DAY : NIGHT;
    key.intensity = L.key;
    fill.intensity = L.fill;
    hemi.intensity = L.hemi;
    amb.intensity = L.amb;
    dusk.intensity = L.dusk;
    lamp.light.intensity = next ? LAMP_CANDELA : 0;
    lamp.shade.material.emissiveIntensity = L.shade;
    lamp.glow.visible = next;
    const g = table.geometry;
    g.setAttribute('color', next ? g.userData.colorDay : g.userData.colorNight);
    scene.background.set(next ? DUSK : NIGHT_AIR);
    scene.fog.color.set(next ? DUSK : NIGHT_AIR);
    return true;
  }

  return {
    setLamp,
    get lampOn() { return lampOn; },
    renderer,
    scene,
    composer,
    table,
    lamp,
    bear,
    train,
    bed,
    room,
    /* The old names, kept for anything that read them: the ground mesh and
       the prop at the top-left. */
    blanket: table,
    basket: lamp.group,
    bloom,
    gpu,
    trayKeepOut: TRAY_KEEP_OUT,
    lampAt: LAMP_AT,
    lights: { key, fill, hemi, amb, dusk, lamp: lamp.light },
    render,
    setSize,
    setFog,
  };
}
