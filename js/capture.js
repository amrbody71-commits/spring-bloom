/* capture.js — what the reel needs that a reader never sees.
 *
 * A drawn pointer (a soft cream dot with a shadow, the size a phone viewer
 * can follow) that glides between tour `pointerTo` events and dips on
 * `click`, and an end card with the credit line. Both are pure functions of
 * book time and the tour's pointer log, so a seek lands on the right frame.
 * Nothing here runs in live mode.
 */

export function initCapture(api, { root = document.body } = {}) {
  const layer = document.createElement('div');
  layer.id = 'capture';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50';
  root.appendChild(layer);

  const dot = document.createElement('div');
  dot.className = 'capture-pointer';
  dot.style.cssText = [
    'position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%',
    'background:radial-gradient(circle at 40% 35%, #fffaf0 0 55%, #f2d9a8 100%)',
    'box-shadow:0 6px 18px rgba(60,40,10,.35), 0 0 0 2px rgba(255,255,255,.7) inset',
    'opacity:0;transform:translate(0,0) scale(1);will-change:transform',
  ].join(';');
  layer.appendChild(dot);

  const card = document.createElement('div');
  card.className = 'capture-endcard';
  card.innerHTML = `
    <div class="capture-endcard-inner">
      <p class="capture-kicker">A pop-up edition of</p>
      <h2>Spring Bloom</h2>
      <p class="capture-sub">A math adventure story</p>
      <p class="capture-credit">By Sadia Mir and Summer Al-Jarrah Bateiha<br>Illustrated by Inna Ogando<br>Hamad Bin Khalifa University Press, 2019</p>
    </div>`;
  card.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;opacity:0;background:rgba(20,14,8,.0)';
  layer.appendChild(card);

  /* pointer log: [{t, x, y, over}] as screen fractions; clicks: [t] */
  const moves = [];
  const clicks = [];
  let endCardAt = null;

  /* A pointer target can be a word on the card ({word, n}), a standing layer
     ({layer}), a point on the spread ({at:[u,v]}) or screen fractions
     ({x, y}). Targets are resolved when the event fires, against the layout
     of that frame, so the tour file never carries pixel positions. */
  function resolve(e) {
    const w = api.vw(), h = api.vh();
    if (e.word && api.card?.wordRect) {
      const r = api.card.wordRect(e.word, e.n ?? 1);
      if (r) return { x: (r.left + r.width / 2) / w, y: (r.top + r.height / 2) / h };
    }
    if (e.word && api.card?.element) {
      const el = [...api.card.element.querySelectorAll('.w')].filter((n) => n.textContent.replace(/[^\w']/g, '').toLowerCase() === String(e.word).toLowerCase())[e.n ? e.n - 1 : 0];
      if (el) { const r = el.getBoundingClientRect(); return { x: (r.left + r.width / 2) / w, y: (r.top + r.height / 2) / h }; }
    }
    if (e.layer && api.popup?.layers) {
      const l = (api.popup.layers(e.spread ?? api.book.spread) || []).find((x) => x.id === e.layer);
      if (l && l.mesh) {
        const p = l.mesh.getWorldPosition(new l.mesh.position.constructor()).project(api.camera);
        return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
      }
    }
    if (e.at) {
      const p = api.book.pageToWorld(e.at[0], e.at[1]).project(api.camera);
      return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
    }
    return { x: e.x ?? 0.5, y: e.y ?? 0.5 };
  }

  function apply(e) {
    if (e.do === 'pointerTo') { const p = resolve(e); moves.push({ t: e.t, x: p.x, y: p.y, over: e.over ?? 0.6 }); }
    else if (e.do === 'click') clicks.push(e.t);
    else if (e.do === 'endCard') endCardAt = e.show ? e.t : null;
  }

  const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));

  function pointerAt(time) {
    if (!moves.length || time < moves[0].t) return null;
    let i = moves.length - 1;
    while (i > 0 && moves[i].t > time) i -= 1;
    const cur = moves[i];
    const prev = i > 0 ? moves[i - 1] : cur;
    const k = ease((time - cur.t) / Math.max(1e-3, cur.over));
    return { x: prev.x + (cur.x - prev.x) * k, y: prev.y + (cur.y - prev.y) * k };
  }

  function update(time) {
    const p = pointerAt(time);
    if (!p) { dot.style.opacity = '0'; } else {
      const w = api.vw(), h = api.vh();
      let scale = 1;
      for (const c of clicks) { const d = time - c; if (d >= 0 && d < 0.28) scale = d < 0.1 ? 1 - 0.18 * (d / 0.1) : 0.82 + 0.18 * ((d - 0.1) / 0.18); }
      dot.style.opacity = '1';
      dot.style.transform = `translate(${(p.x * w).toFixed(1)}px, ${(p.y * h).toFixed(1)}px) scale(${scale.toFixed(3)})`;
    }
    if (endCardAt != null && time >= endCardAt) {
      const k = ease((time - endCardAt) / 0.9);
      card.style.opacity = String(k);
      card.style.background = `rgba(20,14,8,${(0.55 * k).toFixed(3)})`;
    } else { card.style.opacity = '0'; }
  }

  function reset() { moves.length = 0; clicks.length = 0; endCardAt = null; }

  return { apply, update, reset, layer };
}
