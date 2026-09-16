/* words.js — pure helpers for the story card and narration: the whitespace
 * tokeniser that mirrors the timing files, link matching against
 * spreads.json, a syllable splitter for the word card, the karaoke index
 * search, the word-slice window and the reveal plan.
 *
 * No DOM, no time, no state: every function here is a function of its
 * inputs, so the card, the karaoke and the probe page can all trust the
 * same answers.
 */

export const pad2 = (n) => String(n).padStart(2, '0');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => clamp(v, 0, 1);
export const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
export const easeOutBack = (k) => {
  const c = 1.70158;
  const s = c + 1;
  const x = k - 1;
  return 1 + s * x * x * x + c * x * x;
};

/* Whitespace tokens, the rule the timing files were generated with (Python's
   str.split()): any run of whitespace separates, empty tokens drop. Word i on
   the card is word i in assets/timings/spread-NN.json. */
export function tokenise(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean);
}

/* The bare word: outer punctuation and quotes stripped, inner ones kept
   ("“Hello" -> "Hello", "party?”" -> "party", "Al-Jarrah" stays). */
const OUTER = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
export const bare = (token) => String(token ?? '').replace(OUTER, '');
export const normalise = (token) => bare(token).toLowerCase();

/* Which scene layer a token flies to, from spreads.json `links`
   ({ word: {layer, at?} }). Exact match on the bare word first, then a
   case-insensitive one so "Fox" at a sentence start still finds "fox". */
export function linkFor(links, token) {
  if (!links) return null;
  const b = bare(token);
  if (!b) return null;
  if (Object.prototype.hasOwnProperty.call(links, b)) return links[b];
  const low = b.toLowerCase();
  for (const key of Object.keys(links)) if (key.toLowerCase() === low) return links[key];
  return null;
}

/* ---- syllables ---------------------------------------------------------- */

const VOWEL = 'aeiou';
const BLENDS = new Set([
  'bl', 'br', 'ch', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'ph', 'pl', 'pr',
  'qu', 'sc', 'sh', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'th', 'tr', 'tw',
  'wh', 'wr',
]);
export const MIDDLE_DOT = '·';
const isLetter = (ch) => /\p{L}/u.test(ch);

/* A vowel-group heuristic, enough for a picture book: vowel runs are nuclei
   (y after a consonant counts), a final silent e drops unless it is a
   consonant-le, a voiced -ed or a sibilant -es, and the consonants between
   two nuclei split before a single consonant (after an x), between a pair,
   and before a blend in a longer run. "man·groves", "fla·min·gos",
   "A·li·ya", "rid·dle", "ox·y·gen". Returns the original characters cut
   into parts; punctuation and hyphens ride along untouched. */
export function syllableParts(word) {
  const chars = Array.from(String(word ?? ''));
  const idx = [];
  const letters = [];
  chars.forEach((c, i) => { if (isLetter(c)) { idx.push(i); letters.push(c); } });
  if (letters.length < 4) return [chars.join('')];
  const low = letters.map((c) => c.toLowerCase());
  const isV = low.map((c, i) => (VOWEL.includes(c) ? true : (c === 'y' && i > 0 && !VOWEL.includes(low[i - 1]))));

  const groups = [];
  for (let i = 0; i < low.length;) {
    if (!isV[i]) { i += 1; continue; }
    let j = i + 1;
    while (j < low.length && isV[j]) j += 1;
    groups.push([i, j]);
    i = j;
  }

  if (groups.length > 1) {
    const [s, e] = groups[groups.length - 1];
    const tail = low.slice(e).join('');
    if (e - s === 1 && low[s] === 'e' && (tail === '' || tail === 's' || tail === 'd') && s > 0 && !isV[s - 1]) {
      const prev = low[s - 1];
      const syllabicLe = prev === 'l' && s >= 2 && !isV[s - 2];
      const voicedEd = tail === 'd' && (prev === 't' || prev === 'd');
      const pair = s >= 2 ? low.slice(s - 2, s).join('') : '';
      const sibilantEs = tail === 's' && ('sxz'.includes(prev) || pair === 'ch' || pair === 'sh');
      if (!syllabicLe && !voicedEd && !sibilantEs) groups.pop();
    }
  }
  if (groups.length < 2) return [chars.join('')];

  const cuts = [];
  for (let g = 1; g < groups.length; g += 1) {
    const cStart = groups[g - 1][1];
    const cEnd = groups[g][0];
    const n = cEnd - cStart;
    let cut;
    if (n === 0) cut = cEnd;
    else if (n === 1) cut = low[cStart] === 'x' ? cEnd : cStart;
    else if (n === 2) cut = BLENDS.has(low.slice(cStart, cEnd).join('')) ? cStart : cStart + 1;
    else cut = BLENDS.has(low.slice(cEnd - 2, cEnd).join('')) ? cEnd - 2 : cStart + 1;
    cuts.push(cut);
  }

  const parts = [];
  let from = 0;
  for (const cut of cuts) {
    const at = idx[cut];
    /* A hyphen or apostrophe already separates; no dot next to it. */
    if (at <= from || !isLetter(chars[at - 1])) continue;
    parts.push(chars.slice(from, at).join(''));
    from = at;
  }
  parts.push(chars.slice(from).join(''));
  return parts;
}

export const syllabify = (word) => syllableParts(word).join(MIDDLE_DOT);
export const syllableCount = (word) => syllableParts(word).length;

/* ---- karaoke, slices, reveal ------------------------------------------- */

/* Index of the word whose start is the last at or before `position`, -1
   before the first. The active window for word i is [start_i, start_i+1). */
export function activeIndex(words, position) {
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= position) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/* One word out of the take: 60 ms either side, clamped to the take. */
export const SAY_PAD = 0.06;
export function sliceFor(words, i, duration) {
  const w = words[i];
  if (!w) return null;
  const offset = Math.max(0, w.start - SAY_PAD);
  const end = Math.min(Number.isFinite(duration) ? duration : Infinity, w.end + SAY_PAD);
  return { offset, end, duration: Math.max(0.05, end - offset) };
}

/* Staggered reveal: 22 ms per word, a 260 ms rise each, and the stagger
   shrinks so the whole reveal never exceeds 1.5 s (90 words would take 2.2 s
   otherwise), which keeps it under the 1.6 s the narration waits. */
export const REVEAL_RISE = 0.26;
export const REVEAL_STAGGER = 0.022;
export const REVEAL_CAP = 1.5;
export function revealPlan(n) {
  const count = Math.max(1, n | 0);
  const stagger = count > 1 ? Math.min(REVEAL_STAGGER, (REVEAL_CAP - REVEAL_RISE) / (count - 1)) : 0;
  return { rise: REVEAL_RISE, stagger, total: REVEAL_RISE + stagger * (count - 1) };
}

/* How many card tokens the timing file covers. Story spreads must match
   exactly (the assertion behind "no highlight rather than a wrong one"). The
   title take covers only a prefix of the title card, since the publisher
   line is unspoken, so a prefix whose words agree is accepted when asked. */
export function matchTimings(tokens, timingWords, { prefix = false } = {}) {
  if (!timingWords || !timingWords.length || !tokens) return 0;
  if (timingWords.length === tokens.length) return tokens.length;
  if (!prefix || timingWords.length > tokens.length) return 0;
  for (let i = 0; i < timingWords.length; i += 1) {
    if (normalise(tokens[i]) !== normalise(timingWords[i].text)) return 0;
  }
  return timingWords.length;
}
