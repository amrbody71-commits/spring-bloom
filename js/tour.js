/* tour.js — a scripted run of the book, the same one in both modes.
 *
 * A tour is a list of timed events (`reel/tour.json`). In live mode it is an
 * autopilot: each event fires when book time passes it, through the very same
 * calls a reader's taps make, so the recording can never drift from the site.
 * In capture mode the reel composition seeks time from outside; events are
 * applied in order as time advances, and a seek backwards resets the book and
 * replays from the start, because every module keeps its state as a log of
 * timed entries and can be rebuilt from time zero.
 *
 * Events (all have `t` in seconds):
 *   openCover                       lift the cover
 *   next | prev                     turn a page
 *   read {spread?}                  start narration (api.narration)
 *   pause                           pause narration
 *   tapWord {spread, text, n?}      tap the nth occurrence of a word on the card
 *   tapLayer {spread, layer}        tap a standing layer
 *   focus {spread, layer, at?}      camera focus without a tap
 *   unfocus
 *   pointerTo {x, y, over?}         move the drawn pointer (screen fractions) over `over` seconds
 *   click                           pointer press animation only
 *   count {set}                     force the tray (rarely needed; the story does it)
 *   endCard {show}                  show or hide the end card (capture.js)
 */

export function createTour(api, events) {
  const list = [...events].sort((a, b) => a.t - b.t);
  let applied = 0;
  let lastTime = -1;

  function reset() {
    api.book.reset?.();
    api.narration?.stop?.();
    api.camera.release?.();
    api.tray?.set?.(0, api.time);
    applied = 0;
  }

  function fire(e) {
    switch (e.do) {
      case 'openCover': api.book.openCover(); break;
      case 'next': api.turn.next(); break;
      case 'prev': api.turn.prev(); break;
      case 'read': api.narration?.play?.(e.spread); break;
      case 'pause': api.narration?.pause?.(); break;
      case 'tapWord': {
        const i = api.card?.indexOf?.(e.spread ?? api.book.spread, e.text, e.n ?? 1);
        if (i != null && i >= 0) api.card?.tap?.(i);
        break;
      }
      case 'tapLayer': {
        /* The same three things a real tap on a layer does (labels.js):
           the tap event, a sparkle burst at the layer, and a focus. */
        const s = e.spread ?? api.book.spread;
        const L = (api.popup?.layers?.(s) || []).find((x) => x.id === e.layer);
        if (!L) break;
        const at = e.at || (L.foot ? [L.foot[0], L.foot[1]] : undefined);
        api.events.emit('tap', { spread: s, layer: L.id, name: L.name, at });
        if (L.mesh && api.popup.burst) api.popup.burst(L.mesh.getWorldPosition(new L.mesh.position.constructor()), api.time);
        if (e.focus !== false) api.events.emit('focus', { spread: s, layer: L.id, at, name: L.name, source: 'layer' });
        break;
      }
      case 'focus': api.events.emit('focus', { spread: e.spread ?? api.book.spread, layer: e.layer, at: e.at, name: e.name, source: 'tour' }); break;
      case 'unfocus': api.events.emit('unfocus', {}); break;
      case 'count': api.tray?.set?.(e.set, api.time); break;
      case 'pointerTo': case 'click': case 'endCard': api.capture?.apply?.(e); break;
      default: break;
    }
  }

  /* Apply every event whose time has passed. Call once per frame. */
  function update(time) {
    if (time < lastTime - 1e-6) { reset(); }
    lastTime = time;
    while (applied < list.length && list[applied].t <= time + 1e-6) {
      fire(list[applied]);
      applied += 1;
    }
  }

  return { list, update, reset, get applied() { return applied; } };
}

export async function loadTour(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`tour: ${r.status}`);
  const j = await r.json();
  return j.events || j;
}
