/* card.js — the floating story card: label, heading, text, hint, corners,
 * plus the word card that pops next to a tapped word.
 *
 * DOM inside #cards, positioned every frame by projecting the spread's
 * card_anchor (assets/text/NN.json, u/v on the open spread) through
 * book.pageToWorld and the camera, then tilted with a perspective transform
 * from the camera's pitch and yaw so it reads as a card standing about 65
 * degrees off the page while the text stays vector-crisp and tappable. The
 * width follows the page's on-screen width inside fixed bounds (a camera
 * move toward the book grows the card with it), and the card is kept inside
 * the viewport with a 12 px margin, so in portrait it floats wider than the
 * page rather than falling off the screen.
 *
 * Words are buttons tokenised by whitespace exactly like the timing files;
 * the count is asserted against the timings and a mismatch means no
 * highlight rather than a wrong one. The reveal (22 ms stagger, 260 ms rise,
 * capped at 1.5 s) and the card's fade are functions of time from the
 * settle, so a capture-mode seek lands mid-reveal correctly. Hidden on
 * turnStart, shown on settle; the title spread carries the credit line and a
 * Read to me button; the activities spread shows its heading and opening
 * paragraph only.
 */

import * as THREE from 'three';
import { init as initNarration, frameHook, hasTake, WORD_CARD_LIFE } from './narration.js';
import { createKaraoke } from './karaoke.js';
import {
  tokenise, bare, linkFor, syllableParts, revealPlan, matchTimings, pad2,
  clamp, clamp01, easeOutCubic, easeOutBack, MIDDLE_DOT,
} from './words.js';
import { COVER_S } from './book.js';
import { createBubbles } from './bubbles.js';

const ASSETS = new URL('../assets/', import.meta.url);
const OPEN_QUOTE = /^[“"]/;
const CLOSE_QUOTE = /[”"][^\w]*$/;
const STORY_COUNT = 15;
const LAST_SPREAD = 16;
const TITLE_SUBTITLE = 'A math adventure story';
const TITLE_CREDIT = 'By Sadia Mir and Summer Al-Jarrah Bateiha. Illustrated by Inna Ogando. Published by Hamad Bin Khalifa University Press, 2019.';
const HINT_TEXT = 'Tap a word to hear it';
const CTA_PLAY = 'Read to me';
const CTA_PAUSE = 'Pause';

const DEG = Math.PI / 180;
const LEAN = 25 * DEG;       // the card leans 25 degrees back from vertical: 65 off the page
const TILT_GAIN = 0.6;       // how much of the camera's angle the tilt shows
const RX_MIN = 4;            // degrees; the keystone never fully flattens
const RX_MAX = 18;
const RY_MAX = 14;
const PERSPECTIVE = 1400;    // px
const MARGIN = 12;           // px kept between the card and the viewport edge
const CARD_MIN = 250;        // px, or the viewport less margins when narrower
const CARD_MAX = 360;
const CARD_OF_PAGE = 0.68;   // card width as a share of the page's on-screen width
const BOX_WORDS = 34;        // a box holds at most this many words
const PORTRAIT_BAR = 172;    // px the stacked bottom bar takes on a phone
const PORTRAIT_CARD_H = 0.36; // share of the frame the reading panel may take on a phone
const FADE = 0.22;           // s, the card's own fade at settle
const WORD_CARD_POP = 0.18;  // s

/* Per-side nudges of the anchor in u/v, tuned in the pane so the card
   keeps off the standing characters (the anchor is the text box centre). */
export const OFFSET = {
  left: { du: 0, dv: 0 },
  right: { du: 0, dv: 0 },
};

export function init(api) {
  if (api.card) return api.card;
  if (!api.narration) api.narration = initNarration(api);
  const narration = api.narration;
  const { events } = api;
  const container = document.getElementById('cards') || document.body;
  const karaoke = createKaraoke({ api });

  /* ---- data ----------------------------------------------------------- */

  const texts = new Map();
  const layerSets = new Map();
  const pendingJson = new Map();
  let spreadsData = null;

  function fetchJson(url) {
    if (!pendingJson.has(url)) {
      pendingJson.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    }
    return pendingJson.get(url);
  }
  function loadText(s) {
    if (texts.has(s)) return Promise.resolve(texts.get(s));
    return fetchJson(new URL(`text/${pad2(s)}.json`, ASSETS).href).then((d) => { texts.set(s, d); return d; });
  }
  function loadSpreads() {
    if (spreadsData) return Promise.resolve(spreadsData);
    return fetchJson(new URL('data/spreads.json', ASSETS).href).then((d) => { spreadsData = d; return d; });
  }
  /* Who says each quoted line (assets/data/speakers.json); a spread with no
     entry keeps its quotes in the narrator's box. Loaded with the rest, and
     harmless if it lands late: the next box change picks it up. */
  let speakers = null;
  fetchJson(new URL('data/speakers.json', ASSETS).href).then((d) => { speakers = d; });
  /* Layer names for the focus payload. Only the story spreads have a
     layers folder; asking for the others would log a 404. */
  function loadLayers(s) {
    if (s < 1 || s > STORY_COUNT) return Promise.resolve(null);
    if (layerSets.has(s)) return Promise.resolve(layerSets.get(s));
    return fetchJson(new URL(`layers/${pad2(s)}/layers.json`, ASSETS).href).then((d) => { layerSets.set(s, d); return d; });
  }
  function cachedAll(s) {
    if (!texts.has(s) || !spreadsData) return null;
    if (hasTake(s) && !narration.timings(s)) return null;
    if (s >= 1 && s <= STORY_COUNT && !layerSets.has(s)) return null;
    return [texts.get(s), spreadsData, narration.timings(s), layerSets.get(s) || null];
  }
  function ensure(s) {
    return Promise.all([loadText(s), loadSpreads(), narration.loadTimings(s), loadLayers(s)]);
  }
  loadSpreads();
  for (let s = 0; s <= LAST_SPREAD; s += 1) { loadText(s); loadLayers(s); }

  /* ---- DOM ------------------------------------------------------------ */

  const el = document.createElement('div');
  el.className = api.mode === 'live' ? 'card live-anim' : 'card';
  el.hidden = true;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Story text');
  el.innerHTML = [
    '<i class="card__corner card__corner--tl"></i>',
    '<i class="card__corner card__corner--tr"></i>',
    '<i class="card__corner card__corner--bl"></i>',
    '<i class="card__corner card__corner--br"></i>',
    '<div class="card__label"></div>',
    '<h2 class="card__heading"></h2>',
    '<p class="card__subtitle" hidden></p>',
    '<div class="card__text"></div>',
    '<p class="card__credit" hidden></p>',
    '<div class="card__foot"><span class="card__hint"></span>',
    `<button type="button" class="card__cta" hidden>${CTA_PLAY}</button>`,
    '<button type="button" class="card__next" hidden>Next</button></div>',
  ].join('');
  container.appendChild(el);

  const pill = document.createElement('div');
  pill.className = 'wordcard';
  pill.hidden = true;
  pill.setAttribute('aria-live', 'polite');
  pill.innerHTML = '<b class="wordcard__word"></b><span class="wordcard__syll" hidden></span>';
  container.appendChild(pill);

  const q = (sel) => el.querySelector(sel);
  const labelEl = q('.card__label');
  const headingEl = q('.card__heading');
  const subtitleEl = q('.card__subtitle');
  const textEl = q('.card__text');
  const creditEl = q('.card__credit');
  const footEl = q('.card__foot');
  const hintEl = q('.card__hint');
  const ctaEl = q('.card__cta');
  const nextEl = q('.card__next');
  const pillWord = pill.querySelector('.wordcard__word');
  const pillSyll = pill.querySelector('.wordcard__syll');
  const bubbles = createBubbles({ api, container, onWordTap: (b) => onWordTap(b) });

  /* Quoted runs in a token stream, as [start, end) index pairs numbered in
     story order; a quote that runs past a box's end carries its number into
     the next box, so a long speech split over two boxes keeps one speaker. */
  /* Does this token close a quote that is open? A one-word quote (“Six,”)
     opens and closes in the same token, so only its tail is checked. */
  const closesQuote = (tok, opensHere) => CLOSE_QUOTE.test(opensHere ? tok.slice(1) : tok);

  function findQuotes(tokens) {
    const out = [];
    let open = null;
    let n = -1;
    tokens.forEach((tok, i) => {
      const opensHere = open === null && OPEN_QUOTE.test(tok);
      if (opensHere) { open = i; n += 1; }
      if (open !== null && closesQuote(tok, opensHere)) {
        out.push({ start: open, end: i + 1, quote: n });
        open = null;
      }
    });
    if (open !== null) out.push({ start: open, end: tokens.length, quote: n });
    return out;
  }

  /* Lay a box's words back into its paragraph, skipping the ones a bubble
     holds. Appending an element moves it, so this also brings words home
     from a bubble when the box changes. */
  function layoutBox(s, box, exclude = null) {
    const p = box.el;
    p.textContent = '';
    let first = true;
    for (let i = box.start; i < box.end; i += 1) {
      const w = s.all[i];
      if (exclude && exclude.has(w)) continue;
      if (!first) p.appendChild(document.createTextNode(' '));
      p.appendChild(w);
      first = false;
    }
  }

  /* The bubbles for box i: its quoted runs grouped by speaker, at most two
     speakers, the rest staying with the narrator. */
  function bubblesFor(s, box) {
    const table = speakers && speakers[pad2(s.spread)];
    if (!table || !box.segments || !box.segments.length) return [];
    const groups = [];
    for (const seg of box.segments) {
      const speaker = table[seg.quote];
      if (!speaker) continue;
      const a = Math.max(seg.start, box.start);
      const b = Math.min(seg.end, box.end);
      if (b <= a) continue;
      const words = s.all.slice(a, b);
      const last = groups[groups.length - 1];
      if (last && last.speaker === speaker) { last.words.push(...words); continue; }
      if (groups.length >= 2) break;
      groups.push({ speaker, words, first: a });
    }
    return groups;
  }

  /* Append tokens as words. Word i (global index) is tappable and part of
     the karaoke when i < tappable; the rest are plain spans. */
  function addWords(parent, tokens, startIndex, tappable, links, out) {
    tokens.forEach((tok, j) => {
      const i = startIndex + j;
      const active = i < tappable;
      const w = document.createElement(active ? 'button' : 'span');
      w.className = 'w';
      if (active) { w.type = 'button'; w.dataset.i = String(i); } else w.classList.add('w--plain');
      if (active && linkFor(links, tok)) w.classList.add('is-link');
      w.textContent = tok;
      if (j > 0) parent.appendChild(document.createTextNode(' '));
      parent.appendChild(w);
      out.push(w);
    });
  }

  let shown = null;
  let showGen = 0;
  let pendingShow = null;
  let lastShow = Promise.resolve(false);
  /* turnStart arrives a frame before the book reports 'turning', so an
     explicit hide holds until the next settle, jump or cover opening. */
  let held = false;

  function build(spread, text, spreads, tm, layers) {
    const info = spreads && spreads.spreads ? spreads.spreads[pad2(spread)] : null;
    const heading = info && info.heading ? info.heading : (spread === 0 ? 'Spring Bloom' : '');
    const links = info && info.links ? info.links : null;
    const all = [];
    const boxes = [];
    let tappable = 0;
    let timingWords = null;

    textEl.textContent = '';
    headingEl.textContent = '';
    subtitleEl.textContent = '';
    creditEl.textContent = '';
    subtitleEl.hidden = true;
    creditEl.hidden = true;
    ctaEl.hidden = true;
    hintEl.hidden = false;
    footEl.hidden = false;
    el.dataset.spread = String(spread);
    el.dataset.page = text.card_anchor && text.card_anchor.page === 'left' ? 'left' : 'right';
    el.classList.toggle('card--title', spread === 0);
    el.classList.toggle('card--end', spread > STORY_COUNT);

    if (spread === 0) {
      labelEl.textContent = 'A pop-up storybook';
      const h = tokenise(heading);
      const s = tokenise(TITLE_SUBTITLE);
      const c = tokenise(TITLE_CREDIT);
      tappable = matchTimings([...h, ...s, ...c], tm && tm.words, { prefix: true });
      addWords(headingEl, h, 0, tappable, links, all);
      subtitleEl.hidden = false;
      addWords(subtitleEl, s, h.length, tappable, links, all);
      creditEl.hidden = false;
      addWords(creditEl, c, h.length + s.length, tappable, links, all);
      hintEl.hidden = true;
      ctaEl.hidden = false;
      timingWords = tappable ? tm.words : null;
    } else if (spread > STORY_COUNT) {
      labelEl.textContent = 'Activities';
      headingEl.textContent = heading;
      const paras = (text.paragraphs || []).filter((p) => p.trim().toLowerCase() !== heading.trim().toLowerCase());
      const p = document.createElement('p');
      addWords(p, tokenise(paras[0] || ''), 0, 0, null, all);
      textEl.appendChild(p);
      footEl.hidden = true;
    } else {
      labelEl.textContent = `Spread ${spread} of ${STORY_COUNT}`;
      headingEl.textContent = heading;
      const tokens = tokenise((text.paragraphs || []).join(' '));
      tappable = matchTimings(tokens, tm && tm.words);
      if (tm && !tappable) {
        console.warn(`card: spread ${spread} has ${tokens.length} words and ${tm.words.length} timings; highlight off`);
      }
      /* The text comes in small boxes, one at a time: a paragraph, or a run
         of sentences when a paragraph is long. The reader steps through them
         with the arrow, and narration steps through them by itself. */
      let k = 0;
      for (const para of text.paragraphs || []) {
        for (const chunk of chunkTokens(tokenise(para), BOX_WORDS)) {
          const p = document.createElement('p');
          p.className = 'card__box';
          addWords(p, chunk, k, tappable, links, all);
          boxes.push({ el: p, start: k, end: k + chunk.length, segments: [] });
          k += chunk.length;
          textEl.appendChild(p);
        }
      }
      /* The quotes, numbered across the whole spread, cut to each box. */
      for (const q of findQuotes(tokens)) {
        for (const box of boxes) {
          if (q.end > box.start && q.start < box.end) box.segments.push(q);
        }
      }
      hintEl.textContent = HINT_TEXT;
      timingWords = tappable ? tm.words : null;
    }
    bubbles.clear();

    const els = all.slice(0, tappable);
    shown = {
      spread,
      anchor: text.card_anchor || { u: 0.75, v: 0.3, page: 'right' },
      links,
      layers,
      heading,
      els,
      all,
      boxes,
      box: -1,
      plan: revealPlan(all.length),
      revealAt: -Infinity,
      applied: null,
      lastW: 0,
      lastFontPx: 0,
    };
    karaoke.bind({ spread, card: el, els, words: timingWords || [] });
    for (const w of all) { w.style.opacity = ''; w.style.transform = ''; }
    nextEl.hidden = !boxes.length;
    if (boxes.length) setBox(0, -Infinity);
  }

  /* Split a paragraph's tokens into boxes of at most `max` words, cutting
     only after a sentence end once a box is past half full. */
  function chunkTokens(tokens, max) {
    const out = [];
    let cur = [];
    let inQuote = false;
    tokens.forEach((tok, i) => {
      cur.push(tok);
      const opensHere = !inQuote && OPEN_QUOTE.test(tok);
      if (opensHere) inQuote = true;
      if (inQuote && closesQuote(tok, opensHere)) inQuote = false;
      const endsSentence = /[.!?][”"’']?$/.test(tok);
      const last = i === tokens.length - 1;
      /* Never cut inside a quote: a speech bubble holds a whole line. */
      const cut = last || (!inQuote && (cur.length >= max || (endsSentence && cur.length >= max * 0.5))) || cur.length >= max * 2;
      if (cut) { out.push(cur); cur = []; }
    });
    return out.filter((c) => c.length);
  }

  function boxIndexOf(wordIndex) {
    const s = shown;
    if (!s || !s.boxes.length) return -1;
    for (let i = 0; i < s.boxes.length; i += 1) if (wordIndex < s.boxes[i].end) return i;
    return s.boxes.length - 1;
  }

  /* Show box i (and only it); its words reveal from `at`. The heading rides
     on the first box, later boxes carry a counter in the label instead. */
  function setBox(i, at = api.time) {
    const s = shown;
    if (!s || !s.boxes.length) return;
    const n = s.boxes.length;
    const idx = Math.max(0, Math.min(n - 1, i));
    if (idx === s.box) return;
    /* Words on loan to a bubble go home before the box changes. */
    if (s.box >= 0 && s.boxes[s.box]) layoutBox(s, s.boxes[s.box]);
    s.box = idx;
    s.boxes.forEach((b, j) => { b.el.hidden = j !== idx; });
    const groups = bubblesFor(s, s.boxes[idx]);
    if (groups.length) {
      const held = new Set();
      for (const g of groups) for (const w of g.words) held.add(w);
      layoutBox(s, s.boxes[idx], held);
    }
    bubbles.set(s.spread, groups);
    headingEl.hidden = idx > 0;
    labelEl.textContent = n > 1 ? `Spread ${s.spread} of ${STORY_COUNT} · ${idx + 1} of ${n}` : `Spread ${s.spread} of ${STORY_COUNT}`;
    const last = idx === n - 1;
    nextEl.textContent = last ? 'Turn the page' : 'Next';
    nextEl.setAttribute('aria-label', last ? 'Turn the page' : `Next box, ${idx + 2} of ${n}`);
    const box = s.boxes[idx];
    s.plan = revealPlan(box.end - box.start);
    s.revealAt = at;
    s.applied = null;
    s.lastW = 0; // the box changed height; let place() re-measure
    /* The page answers a new box: the pop-up wakes the character it names. */
    events.emit('box', { spread: s.spread, box: idx, count: n, at, text: box.el.textContent || '' });
  }

  function nextBox() {
    if (advance()) return;
    if (api.turn && !api.turn.active) api.turn.next();
  }

  /* The right arrow's contract: show the next box and answer true; on the
     last box answer false so the caller turns the page. The left arrow is
     the mirror: the previous box, or false on the first so the page goes
     back. */
  function advance() {
    const s = shown;
    if (!s || !s.boxes.length || el.hidden) return false;
    if (s.box >= s.boxes.length - 1) return false;
    setBox(s.box + 1, api.time);
    return true;
  }
  function retreat() {
    const s = shown;
    if (!s || !s.boxes.length || el.hidden) return false;
    if (s.box <= 0) return false;
    setBox(s.box - 1, api.time);
    return true;
  }

  /* The time the card's reveal begins, from the book's own log: the end of
     the turn that landed on this spread, or the end of the cover opening.
     Used in capture mode and as a fallback when no settle event was seen. */
  function revealFromLog(spread) {
    const log = api.book && api.book.log ? api.book.log : [];
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const e = log[i];
      if (e.type === 'turn' && e.to === spread) return e.t + (e.dur || 0);
      if (e.type === 'open' && spread === 0) return e.t + (e.dur || 0);
    }
    return -Infinity;
  }

  function show(spread, { revealAt = api.time, snap = false } = {}) {
    showGen += 1;
    held = false;
    const gen = showGen;
    const at = snap || api.reduced ? -Infinity : revealAt;
    const go = (data) => {
      if (gen !== showGen) return false;
      pendingShow = null;
      const [text, spreads, tm, layers] = data;
      if (!text) { hide(); return false; }
      build(spread, text, spreads, tm, layers);
      shown.revealAt = at;
      update(api.time, true);
      return true;
    };
    const c = cachedAll(spread);
    pendingShow = { spread, gen };
    lastShow = c ? Promise.resolve(go(c)) : ensure(spread).then(go);
    return lastShow;
  }

  function hide({ hold = false } = {}) {
    showGen += 1;
    pendingShow = null;
    if (hold) held = true;
    if (!shown) return;
    closeWordCard(api.time);
    karaoke.unbind();
    shown = null;
    el.hidden = true;
    bubbles.clear();
  }

  /* ---- per frame ------------------------------------------------------ */

  const world = new THREE.Vector3();
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let stamp = null;
  let lastTransform = '';
  let lastOpacity = '';

  function place(time) {
    const cam = api.camera;
    const a = shown.anchor;
    const off = OFFSET[a.page] || OFFSET.right;
    const W = api.vw();
    const H = api.vh();
    cam.updateMatrixWorld();

    /* Portrait (phones, the reel): the card is a reading panel in the lower
       band the camera leaves clear, above the bottom bar, not a floating
       plane over the page; there is no room on a phone for both. */
    if (W / H < 0.8) {
      const cardW = Math.min(W - 2 * MARGIN, CARD_MAX);
      const maxH = Math.round(H * PORTRAIT_CARD_H);
      if (cardW !== shown.lastW) {
        shown.lastW = cardW;
        el.style.width = `${cardW}px`;
        el.style.maxHeight = `${maxH}px`;
        el.style.overflow = 'hidden';
        const fontPx = clamp(cardW / 27, 12.5, 14.5);
        if (fontPx !== shown.lastFontPx) { shown.lastFontPx = fontPx; el.style.fontSize = `${fontPx.toFixed(2)}px`; }
      }
      /* A long spread scrolls inside the panel so the spoken word stays in
         view: the window follows the active word, a third of the way down. */
      const active = el.querySelector('.w.is-active');
      if (active && el.scrollHeight > el.clientHeight) {
        const want = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, active.offsetTop - el.clientHeight * 0.34));
        if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want;
      }
      const h = el.offsetHeight;
      const bars = Math.min(H * 0.24, PORTRAIT_BAR);
      const y = H - bars - h / 2 - MARGIN;
      const transform = `translate(${(W / 2).toFixed(1)}px, ${Math.max(MARGIN + h / 2, y).toFixed(1)}px) translate(-50%, -50%)`;
      if (transform !== lastTransform) { lastTransform = transform; el.style.transform = transform; }
      const opacityP = Number.isFinite(shown.revealAt) ? clamp01((time - shown.revealAt) / FADE).toFixed(3) : '1';
      if (opacityP !== lastOpacity) { lastOpacity = opacityP; el.style.opacity = opacityP; }
      return;
    }

    /* Landscape: the card docks into the reading panel's slot beside the
       scene (ui.css reserves it, the camera frames the book clear of it), so
       the text never sits on the page. It scrolls inside the slot the way
       the portrait panel does. */
    const slot = api.ui && api.ui.cardSlot ? api.ui.cardSlot() : null;
    if (slot) {
      const cardW = Math.round(Math.min(slot.width, CARD_MAX + 40));
      const maxH = Math.round(slot.height);
      if (cardW !== shown.lastW || maxH !== shown.lastMaxH) {
        shown.lastW = cardW;
        shown.lastMaxH = maxH;
        el.style.width = `${cardW}px`;
        el.style.maxHeight = `${maxH}px`;
        el.style.overflow = 'hidden';
        const fontPx = clamp(cardW / 24, 13, 16.5);
        if (fontPx !== shown.lastFontPx) { shown.lastFontPx = fontPx; el.style.fontSize = `${fontPx.toFixed(2)}px`; }
      }
      const active = el.querySelector('.w.is-active');
      if (active && el.scrollHeight > el.clientHeight) {
        const want = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, active.offsetTop - el.clientHeight * 0.34));
        if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want;
      }
      const cx = slot.left + slot.width / 2;
      const cy = slot.top + slot.height / 2;
      const transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px) translate(-50%, -50%)`;
      if (transform !== lastTransform) { lastTransform = transform; el.style.transform = transform; }
      const opacityD = Number.isFinite(shown.revealAt) ? clamp01((time - shown.revealAt) / FADE).toFixed(3) : '1';
      if (opacityD !== lastOpacity) { lastOpacity = opacityD; el.style.opacity = opacityD; }
      return;
    }
    if (shown.lastMaxH) { shown.lastMaxH = 0; shown.lastW = 0; el.style.maxHeight = ''; el.style.overflow = ''; }

    api.book.pageToWorld(clamp01(a.u + off.du), clamp01(a.v + off.dv), world).project(cam);
    let x = (world.x + 1) * 0.5 * W;
    let y = (1 - world.y) * 0.5 * H;

    /* The page's on-screen width sets the card's width. */
    const u0 = a.page === 'left' ? 0 : 0.5;
    api.book.pageToWorld(u0, a.v, p0).project(cam);
    api.book.pageToWorld(u0 + 0.5, a.v, p1).project(cam);
    const pagePx = Math.hypot((p1.x - p0.x) * 0.5 * W, (p1.y - p0.y) * 0.5 * H);
    const minW = Math.min(CARD_MIN, W - 2 * MARGIN);
    const cardW = Math.round(clamp(pagePx * CARD_OF_PAGE, minW, Math.max(minW, CARD_MAX)));
    if (cardW !== shown.lastW) {
      shown.lastW = cardW;
      el.style.width = `${cardW}px`;
      const fontPx = clamp(cardW / 26, 12.5, 16);
      if (fontPx !== shown.lastFontPx) { shown.lastFontPx = fontPx; el.style.fontSize = `${fontPx.toFixed(2)}px`; }
    }

    const w = el.offsetWidth;
    const h = el.offsetHeight;
    x = clamp(x, MARGIN + w / 2, W - MARGIN - w / 2);
    y = clamp(y, MARGIN + h / 2, H - MARGIN - h / 2);

    /* Tilt from the camera: pitch below the horizontal and yaw to the right
       of the book. The card leans LEAN back from vertical, so the camera
       sees its top edge nearer by (pitch - LEAN) and its right edge nearer
       by the yaw; both scaled and clamped so the text stays readable. */
    cam.getWorldDirection(dir);
    const pitch = Math.asin(clamp(-dir.y, -1, 1));
    const yaw = Math.atan2(-dir.x, -dir.z);
    const rx = -clamp((pitch - LEAN) * TILT_GAIN / DEG, RX_MIN, RX_MAX);
    const ry = -clamp(yaw * TILT_GAIN / DEG, -RY_MAX, RY_MAX);
    const transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) perspective(${PERSPECTIVE}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    if (transform !== lastTransform) { lastTransform = transform; el.style.transform = transform; }

    const opacity = Number.isFinite(shown.revealAt) ? clamp01((time - shown.revealAt) / FADE).toFixed(3) : '1';
    if (opacity !== lastOpacity) { lastOpacity = opacity; el.style.opacity = opacity; }
  }

  function reveal(time) {
    const s = shown;
    const k = time - s.revealAt;
    const { rise, stagger, total } = s.plan;
    if (k >= total) {
      if (s.applied !== 'done') {
        for (const w of s.all) { w.style.opacity = ''; w.style.transform = ''; }
        s.applied = 'done';
      }
      return;
    }
    s.applied = 'anim';
    const box = s.boxes.length ? s.boxes[Math.max(0, s.box)] : null;
    const words = box ? s.all.slice(box.start, box.end) : s.all;
    words.forEach((w, i) => {
      const p = easeOutCubic(clamp01((k - i * stagger) / rise));
      w.style.opacity = p.toFixed(3);
      w.style.transform = p >= 1 ? '' : `translateY(${((1 - p) * 8).toFixed(2)}px)`;
    });
  }

  let pillFor = null;
  function wordCard(time) {
    const say = narration.sayAt(time);
    const wEl = say && shown && say.entry.spread === shown.spread ? shown.els[say.entry.i] : null;
    if (!say || !say.visible || !wEl || el.hidden) {
      if (!pill.hidden) { pill.hidden = true; pillFor = null; }
      if (say && !say.visible && say.entry.focused && !say.entry.unfocused) {
        say.entry.unfocused = true;
        events.emit('unfocus', {});
      }
      return;
    }
    const e = say.entry;
    if (pillFor !== e) {
      const word = bare(e.text) || e.text;
      const parts = syllableParts(word);
      pillWord.textContent = word;
      pillSyll.hidden = parts.length < 2;
      pillSyll.textContent = parts.length < 2 ? '' : parts.join(MIDDLE_DOT);
      pillFor = e;
      pill.hidden = false;
    }
    const r = wEl.getBoundingClientRect();
    const W = api.vw();
    const H = api.vh();
    const above = r.top > 96;
    const x = clamp(r.left + r.width / 2, 48, W - 48);
    const y = above ? r.top - 9 : Math.min(r.bottom + 9, H - 12);
    const s = easeOutBack(clamp01(say.age / WORD_CARD_POP));
    pill.classList.toggle('is-below', !above);
    pill.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, ${above ? '-100%' : '0'}) scale(${s.toFixed(3)})`;
  }

  function syncCta(time) {
    if (ctaEl.hidden) return;
    const st = narration.stateAt(time);
    const playing = st.playing && st.spread === shown.spread;
    const label = playing ? CTA_PAUSE : CTA_PLAY;
    if (ctaEl.textContent !== label) ctaEl.textContent = label;
    ctaEl.setAttribute('aria-pressed', playing ? 'true' : 'false');
  }

  /* Cheap enough to run on every call: the render-time hook always places
     the card against the camera pose that is about to be drawn, even when
     app.js also called it earlier in the same frame. */
  function update(time) {
    stamp = time;
    const open = api.book.state === 'open';
    if (open && !held) {
      const s = api.book.spread;
      if ((!shown || shown.spread !== s) && !(pendingShow && pendingShow.spread === s)) {
        show(s, { revealAt: revealFromLog(s) });
      }
    }
    const visible = !!(open && shown);
    if (el.hidden === visible) el.hidden = !visible;
    if (!visible) { bubbles.update(time, { visible: false }); wordCard(time); return; }
    karaoke.update(time);
    /* Narration steps the boxes by itself: the box holding the spoken word
       is the one on show. */
    if (shown.boxes.length && karaoke.index >= 0) {
      const bi = boxIndexOf(karaoke.index);
      if (bi !== shown.box) setBox(bi, time);
    }
    place(time);
    reveal(time);
    const box = shown.boxes.length ? shown.boxes[Math.max(0, shown.box)] : null;
    bubbles.update(time, { visible: true, away: el.classList.contains('is-away'), revealAt: shown.revealAt, plan: shown.plan, boxStart: box ? box.start : 0 });
    wordCard(time);
    syncCta(time);
  }

  /* ---- taps ----------------------------------------------------------- */

  function layerName(spread, layerId, fallback) {
    const set = layerSets.get(spread);
    const layer = set && set.layers ? set.layers.find((l) => l.id === layerId) : null;
    return layer && layer.name ? layer.name : (bare(fallback) || fallback);
  }

  function closeWordCard(at) {
    const say = narration.sayAt(at);
    if (!say || !say.visible) return;
    narration.closeSay(at);
    if (say.entry.focused && !say.entry.unfocused) {
      say.entry.unfocused = true;
      events.emit('unfocus', {});
    }
  }

  async function onWordTap(button) {
    if (!shown) return null;
    const { spread } = shown;
    const i = Number(button.dataset.i);
    const text = button.textContent;
    events.emit('wordTap', { spread, i, text });
    closeWordCard(api.time);
    const entry = await narration.sayWord(spread, i);
    if (!entry || !shown || shown.spread !== spread) return entry;
    const link = linkFor(shown.links, text);
    if (link) {
      entry.focused = true;
      events.emit('focus', { spread, layer: link.layer, at: link.at, name: layerName(spread, link.layer, text), source: 'word' });
    }
    update(api.time, true);
    return entry;
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button.w');
    if (b && el.contains(b)) { onWordTap(b); return; }
    if (e.target.closest('.card__cta')) { narration.toggle(); return; }
    if (e.target.closest('.card__next')) { nextBox(); return; }
    /* A tap on the box itself, off any word, also moves on. */
    if (shown && shown.boxes.length && !e.target.closest('button')) nextBox();
  });
  /* Space on a focused word must activate the word, so it must not reach
     the window listener that turns the page. Enter needs no help. */
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target.closest('button')) e.stopPropagation();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!pill.hidden && !(e.target.closest && e.target.closest('.wordcard'))) closeWordCard(api.time);
  }, true);

  /* ---- book events ---------------------------------------------------- */

  events.on('settle', ({ spread }) => { show(spread, { revealAt: api.time }); });
  /* While the camera is on a character the card steps aside; on a phone the
     two would otherwise cover each other. Word taps keep it (the word pill
     lives on it). */
  events.on('focus', (p) => { if (p && p.source !== 'word') el.classList.add('is-away'); });
  events.on('unfocus', () => { el.classList.remove('is-away'); });
  events.on('jump', () => { el.classList.remove('is-away'); });
  events.on('jump', ({ spread }) => { show(spread, { snap: true }); });
  events.on('turnStart', () => { hide({ hold: true }); });
  events.on('cover', ({ open, t }) => {
    if (open) show(0, { revealAt: (Number.isFinite(t) ? t : api.time) + (api.reduced ? 0 : COVER_S) });
    else hide({ hold: true });
  });

  const card = {
    show,
    hide,
    advance,
    retreat,
    nextBox,
    setBox,
    get box() { return shown ? shown.box : -1; },
    get boxCount() { return shown ? shown.boxes.length : 0; },
    element: el,
    wordCard: pill,
    update,
    state() {
      if (!shown) return { spread: null, visible: false, revealAt: null, revealEndsAt: null, words: 0 };
      return {
        spread: shown.spread,
        visible: !el.hidden,
        revealAt: shown.revealAt,
        revealEndsAt: shown.revealAt + shown.plan.total,
        words: shown.all.length,
        /* the first word of the box on show, so narration can start there */
        boxStart: shown.boxes.length && shown.box >= 0 ? shown.boxes[shown.box].start : 0,
      };
    },
    whenShown: () => lastShow,
    get spread() { return shown ? shown.spread : null; },
    words: () => (shown ? shown.els.slice() : []),
    tap: (i) => (shown && shown.els[i] ? onWordTap(shown.els[i]) : Promise.resolve(null)),
    offsets: OFFSET,
    karaoke,
    wordCardLife: WORD_CARD_LIFE,
  };

  frameHook(api).add((t) => update(t));
  return card;
}
