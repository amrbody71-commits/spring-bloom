/* rng.js — the only source of randomness allowed near a render path.
 *
 * Math.random is banned in this project: the reel is rendered by a
 * deterministic frame-seeking renderer, and any frame that depends on an
 * unseeded random value can never be reproduced. Every texture speckle and
 * every scatter goes through mulberry32 keyed on `?seed=` (default 7), so
 * two loads of the same URL paint the same blanket.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
