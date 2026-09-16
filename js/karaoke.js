/* karaoke.js — three class states set from time, never from callbacks.
 *
 * .w is upcoming, .w.is-active the word being spoken, .w.is-spoken already
 * said. The active window for word i is [start_i, start_i+1) from the timing
 * file (starts are already pulled 40 ms early). update(time) asks the
 * narration log where the take is and reclassifies only when the answer
 * changes, so a capture-mode seek to any time lands on the right word and a
 * live frame costs nothing while the same word is sounding. The rule is the
 * caption skin's in the editorial-forest preset, with book time in place of
 * a GSAP timeline.
 *
 * Phases: 'idle' (no take for this spread, or it finished a moment ago),
 * 'reading' (active index i, -1 before the first word), 'done' (every word
 * spoken; held for a second after the take ends, then idle).
 */

import { activeIndex } from './words.js';

const DONE_HOLD = 1.0;   // seconds the finished text stays marked before it clears
const LAST_TAIL = 0.1;   // the last word demotes this long after its end

export function createKaraoke({ api }) {
  let bound = null;
  let phase = 'idle';
  let index = -1;

  function apply(next, i) {
    const { card, els, words, spread } = bound;
    if (next === 'reading' && phase === 'reading' && i === index + 1 && i < els.length) {
      /* The common step: the previous word demotes, the next one lights. */
      if (index >= 0) { els[index].classList.remove('is-active'); els[index].classList.add('is-spoken'); }
      els[i].classList.add('is-active');
    } else {
      for (let j = 0; j < els.length; j += 1) {
        const active = next === 'reading' && j === i;
        const spoken = next === 'done' || (next === 'reading' && j < i);
        els[j].classList.toggle('is-active', active);
        els[j].classList.toggle('is-spoken', spoken);
      }
    }
    if (card) card.classList.toggle('is-reading', next !== 'idle');
    const changed = next === 'reading' && i !== index;
    phase = next;
    index = i;
    if (changed && i >= 0 && i < words.length && api.mode === 'live') {
      const w = words[i];
      api.events.emit('word', { spread, i, text: w.text, start: w.start, end: w.end });
    }
  }

  return {
    /* els[i] is the element for timing word i; words are the timing words. */
    bind({ spread, card, els, words }) {
      bound = { spread, card, els, words: words || [] };
      phase = null;
      index = -1;
      apply('idle', -1);
    },

    unbind() {
      if (bound && bound.card) bound.card.classList.remove('is-reading');
      bound = null;
      phase = 'idle';
      index = -1;
    },

    get bound() { return bound; },
    get phase() { return phase; },
    get index() { return index; },

    update(time) {
      if (!bound || !bound.words.length || !api.narration) return;
      const st = api.narration.stateAt(time);
      let next = 'idle';
      let i = -1;
      if (st.entry && st.spread === bound.spread && !st.stopped) {
        if (st.ended) {
          next = time < st.endAt + DONE_HOLD ? 'done' : 'idle';
        } else {
          next = 'reading';
          i = activeIndex(bound.words, st.position);
          const last = bound.words.length - 1;
          if (i === last && st.position >= bound.words[last].end + LAST_TAIL) { next = 'done'; i = -1; }
          if (i >= bound.els.length) i = bound.els.length - 1;
        }
      }
      if (next === phase && i === index) return;
      apply(next, i);
    },
  };
}
