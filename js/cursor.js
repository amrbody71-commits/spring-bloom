/* cursor.js, the sparkle trail.
 *
 * A 2D canvas over everything (pointer-events: none) lays soft warm-white
 * motes along the pointer path, one every 6 px of travel, each living 0.9 s
 * with a twinkle, drawn additively at low opacity. The OS cursor stays.
 *
 * Two rules from the rest of the project apply here:
 *   The pointer position is written straight from pointermove, and the motes
 *   for a move are laid in the same handler; nothing waits for a frame.
 *   No Math.random. Each mote is seeded through mulberry32 from api.seed and
 *   the path length at which it was laid, so a mote's size, twinkle and
 *   drift are a function of where the pointer went, and its age is book time.
 *
 * Enabled only on a fine pointer that can hover, never in reduced motion,
 * never in capture mode. Drawing happens inside the app's `frame` event when
 * one is emitted, otherwise from a requestAnimationFrame loop of its own.
 */

import { mulberry32 } from './rng.js';

const STEP_PX = 6;
const LIFE_S = 0.9;
const MAX_MOTES = 480;
const MAX_DPR = 2;
const SPRITE_PX = 64;
const HALO_PX = 14;
const HALO_ALPHA = 0.14;
const MOTE_ALPHA = 0.8;

function makeSprite() {
  const c = document.createElement('canvas');
  c.width = SPRITE_PX; c.height = SPRITE_PX;
  const ctx = c.getContext('2d');
  const r = SPRITE_PX / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255, 250, 235, 1)');
  g.addColorStop(0.18, 'rgba(255, 244, 214, 0.85)');
  g.addColorStop(0.45, 'rgba(255, 232, 180, 0.32)');
  g.addColorStop(1, 'rgba(255, 224, 160, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return c;
}

export function init(api) {
  const fine = typeof window.matchMedia === 'function'
    && window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches;
  const enabled = api.mode === 'live' && !api.reduced && fine;
  const motes = [];
  const pointer = { x: NaN, y: NaN, path: 0 };
  const cursor = {
    enabled,
    motes,
    pointer,
    canvas: null,
    draw() {},
    spawnAlong() {},
    get count() { return motes.length; },
  };
  if (!enabled) return cursor;

  const canvas = document.createElement('canvas');
  canvas.id = 'sparkle';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const sprite = makeSprite();
  let dpr = 1;
  let dirty = true;

  function fit() {
    dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    canvas.width = Math.round(api.vw() * dpr);
    canvas.height = Math.round(api.vh() * dpr);
    dirty = true;
  }
  fit();
  window.addEventListener('resize', fit);

  /* ---- laying motes --------------------------------------------------- */

  const last = { x: NaN, y: NaN };
  let carry = 0;

  function spawn(x, y, along) {
    const seed = (Math.imul(api.seed | 0, 0x9E3779B1) ^ Math.round(along * 8)) >>> 0;
    const rnd = mulberry32(seed);
    const m = {
      x: x + (rnd() - 0.5) * 7,
      y: y + (rnd() - 0.5) * 7,
      born: api.time,
      size: 2.4 + rnd() * 3.4,
      freq: 11 + rnd() * 15,
      phase: rnd() * Math.PI * 2,
      vx: (rnd() - 0.5) * 12,
      vy: -3 - rnd() * 12,
    };
    if (motes.length >= MAX_MOTES) motes.shift();
    motes.push(m);
    dirty = true;
  }

  function spawnAlong(x, y) {
    if (!Number.isFinite(last.x)) { last.x = x; last.y = y; return; }
    const dx = x - last.x;
    const dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    let d = STEP_PX - carry;
    while (d <= dist) {
      const t = d / dist;
      spawn(last.x + dx * t, last.y + dy * t, pointer.path + d);
      d += STEP_PX;
    }
    carry = dist - (d - STEP_PX);
    pointer.path += dist;
    last.x = x;
    last.y = y;
  }

  function onMove(e) {
    if (e.pointerType === 'touch') return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    spawnAlong(e.clientX, e.clientY);
    dirty = true;
  }
  function onLeave() {
    pointer.x = NaN; pointer.y = NaN;
    last.x = NaN; last.y = NaN;
    carry = 0;
    dirty = true;
  }
  document.addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onLeave);

  /* ---- drawing -------------------------------------------------------- */

  function draw() {
    const now = api.time;
    let w = 0;
    for (const m of motes) {
      const age = now - m.born;
      if (age >= 0 && age < LIFE_S) motes[w++] = m;
    }
    motes.length = w;
    if (!dirty && !w) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';

    for (const m of motes) {
      const age = now - m.born;
      const k = age / LIFE_S;
      const env = k < 0.1 ? 0.35 + 0.65 * (k / 0.1) : 1 - (k - 0.1) / 0.9;
      const tw = 0.55 + 0.45 * Math.sin(age * m.freq + m.phase);
      const a = MOTE_ALPHA * env * env * tw;
      if (a <= 0.005) continue;
      const r = m.size * (0.8 + 0.4 * tw) * (1 + 0.35 * k);
      const x = m.x + m.vx * age;
      const y = m.y + m.vy * age;
      ctx.globalAlpha = a;
      ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
    }

    if (Number.isFinite(pointer.x)) {
      ctx.globalAlpha = HALO_ALPHA;
      ctx.drawImage(sprite, pointer.x - HALO_PX, pointer.y - HALO_PX, HALO_PX * 2, HALO_PX * 2);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    dirty = w > 0 || Number.isFinite(pointer.x);
  }

  let viaFrame = false;
  api.events.on('frame', () => { viaFrame = true; draw(); });
  const loop = () => { if (viaFrame) return; draw(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  cursor.canvas = canvas;
  cursor.draw = draw;
  cursor.spawnAlong = spawnAlong;
  cursor.fit = fit;
  return cursor;
}
