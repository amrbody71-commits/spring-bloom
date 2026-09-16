/* ui.js, the interface chrome.
 *
 * Top: the title lockup, a star pill with one star per story spread, and
 * round buttons for sound, zoom and settings. Bottom: previous, "Read to me"
 * (or "Pause"), next, and a hint pill naming what the current spread does.
 * Settings opens a small sheet: read the next page by itself, less motion,
 * and the credits. Everything is fixed DOM inside #ui, built by mount().
 *
 * State comes from the book: the pill and the buttons follow `settle`,
 * `jump` and `cover`, and a light per-frame poll of book.state and
 * turn.active keeps the disabled flags right through drags and the cover
 * swing, which have no "done" event of their own. The hint takes `hint`
 * events and otherwise the spread's hint from assets/data/spreads.json.
 *
 * Nothing here touches book time, so nothing here is on the capture path;
 * in capture mode the chrome still mounts (the reel hides #ui itself).
 */

const STORY_SPREADS = 15;
const LAST_SPREAD = 16;
const TAP_PX = 8;

import * as THREE from 'three';

const ICON = {
  lamp: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 4h7l3 7.5h-13z" fill="#F2B233" stroke="currentColor"/><path d="M12 11.5V18"/><path d="M8 20h8"/><path d="M5 9.5L3.6 8.8"/><path d="M19 9.5l1.4-.7"/></svg>',
  lampOff: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 4h7l3 7.5h-13z"/><path d="M12 11.5V18"/><path d="M8 20h8"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8a1 1 0 0 0-1.5.86z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.6" fill="currentColor"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.6" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6l6 6-6 6"/></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.2L12 18.5v-13L7.2 9.5z" fill="currentColor" stroke="none"/><path d="M15.2 9.3a3.8 3.8 0 0 1 0 5.4"/><path d="M17.8 6.7a7.4 7.4 0 0 1 0 10.6"/></svg>',
  soundOff: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.2L12 18.5v-13L7.2 9.5z" fill="currentColor" stroke="none"/><path d="M15.5 9.5l5 5"/><path d="M20.5 9.5l-5 5"/></svg>',
  zoomIn: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.2"/><path d="M15.2 15.2L20 20"/><path d="M10.5 8v5"/><path d="M8 10.5h5"/></svg>',
  zoomOut: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.2"/><path d="M15.2 15.2L20 20"/><path d="M8 10.5h5"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/><circle cx="9" cy="7" r="2.1" fill="#FBF5E8"/><circle cx="15" cy="12" r="2.1" fill="#FBF5E8"/><circle cx="8" cy="17" r="2.1" fill="#FBF5E8"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6L2.5 9.5l6.6-.8z" fill="currentColor"/></svg>',
  hand: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12.5V4.6a1.6 1.6 0 0 1 3.2 0v6.9"/><path d="M12.2 10.6a1.6 1.6 0 0 1 3.2 0V12"/><path d="M15.4 11.4a1.6 1.6 0 0 1 3.2 0v1.4"/><path d="M18.6 12.4a1.6 1.6 0 0 1 3.2 0v3.4a6.2 6.2 0 0 1-6.2 6.2h-2.4a5.4 5.4 0 0 1-4.3-2.1L5.3 15.6a1.7 1.7 0 0 1 2.6-2.2L9 14.8"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6l6 6-6 6"/></svg>',
};

const HINT_OPEN_TITLE = 'Turn the page to start the story.';
const HINT_CLOSED = 'Tap the book to begin.';

const pad2 = (n) => String(n).padStart(2, '0');

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

function icon(name, cls = '') {
  return el('span', { class: `sb-ico ${cls}`.trim(), html: ICON[name] });
}

export function init(api) {
  const live = api.mode === 'live';
  const dom = {};
  let root = null;
  let hints = null;
  let customHint = null;
  let customSpread = -1;
  let spread = 0;
  let playing = false;
  let soundOn = true;
  let zoomed = false;
  let lastKey = '';
  let lastFocus = null;
  let sheetFrom = null;

  /* ---- the chrome --------------------------------------------------- */

  function ensureStylesheet() {
    if (document.querySelector('link[rel="stylesheet"][href$="ui.css"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/ui.css';
    document.head.appendChild(link);
  }

  function roundButton(cls, label, main, alt) {
    const b = el('button', { type: 'button', class: `sb-btn ${cls}`, 'aria-label': label });
    b.append(icon(main, 'sb-ico-main'));
    if (alt) b.append(icon(alt, 'sb-ico-alt'));
    return b;
  }

  function mount() {
    root = document.getElementById('ui');
    if (!root) return null;
    if (dom.chrome && dom.chrome.isConnected) return dom.chrome;
    ensureStylesheet();

    const chrome = el('div', { class: 'sb-chrome' });

    dom.lockup = el('div', { class: 'sb-lockup' }, [
      el('span', { class: 'sb-title' }, 'Spring Bloom'),
      el('span', { class: 'sb-sub' }, 'A math adventure story'),
    ]);

    dom.stars = el('div', { class: 'sb-stars', role: 'img', 'aria-label': 'Before the story' });
    dom.starList = [];
    for (let i = 1; i <= STORY_SPREADS; i += 1) {
      const s = el('span', { class: 'sb-star', html: ICON.star });
      dom.starList.push(s);
      dom.stars.append(s);
    }

    dom.sound = roundButton('sb-sound', 'Sound on', 'sound', 'soundOff');
    dom.sound.setAttribute('aria-pressed', 'true');
    dom.zoom = roundButton('sb-zoom', 'Zoom in on the page', 'zoomIn', 'zoomOut');
    dom.settings = roundButton('sb-settings', 'Settings', 'settings');
    dom.settings.setAttribute('aria-haspopup', 'dialog');
    /* The lamp switch: off is bed time. The lamp in the scene toggles it
       too (a tap, see the canvas handler), and the button follows. */
    dom.lamp = roundButton('sb-lamp', 'Lamp on', 'lamp', 'lampOff');
    dom.lamp.setAttribute('aria-pressed', 'true');
    dom.lamp.addEventListener('click', () => { if (api.lamp) api.lamp.toggle(); });
    dom.tools = el('div', { class: 'sb-tools' }, [dom.sound, dom.zoom, dom.lamp, dom.settings]);

    dom.prev = roundButton('sb-arrow sb-prev', 'Previous page', 'prev');
    dom.next = roundButton('sb-arrow sb-next', 'Next page', 'next');
    dom.read = el('button', { type: 'button', class: 'sb-read', 'aria-label': 'Read to me' }, [
      icon('play', 'sb-ico-play'),
      icon('pause', 'sb-ico-pause'),
      el('span', { class: 'sb-read-label' }, 'Read to me'),
    ]);
    dom.controls = el('div', { class: 'sb-controls' }, [dom.prev, dom.read, dom.next]);

    dom.hintText = el('span', { class: 'sb-hint-text' });
    dom.hint = el('div', { class: 'sb-hint is-empty', role: 'status', 'aria-live': 'polite' }, [icon('hand'), dom.hintText]);
    /* The slot is empty layout: in landscape the grid reserves the reading
       panel's middle for the story card, and card.js docks the card into
       whatever box the slot ends up with. */
    dom.cardSlot = el('div', { class: 'sb-cardslot', 'aria-hidden': 'true' });

    chrome.append(dom.lockup, dom.stars, dom.tools, dom.cardSlot, dom.controls, dom.hint);
    root.append(chrome);
    dom.chrome = chrome;

    /* The arrows step the text boxes first; only past the last box (or
       before the first) do they turn the page. */
    dom.prev.addEventListener('click', () => { unlockAudio(); if (!(api.card && api.card.retreat && api.card.retreat())) api.turn.prev(); sync(true); });
    dom.next.addEventListener('click', () => { unlockAudio(); if (!(api.card && api.card.advance && api.card.advance())) api.turn.next(); sync(true); });
    dom.read.addEventListener('click', onRead);
    dom.sound.addEventListener('click', onSound);
    dom.zoom.addEventListener('click', onZoom);
    dom.settings.addEventListener('click', () => openSheet('settings', dom.settings));

    /* Space on a focused control must work the control, so it stops here
       before the window listener in turn.js reads it as "next page". */
    chrome.addEventListener('keydown', (e) => { if (e.key === ' ' && e.target.closest('button')) e.stopPropagation(); });
    chrome.addEventListener('keyup', (e) => { if (e.key === ' ' && e.target.closest('button')) e.stopPropagation(); });

    setSpread(api.book.spread);
    setPlaying(playing);
    setSound(soundOn);
    applyDefaultHint();
    sync(true);
    return chrome;
  }

  /* ---- public setters ----------------------------------------------- */

  function setHint(text) {
    if (!dom.hint) return;
    const t = (text === null || text === undefined) ? '' : String(text);
    dom.hintText.textContent = t;
    dom.hint.classList.toggle('is-empty', t.trim() === '');
  }

  function setPlaying(on) {
    playing = !!on;
    if (!dom.read) return;
    dom.read.classList.toggle('is-playing', playing);
    const label = playing ? 'Pause' : 'Read to me';
    dom.read.querySelector('.sb-read-label').textContent = label;
    dom.read.setAttribute('aria-label', label);
    dom.read.setAttribute('aria-pressed', playing ? 'true' : 'false');
  }

  function setSpread(n) {
    spread = Math.max(0, Math.min(LAST_SPREAD, Number(n) || 0));
    if (!dom.starList) return;
    dom.starList.forEach((s, i) => {
      const k = i + 1;
      s.classList.toggle('is-now', k === spread);
      s.classList.toggle('is-done', k < spread);
    });
    let label = 'Before the story';
    if (spread >= 1 && spread <= STORY_SPREADS) label = `Page ${spread} of ${STORY_SPREADS}`;
    else if (spread > STORY_SPREADS) label = 'After the story';
    dom.stars.setAttribute('aria-label', label);
  }

  function setSound(on) {
    soundOn = !!on;
    if (!dom.sound) return;
    dom.sound.classList.toggle('is-alt', !soundOn);
    dom.sound.setAttribute('aria-label', soundOn ? 'Sound on' : 'Sound off');
    dom.sound.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  }

  function setZoomed(on) {
    zoomed = !!on;
    if (!dom.zoom) return;
    dom.zoom.classList.toggle('is-alt', zoomed);
    dom.zoom.setAttribute('aria-label', zoomed ? 'Zoom out' : 'Zoom in on the page');
  }

  /* ---- hints ---------------------------------------------------------- */

  function defaultHint() {
    const st = api.book.state;
    if (st === 'closed' || st === 'closing') return hints ? hints['00'] : HINT_CLOSED;
    if (spread === 0) return HINT_OPEN_TITLE;
    if (!hints) return '';
    return hints[pad2(spread)] || '';
  }

  function applyDefaultHint() {
    if (customHint !== null) setHint(customHint);
    else setHint(defaultHint());
  }

  /* A pop-up module may emit `hint` inside the same settle or jump emit
     that we answer, before or after this listener runs. Each hint remembers
     the spread it was emitted for (turn.spread is already the new spread
     while those emits run), so a hint for the spread we just landed on is
     kept whatever the order, and anything older gives way to the default. */
  function landedSpread() {
    return api.turn ? api.turn.spread : api.book.spread;
  }

  function onLanded(s) {
    if (customHint !== null && customSpread === s) { setHint(customHint); return; }
    customHint = null;
    customSpread = -1;
    applyDefaultHint();
  }

  fetch('assets/data/spreads.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      if (!json || !json.spreads) return;
      hints = {};
      for (const [k, v] of Object.entries(json.spreads)) hints[k] = (v && v.hint) || '';
      if (customHint === null) applyDefaultHint();
    })
    .catch(() => { /* the hint pill stays quiet without the file */ });

  /* ---- buttons -------------------------------------------------------- */

  function unlockAudio() {
    if (api.audio && typeof api.audio.unlock === 'function') api.audio.unlock();
  }

  function onRead() {
    unlockAudio();
    if (api.narration && typeof api.narration.toggle === 'function') {
      api.narration.toggle();
      return;
    }
    if (api.book.state === 'closed') api.book.openCover();
    sync(true);
  }

  function onSound() {
    const a = api.audio;
    if (a && typeof a.mute === 'function') {
      unlockAudio();
      a.mute(!a.muted);
      setSound(!a.muted);
    } else {
      setSound(!soundOn);
    }
  }

  function onZoom() {
    if (zoomed) {
      api.events.emit('unfocus', {});
      setZoomed(false);
      return;
    }
    api.events.emit('focus', {
      spread: api.book.spread, layer: 'plate', at: [0.5, 0.5], name: 'the page', source: 'zoom',
    });
    setZoomed(true);
  }

  /* ---- the settings and credits sheet --------------------------------- */

  function closeSheet() {
    if (dom.backdrop) dom.backdrop.remove();
    if (dom.sheet) dom.sheet.remove();
    dom.backdrop = null;
    dom.sheet = null;
    const back = lastFocus;
    lastFocus = null;
    sheetFrom = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  }

  function switchRow(label, checked, onToggle) {
    const row = el('button', { type: 'button', class: 'sb-row', role: 'switch', 'aria-label': label, 'aria-checked': checked ? 'true' : 'false' }, [
      el('span', { class: 'sb-row-label' }, label),
      el('span', { class: 'sb-switch', 'aria-hidden': 'true' }),
    ]);
    row.addEventListener('click', () => {
      const next = row.getAttribute('aria-checked') !== 'true';
      row.setAttribute('aria-checked', next ? 'true' : 'false');
      onToggle(next);
    });
    return row;
  }

  function linkRow(label, onPick) {
    const row = el('button', { type: 'button', class: 'sb-row', 'aria-label': label }, [
      el('span', { class: 'sb-row-label' }, label),
      icon('chevron'),
    ]);
    row.addEventListener('click', onPick);
    return row;
  }

  function reloadWithReduced(on) {
    const url = new URL(location.href);
    if (on) url.searchParams.set('reduced', '1');
    else url.searchParams.delete('reduced');
    location.href = url.toString();
  }

  function settingsBody() {
    const auto = !!(api.narration && api.narration.autoAdvance) || !!ui.autoAdvance;
    return [
      switchRow('Read the next page by itself', auto, (on) => {
        ui.autoAdvance = on;
        if (api.narration) api.narration.autoAdvance = on;
      }),
      switchRow('Less motion', !!api.reduced, (on) => reloadWithReduced(on)),
      linkRow('About this book', () => openSheet('credits', lastFocus, 'settings')),
    ];
  }

  function creditsBody() {
    return [el('div', { class: 'sb-credits' }, [
      el('p', { class: 'sb-credits-title' }, 'Spring Bloom'),
      el('p', { class: 'sb-credits-sub' }, 'A math adventure story'),
      el('p', {}, 'Written by Sadia Mir and Summer Al-Jarrah Bateiha.'),
      el('p', {}, 'Illustrated by Inna Ogando.'),
      el('p', {}, 'Published by Hamad Bin Khalifa University Press, 2019.'),
      el('p', { class: 'sb-credits-love' }, 'Made with love for the authors by Abdelrahman Shaaban.'),
    ])];
  }

  function openSheet(view, returnTo = null, from = null) {
    if (!root) mount();
    if (!root) return null;
    const keepFocus = dom.sheet ? lastFocus : (returnTo || document.activeElement);
    if (dom.backdrop) dom.backdrop.remove();
    if (dom.sheet) dom.sheet.remove();
    lastFocus = keepFocus;
    sheetFrom = from;

    const title = view === 'credits' ? 'About this book' : 'Settings';
    const backdrop = el('div', { class: 'sb-backdrop' });
    backdrop.addEventListener('click', closeSheet);

    const close = roundButton('sb-close', 'Close', 'close');
    close.addEventListener('click', closeSheet);
    const head = el('div', { class: 'sb-sheet-head' }, [el('h2', {}, title), close]);
    const sheet = el('div', { class: `sb-sheet sb-sheet-${view}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [head]);
    for (const node of (view === 'credits' ? creditsBody() : settingsBody())) sheet.append(node);
    if (view === 'credits' && from === 'settings') {
      const back = linkRow('Back to settings', () => openSheet('settings', lastFocus));
      back.querySelector('.sb-ico').remove();
      sheet.append(back);
    }

    /* Tab stays inside the sheet while it is open. */
    sheet.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = Array.from(sheet.querySelectorAll('button:not([disabled])'));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    root.append(backdrop, sheet);
    dom.backdrop = backdrop;
    dom.sheet = sheet;
    const firstRow = sheet.querySelector('.sb-row') || close;
    firstRow.focus();
    return sheet;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dom.sheet) { e.preventDefault(); closeSheet(); }
  });

  /* ---- book state ----------------------------------------------------- */

  function sync(force = false) {
    if (!dom.chrome) return;
    const st = api.book.state;
    const turning = !!(api.turn && api.turn.active);
    const s = api.book.spread;
    const key = `${st}|${turning ? 1 : 0}|${s}`;
    if (!force && key === lastKey) return;
    const wasClosed = lastKey.startsWith('closed') || lastKey.startsWith('closing');
    lastKey = key;

    const open = st === 'open';
    const swinging = st === 'opening' || st === 'closing';
    dom.prev.disabled = turning || !open;
    dom.next.disabled = turning || swinging || (open && s >= LAST_SPREAD);
    dom.zoom.disabled = turning || !open;
    dom.chrome.classList.toggle('is-turning', turning || swinging);

    if (wasClosed && (st === 'open' || st === 'opening') && customHint === null) applyDefaultHint();
    if ((st === 'closed' || st === 'closing') && customHint === null) applyDefaultHint();
  }

  const ev = api.events;
  function landed(p) {
    const s = p && Number.isFinite(p.spread) ? p.spread : landedSpread();
    setSpread(s);
    setZoomed(false);
    onLanded(s);
    sync(true);
  }
  ev.on('settle', landed);
  ev.on('jump', landed);
  ev.on('cover', () => { setSpread(api.book.spread); setZoomed(false); sync(true); });
  ev.on('turnStart', () => sync(true));
  ev.on('hint', (p) => {
    customHint = p && typeof p.text === 'string' ? p.text : '';
    customSpread = landedSpread();
    setHint(customHint);
  });
  ev.on('narration', (p) => {
    if (!p) return;
    if (p.state === 'start' || p.state === 'resume') setPlaying(true);
    else if (p.state === 'pause' || p.state === 'end') setPlaying(false);
  });
  ev.on('unfocus', () => setZoomed(false));
  ev.on('focus', (p) => { if (!p || p.source !== 'zoom') setZoomed(false); });

  /* A tap on the closed book opens it, wherever on the canvas it lands. */
  const canvas = document.getElementById('stage');
  if (live && canvas) {
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, id: e.pointerId }; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || e.pointerId !== down.id) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > TAP_PX) return;
      if (hitLamp(e)) { if (api.lamp) api.lamp.toggle(); return; }
      if (api.book.state === 'closed') { api.book.openCover(); sync(true); }
    });
    canvas.addEventListener('pointercancel', () => { down = null; });
  }

  /* A tap on the lamp in the scene: the shade, the stem or the base. */
  const lampRay = new THREE.Raycaster();
  const lampNdc = new THREE.Vector2();
  function hitLamp(e) {
    const group = api.scene && api.scene.getObjectByName ? api.scene.getObjectByName('lamp') : null;
    if (!group || !api.camera) return false;
    lampNdc.set((e.clientX / api.vw()) * 2 - 1, -((e.clientY / api.vh()) * 2 - 1));
    lampRay.setFromCamera(lampNdc, api.camera);
    return lampRay.intersectObject(group, true).some((h) => h.object.isMesh && h.object.geometry && h.object.geometry.type !== 'PlaneGeometry');
  }
  function syncLamp() {
    if (!dom.lamp || !api.lamp) return;
    const on = !!api.lamp.on;
    dom.lamp.classList.toggle('is-alt', !on);
    dom.lamp.setAttribute('aria-pressed', on ? 'true' : 'false');
    dom.lamp.setAttribute('aria-label', on ? 'Lamp on' : 'Lamp off');
  }
  ev.on('lamp', (p) => {
    syncLamp();
    setHint(p && p.on ? '' : 'Good night. Tap the lamp to wake the room.');
  });

  /* The poll: through the app's frame event when one is emitted, otherwise
     from a loop of its own. Live mode only; a capture frame never needs it. */
  let viaFrame = false;
  ev.on('frame', () => { viaFrame = true; sync(); });
  if (live) {
    const loop = () => { if (viaFrame) return; sync(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  const ui = {
    mount,
    setHint,
    setPlaying,
    setSpread,
    setSound,
    setZoomed,
    openCredits: () => openSheet('credits', dom.settings || null),
    openSettings: () => openSheet('settings', dom.settings || null),
    closeSheet,
    sync,
    autoAdvance: false,
    get spread() { return spread; },
    get playing() { return playing; },
    get soundOn() { return soundOn; },
    get zoomed() { return zoomed; },
    get sheetOpen() { return !!dom.sheet; },
    get element() { return dom.chrome || null; },
    /* The reading panel's card box, in viewport px, or null when the layout
       has no panel (portrait, or before mount). */
    cardSlot() {
      const s = dom.cardSlot;
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return r.width > 40 && r.height > 40 ? r : null;
    },
    dom,
  };

  if (document.getElementById('ui')) mount();
  return ui;
}
