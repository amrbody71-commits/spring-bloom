/* clock.js — the one clock. Owns `time` (seconds) for everything animated.
 *
 * Two modes, one value:
 *   live     time advances from requestAnimationFrame, dt clamped to 1/30 so
 *            a stalled tab cannot leap; the loop pauses while the document is
 *            hidden and the time base resets when it comes back.
 *   capture  time is set from outside (`?capture`, `?t=`, or the hf-seek
 *            event the reel renderer fires). Nothing here reads a wall clock.
 *
 * Every animated quantity in the scene is a function of this `time` plus the
 * book's event log, so a seek to any second lands on the right frame. Springs
 * are the one stateful exception and exist only in live mode; the modules
 * that own them step by the `dt` handed to onFrame.
 *
 * frame(dt) steps by an exact amount in either mode and is what the browser
 * pane uses when its requestAnimationFrame is suspended.
 */

/* Two clamps. The step handed to the integrators (springs, damped lean)
   stays at 1/30 so they cannot blow up on a long frame; the clock itself
   advances by the real elapsed time up to MAX_LEAP, because the narration
   audio runs on the sound card's clock and the read-along highlight, a
   function of book time, drifted behind it on every frame that took longer
   than 33 ms (a full-screen window on an integrated GPU). A stalled tab
   still cannot leap: the loop pauses while the document is hidden. */
const MAX_DT = 1 / 30;
const MAX_LEAP = 0.5;

export function createClock({ mode = 'live', onFrame }) {
  const clock = { time: 0, mode, running: false };
  let raf = 0;
  let last = 0;

  function tick(now) {
    raf = 0;
    if (!clock.running) return;
    const raw = (now - last) / 1000;
    const dt = raw > 0 ? Math.min(MAX_DT, raw) : 1 / 60;
    const leap = raw > 0 ? Math.min(MAX_LEAP, raw) : 1 / 60;
    last = now;
    clock.time += leap;
    onFrame(dt, clock.time);
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (mode !== 'live' || clock.running) return;
    clock.running = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    clock.running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /* Step by exactly dt. Works in both modes. */
  function frame(dt = 1 / 60) {
    clock.time += dt;
    onFrame(dt, clock.time);
  }

  /* Jump to an absolute time. dt is 0 on purpose: a seek is not a step, and
     the damped quantities (parallax) must not integrate across it. */
  function renderAt(t) {
    clock.time = t;
    onFrame(0, clock.time);
  }

  if (mode === 'live') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });
  }

  return {
    get time() { return clock.time; },
    set time(v) { clock.time = v; },
    get mode() { return clock.mode; },
    get running() { return clock.running; },
    start,
    stop,
    frame,
    renderAt,
  };
}
