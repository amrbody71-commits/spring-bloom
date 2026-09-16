/* events.js — a tiny emitter whose emit() collects return values.
 *
 * The collecting is the point. Before a page turns, the book emits
 * `beforeTurn` and a listener that needs time first (a later unit folds
 * pop-up layers flat) answers with a delay in seconds; the turn waits for the
 * largest answer. A fire-and-forget emitter would need a second channel for
 * that reply, and this one line makes it unnecessary.
 */

export function createEvents() {
  const lists = new Map();

  function on(name, fn) {
    if (!lists.has(name)) lists.set(name, []);
    lists.get(name).push(fn);
    return () => off(name, fn);
  }

  function off(name, fn) {
    const list = lists.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /* Returns every non-undefined value the listeners returned, in call order.
     Listeners are copied first so one that unsubscribes itself mid-emit does
     not skip its neighbour. */
  function emit(name, payload) {
    const list = lists.get(name);
    const out = [];
    if (!list) return out;
    for (const fn of list.slice()) {
      const r = fn(payload);
      if (r !== undefined) out.push(r);
    }
    return out;
  }

  return { on, off, emit };
}
