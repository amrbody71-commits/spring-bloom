/* textures.js — the spread texture pool.
 *
 * Thirty-four page images at 1024x1304 are about 180 MB of GPU memory with
 * mipmaps, and decoding them all before the first frame would hold the book
 * closed for seconds. So the pool keeps only the current spread plus two
 * either side resident (ten textures), loads nearest-first two at a time, and
 * hands every other face a cream placeholder until its image arrives.
 * Textures that fall out of the window are disposed, so turning through the
 * whole book never grows memory.
 *
 * Consumers subscribe to a key such as '04-left' and are called with the
 * texture when it lands and with null when it is disposed. A subscriber that
 * arrives after the texture is already resident is called at once.
 *
 * Asset URLs resolve from this module's own URL, so a page in tools/ that
 * loads the app finds the same files as index.html does.
 */

import * as THREE from 'three';

const ASSETS = new URL('../assets/', import.meta.url);
export const SPREADS = 17;           // 00 title, 01..15 story, 16 activities
const WINDOW = 2;                    // spreads kept either side of the current one
const CONCURRENCY = 2;

export const spreadKey = (n, side) => `${String(n).padStart(2, '0')}-${side}`;

export function createTexturePool({ renderer }) {
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const entries = new Map();          // key -> { texture, subs:Set, loading, url }
  const fixed = new Map();            // url -> Promise<Texture>, never disposed
  let wanted = new Set();
  let queue = [];
  let inFlight = 0;
  /* The reel renders every spread in one sitting and must never wait on a
     download mid-frame, so capture mode widens the window to the whole book
     and nothing is ever released. */
  let windowSize = WINDOW;
  function setKeepAll(on) { windowSize = on ? SPREADS : WINDOW; }

  function prepare(texture) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, maxAniso);
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  function entry(key) {
    if (!entries.has(key)) {
      entries.set(key, {
        texture: null,
        subs: new Set(),
        loading: false,
        url: new URL(`spreads/${key}.webp`, ASSETS).href,
      });
    }
    return entries.get(key);
  }

  function pump() {
    while (inFlight < CONCURRENCY && queue.length) {
      const key = queue.shift();
      const e = entries.get(key);
      if (!e || e.texture || e.loading || !wanted.has(key)) continue;
      e.loading = true;
      inFlight += 1;
      loader.load(
        e.url,
        (texture) => {
          inFlight -= 1;
          e.loading = false;
          if (!wanted.has(key)) {
            texture.dispose();
          } else {
            e.texture = prepare(texture);
            for (const fn of e.subs) fn(e.texture);
          }
          pump();
        },
        undefined,
        () => {
          /* A missing file leaves the cream placeholder in place; the pool
             stays quiet so a single bad asset cannot fill the console. */
          inFlight -= 1;
          e.loading = false;
          pump();
        },
      );
    }
  }

  function subscribe(key, fn) {
    const e = entry(key);
    e.subs.add(fn);
    if (e.texture) fn(e.texture);
    return () => e.subs.delete(fn);
  }

  /* Set the window around `spread` (and optionally a second spread the book
     is turning toward). Nearest images load first; everything outside the
     window is released. */
  function want(spread, toward = spread) {
    const lo = Math.max(0, Math.min(spread, toward) - windowSize);
    const hi = Math.min(SPREADS - 1, Math.max(spread, toward) + windowSize);
    const next = new Set();
    const order = [];
    for (let d = 0; d <= hi - lo; d += 1) {
      for (const n of [spread + d, spread - d]) {
        if (n < lo || n > hi) continue;
        for (const side of ['right', 'left']) {
          const key = spreadKey(n, side);
          if (next.has(key)) continue;
          next.add(key);
          order.push(key);
        }
      }
    }
    for (const [key, e] of entries) {
      if (next.has(key) || !e.texture) continue;
      e.texture.dispose();
      e.texture = null;
      for (const fn of e.subs) fn(null);
    }
    wanted = next;
    queue = order.filter((key) => !entry(key).texture);
    pump();
  }

  /* Resolves once every listed key is resident. Used by boot to know when
     the first spread can be shown, never to block the first frame. */
  function ready(keys) {
    return Promise.all(keys.map((key) => new Promise((resolve) => {
      const e = entry(key);
      if (e.texture) { resolve(e.texture); return; }
      const off = subscribe(key, (tex) => { if (tex) { off(); resolve(tex); } });
    })));
  }

  /* Cover art and other textures that live for the whole session. */
  function load(relative) {
    const url = new URL(relative, ASSETS).href;
    if (!fixed.has(url)) {
      fixed.set(url, new Promise((resolve, reject) => {
        loader.load(url, (t) => resolve(prepare(t)), undefined, reject);
      }));
    }
    return fixed.get(url);
  }

  function resident() {
    const out = [];
    for (const [key, e] of entries) if (e.texture) out.push(key);
    return out;
  }

  /* Resolves when nothing is queued or in flight. For checks and the reel;
     never awaited in a render path. */
  function idle() {
    return new Promise((resolve) => {
      const check = () => { if (!inFlight && !queue.length) resolve(); else setTimeout(check, 30); };
      check();
    });
  }

  return { subscribe, want, ready, load, resident, idle, prepare, setKeepAll };
}
