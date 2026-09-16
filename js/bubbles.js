/* bubbles.js — speech bubbles: a quoted line leaves the narrator's box and
 * pops out of the character who says it.
 *
 * card.js finds the quotes in each text box (see its segments) and hands the
 * words here as DOM elements; they are the same `.w` elements the karaoke
 * highlights and the reveal animates, moved into a bubble rather than copied,
 * so a spoken word lights up wherever it lives. Who speaks comes from
 * assets/data/speakers.json, one keyword per quote in story order, matched
 * against the spread's layer names (zade matches "Aliya and Zade").
 *
 * A bubble hangs above and to the side of its speaker's head: the cut-out's
 * top centre, projected every frame with the camera pose about to be drawn,
 * so it rides the orbit, the zoom and the hop. It waits for the cut-out to
 * stand up, stays clear of the reading panel and the frame's edges, and
 * fades with the first of its words. Everything is a function of book time.
 */

import * as THREE from 'three';

const GAP = 22;           // px from the head to the bubble's near corner
const EDGE = 8;
const MAX_W = 250;
const MIN_LAYER_P = 0.6;  // the cut-out must be mostly up before the bubble shows
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export function createBubbles({ api, container, onWordTap }) {
  const root = document.createElement('div');
  root.className = 'bubbles';
  root.hidden = true;
  container.appendChild(root);

  const pool = [];
  let groups = [];       // [{ speaker, words, first, el, text }]
  let spread = null;
  const head = new THREE.Vector3();

  function bubbleEl(i) {
    if (!pool[i]) {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.innerHTML = '<div class="bubble__text"></div><i class="bubble__tail"></i>';
      root.appendChild(b);
      pool[i] = b;
    }
    return pool[i];
  }

  /* The layer that speaks: an id first, then a name that carries the word. */
  function layerFor(keyword) {
    const e = api.popup && api.popup.entry ? api.popup.entry(spread) : null;
    if (!e || !e.layers) return null;
    if (e.byId && e.byId.has(keyword)) return e.byId.get(keyword);
    const k = keyword.toLowerCase();
    return e.layers.find((l) => String(l.name || '').toLowerCase().includes(k))
      || e.layers.find((l) => String(l.id || '').toLowerCase().includes(k))
      || null;
  }

  /* Where the head is on a cut-out: the topmost opaque row of its alpha,
     read once from the texture's image (a box is often taller than the
     figure in it, and a bubble hung from the box's top floats in the air).
     In local plane units: x across from the centre, y up from the centre. */
  const probe = document.createElement('canvas');
  function headOf(L) {
    if (L.headLocal) return L.headLocal;
    const geo = L.mesh.geometry && L.mesh.geometry.parameters;
    const w = geo ? geo.width : 0.5;
    const h = geo ? geo.height : 0.5;
    let u = 0.5;
    let v = 0.08;
    const img = L.mesh.material && L.mesh.material.map ? L.mesh.material.map.image : null;
    const iw = img ? (img.naturalWidth || img.width) : 0;
    const ih = img ? (img.naturalHeight || img.height) : 0;
    if (iw && ih) {
      try {
        const pw = 48;
        const ph = Math.max(1, Math.round(pw * ih / iw));
        probe.width = pw; probe.height = ph;
        const ctx = probe.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, pw, ph);
        ctx.drawImage(img, 0, 0, pw, ph);
        const a = ctx.getImageData(0, 0, pw, ph).data;
        let found = false;
        for (let y = 0; y < ph && !found; y += 1) {
          let sum = 0; let n = 0;
          for (let x = 0; x < pw; x += 1) { if (a[(y * pw + x) * 4 + 3] > 110) { sum += x; n += 1; } }
          if (n) { found = true; u = (sum / n + 0.5) / pw; v = y / ph; }
        }
      } catch (err) { /* a cross-origin image; the box top will do */ }
    }
    L.headLocal = { x: (u - 0.5) * w, y: (0.5 - v) * h };
    return L.headLocal;
  }

  function set(s, next) {
    spread = s;
    groups = (next || []).slice(0, 2).map((g, i) => {
      const el = bubbleEl(i);
      const text = el.querySelector('.bubble__text');
      text.textContent = '';
      g.words.forEach((w, j) => {
        if (j > 0) text.appendChild(document.createTextNode(' '));
        text.appendChild(w);
      });
      el.hidden = true;
      el.style.opacity = '0';
      return { ...g, el, text, layer: null };
    });
    for (let i = groups.length; i < pool.length; i += 1) { pool[i].hidden = true; pool[i].querySelector('.bubble__text').textContent = ''; }
    root.hidden = groups.length === 0;
  }

  function clear() { set(null, []); }

  /* ctx: { visible, revealAt, plan, boxStart, away } from the card. */
  function update(time, ctx) {
    if (!groups.length) return;
    const show = !!(ctx && ctx.visible && !ctx.away);
    if (!show) { for (const g of groups) if (!g.el.hidden) g.el.hidden = true; return; }
    const cam = api.camera;
    const W = api.vw();
    const H = api.vh();
    const slot = api.ui && api.ui.cardSlot ? api.ui.cardSlot() : null;
    const xMax = slot ? Math.min(W, slot.left) - EDGE : W - EDGE;
    const placed = [];
    groups.forEach((g, gi) => {
      if (!g.layer || g.layer.spread !== spread) g.layer = layerFor(g.speaker);
      const L = g.layer;
      const up = !!(L && L.mesh && L.textured !== false && L.p >= MIN_LAYER_P);
      if (!up) { if (!g.el.hidden) g.el.hidden = true; return; }
      const hl = headOf(L);
      head.set(hl.x, hl.y, 0);
      L.mesh.localToWorld(head).project(cam);
      if (head.z > 1) { if (!g.el.hidden) g.el.hidden = true; return; }
      const ax = (head.x + 1) * 0.5 * W;
      const ay = (1 - head.y) * 0.5 * H;
      if (g.el.hidden) g.el.hidden = false;
      const maxW = Math.min(MAX_W, Math.max(140, xMax - 2 * EDGE));
      if (g.lastMaxW !== maxW) { g.lastMaxW = maxW; g.el.style.maxWidth = `${maxW}px`; }
      const w = g.el.offsetWidth;
      const h = g.el.offsetHeight;
      /* to the right of the head when there is room, else to the left */
      let right = ax + GAP + w <= xMax;
      let x = right ? ax + GAP : ax - GAP - w;
      if (x < EDGE) { x = EDGE; right = true; }
      let y = ay - GAP - h;
      if (y < EDGE) y = EDGE;
      /* two bubbles from the same spot stack instead of overlapping */
      for (const p of placed) {
        if (x < p.x + p.w + 6 && x + w + 6 > p.x && y < p.y + p.h + 6 && y + h + 6 > p.y) y = p.y + p.h + 10;
      }
      placed.push({ x, y, w, h });
      g.el.classList.toggle('is-left', !right);
      /* the tail points from the bubble's near bottom corner at the head */
      const tx = clamp(ax - x, 14, w - 14);
      g.el.style.setProperty('--tail-x', `${tx.toFixed(0)}px`);
      const transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      if (g.lastTransform !== transform) { g.lastTransform = transform; g.el.style.transform = transform; }
      /* fade with the first word's reveal, and with the card's own fade */
      let op = 1;
      if (ctx.plan && Number.isFinite(ctx.revealAt)) {
        const k = time - ctx.revealAt;
        const i = Math.max(0, g.first - (ctx.boxStart || 0));
        op = easeOutCubic(clamp01((k - i * ctx.plan.stagger) / Math.max(0.001, ctx.plan.rise)));
      }
      const opacity = op.toFixed(3);
      if (g.lastOpacity !== opacity) { g.lastOpacity = opacity; g.el.style.opacity = opacity; }
    });
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button.w');
    if (b && root.contains(b) && onWordTap) onWordTap(b);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target.closest('button')) e.stopPropagation();
  });

  return { set, clear, update, element: root, get count() { return groups.length; } };
}
