/* viewport.js — a window size that is never zero.
 *
 * A hidden or occluded browser pane reports innerWidth and innerHeight as 0.
 * Everything downstream then divides by it: aspect becomes NaN, the camera
 * fit produces NaN poses and the renderer sizes a 0x0 buffer. The failure
 * surfaces far from its cause, and only when nobody is looking at the page,
 * which is exactly when the automated checks run. Copied from
 * lamplight/js/viewport.js, where the same bug was found first.
 *
 * The fallback is a plausible 16:9 desktop so that headless screenshots and
 * stepped frames taken against it mean something.
 */

const FALLBACK_W = 1600;
const FALLBACK_H = 900;

export const vw = () => window.innerWidth || document.documentElement.clientWidth || FALLBACK_W;
export const vh = () => window.innerHeight || document.documentElement.clientHeight || FALLBACK_H;
export const vaspect = () => vw() / vh();
