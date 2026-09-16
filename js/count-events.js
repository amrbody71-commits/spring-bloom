/* count-events.js — the story's counting beats, placed on the clock.
 *
 * The tray itself knows nothing about the story. This module reads
 * assets/data/spreads.json (`count: [{word, occurrence, set}]` and
 * `tap: {layer, adds, max}` per spread) and the word timings, and turns the
 * book's events into tray targets:
 *
 *   narration start   every beat of that spread becomes `tray.set(value, at)`
 *                     where `at` is the narration's start time plus the start
 *                     of the nth occurrence of the beat's word (punctuation
 *                     stripped from both sides, so "“58,”" is the token 58).
 *                     Targets are logged ahead of time, which is what makes a
 *                     capture-mode seek land on the right frame.
 *   narration pause   beats still in the future leave the log and keep their
 *                     remaining offset; resume puts them back from the new
 *                     time. An end or a jump drops whatever has not fired.
 *   jump              the total snaps, with no animation, to the value the
 *                     story has reached by that spread: the last `set` on any
 *                     spread up to and including it (0 before spread 5, 6 from
 *                     spread 5, 58 from spread 8, 399 from spread 11).
 *   tap               on a spread with a `tap` entry, a tap on that layer adds
 *                     `adds`, up to `max` beyond the story's value for the
 *                     spread. A tap's `at` is a point on the page, never a
 *                     time, so taps land at api.time.
 *
 * Timings are fetched once at init for every spread with beats, so a
 * narration start schedules synchronously when they are resident; a start
 * that arrives earlier schedules as soon as they land, at the original time.
 */

const ASSETS = new URL('../assets/', import.meta.url);

const strip = (s) => String(s).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const pad2 = (n) => String(n).padStart(2, '0');

export function createCountEvents(api, tray) {
  const spreads = new Map();    // spread -> { beats, tap }
  const words = new Map();      // spread -> words[] once resident
  const loading = new Map();    // spread -> Promise<words[] | null>
  const pending = new Map();    // spread -> [{ id, at, value }]
  const paused = new Map();     // spread -> { at, beats: [{ value, remaining }] }
  const gen = new Map();        // spread -> generation, bumped by every event
  const missing = [];           // beats whose word was not in the timings
  let order = [];
  let loaded = false;
  let lastJump = null;          // a jump that arrived before the data
  const offs = [];

  function bump(spread) {
    const g = (gen.get(spread) || 0) + 1;
    gen.set(spread, g);
    return g;
  }

  function timingsFor(spread) {
    if (words.has(spread)) return Promise.resolve(words.get(spread));
    if (!loading.has(spread)) {
      const url = new URL(`timings/spread-${pad2(spread)}.json`, ASSETS);
      loading.set(spread, fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          const list = json && Array.isArray(json.words) ? json.words : null;
          if (list) words.set(spread, list);
          return list;
        })
        .catch(() => null));
    }
    return loading.get(spread);
  }

  async function load() {
    const res = await fetch(new URL('data/spreads.json', ASSETS));
    const json = await res.json();
    for (const [k, v] of Object.entries(json.spreads || {})) {
      const n = Number(k);
      if (!Number.isFinite(n)) continue;
      spreads.set(n, {
        beats: Array.isArray(v.count) ? v.count.filter((b) => b && Number.isFinite(b.set)) : [],
        tap: v.tap && v.tap.layer ? v.tap : null,
      });
    }
    order = [...spreads.keys()].sort((a, b) => a - b);
    const fetches = [];
    for (const n of order) if (spreads.get(n).beats.length) fetches.push(timingsFor(n));
    await Promise.all(fetches);
    loaded = true;
    if (lastJump) {
      const { spread, t } = lastJump;
      lastJump = null;
      tray.set(storyValueAt(spread), t, { snap: true });
    }
  }
  const ready = load().catch(() => { loaded = true; });

  /* The value the story has reached by spread s: the last beat on any spread
     up to and including s. */
  function storyValueAt(s) {
    let v = 0;
    for (const n of order) {
      if (n > s) break;
      for (const b of spreads.get(n).beats) v = b.set;
    }
    return v;
  }
  const storyValueBefore = (s) => storyValueAt(s - 1);

  function findWord(list, token, occurrence = 1) {
    const want = strip(token);
    let seen = 0;
    for (const w of list) {
      if (strip(w.text) !== want) continue;
      seen += 1;
      if (seen === occurrence) return w;
    }
    return null;
  }

  function place(spread, list, t0) {
    const info = spreads.get(spread);
    const out = [];
    for (const beat of info.beats) {
      const w = findWord(list, beat.word, beat.occurrence || 1);
      if (!w) { missing.push({ spread, word: beat.word }); continue; }
      const at = t0 + w.start;
      out.push({ id: tray.set(beat.set, at), at, value: beat.set });
    }
    pending.set(spread, out);
  }

  function schedule(spread, t0) {
    const info = spreads.get(spread);
    if (!info || !info.beats.length) return;
    const g = bump(spread);
    if (words.has(spread)) { place(spread, words.get(spread), t0); return; }
    timingsFor(spread).then((list) => {
      if (!list || gen.get(spread) !== g) return;
      place(spread, list, t0);
    });
  }

  /* Drop every beat of `spread` that has not fired by `now`. */
  function cancel(spread, now = api.time) {
    bump(spread);
    const list = pending.get(spread);
    if (list) for (const b of list) if (b.at > now) tray.remove(b.id);
    pending.delete(spread);
    paused.delete(spread);
  }

  function pause(spread, tp) {
    bump(spread);
    const list = pending.get(spread) || [];
    const keep = [];
    for (const b of list) {
      if (b.at <= tp) continue;
      tray.remove(b.id);
      keep.push({ value: b.value, remaining: b.at - tp });
    }
    pending.delete(spread);
    if (keep.length) paused.set(spread, { at: tp, beats: keep });
    else paused.delete(spread);
  }

  function resume(spread, tr) {
    bump(spread);
    const p = paused.get(spread);
    if (!p) return;
    paused.delete(spread);
    const out = [];
    for (const b of p.beats) {
      const at = tr + b.remaining;
      out.push({ id: tray.set(b.value, at), at, value: b.value });
    }
    pending.set(spread, out);
  }

  function onNarration(e) {
    if (!e) return;
    const spread = Number(e.spread);
    if (!Number.isFinite(spread)) return;
    const at = Number.isFinite(e.at) ? e.at : api.time;
    if (e.state === 'start') { cancel(spread, at); schedule(spread, at); }
    else if (e.state === 'pause') pause(spread, at);
    else if (e.state === 'resume') resume(spread, at);
    else if (e.state === 'end') cancel(spread, at);
  }

  function onJump(e) {
    const spread = Number(e && e.spread);
    if (!Number.isFinite(spread)) return;
    const t = api.time;
    for (const s of [...new Set([...pending.keys(), ...paused.keys()])]) cancel(s, t);
    if (!loaded) { lastJump = { spread, t }; return; }
    tray.set(storyValueAt(spread), t, { snap: true });
  }

  function onTap(e) {
    if (!e) return;
    const spread = Number(e.spread);
    const info = spreads.get(spread);
    if (!info || !info.tap || info.tap.layer !== e.layer) return;
    const cap = storyValueAt(spread) + (Number(info.tap.max) || 0);
    const t = api.time;
    const cur = tray.totalAt(t);
    if (cur >= cap) return;
    tray.add(Math.min(Number(info.tap.adds) || 1, cap - cur), t);
  }

  offs.push(api.events.on('narration', onNarration));
  offs.push(api.events.on('jump', onJump));
  offs.push(api.events.on('tap', onTap));

  return {
    ready,
    storyValueAt,
    storyValueBefore,
    beats: (s) => (spreads.get(Number(s)) || { beats: [] }).beats,
    tapConfig: (s) => (spreads.get(Number(s)) || { tap: null }).tap,
    pending: () => [...pending.entries()].map(([spread, list]) => ({ spread, beats: list.map((b) => ({ ...b })) })),
    missing,
    get loaded() { return loaded; },
    dispose() { for (const off of offs) off(); offs.length = 0; },
  };
}
