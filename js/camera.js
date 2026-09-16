/* camera.js — the rig: one PerspectiveCamera, a pose driver, a lean, a drift.
 *
 * Owns the three camera and everything layered on top of an authored pose
 * each frame. The pose itself comes from a driver: js/ledger.js installs one
 * (poses per spread and kind, walked by a log of flights) through
 * `cam.driver = { poseAt(time, pose) }`. Without a driver the camera holds
 * whatever setPose() last gave it, which is how boot runs before the ledger
 * is wired and how the older probes still work. The methods hang off the
 * three camera itself, so window.__book.camera is both the object the
 * renderer uses and the thing the ledger drives.
 *
 * Fitting, never hard-coding: fitDistance() solves, for a viewing direction,
 * a look-at and a set of world corners, the distance at which every corner
 * projects inside a chosen fraction of the frustum. The home pose fits the
 * open book (plus a leaf standing at the gutter) inside 92% of the frame;
 * the ledger uses the same solver for the closed book, the story-card page
 * and the portrait composition, so no pose is a table of numbers per device.
 *
 * On top of the driven pose, in this order:
 *   drift   a 20 s figure-eight of 2% of the home distance, a function of
 *           time (so the reel gets it too), scaled to zero while a focus
 *           pose is held: a held shot should be still.
 *   lean    one damped pointer target, alpha = 1 - (1 - 0.055)^(dt * 60)
 *           with dt clamped to 1/30, translating the camera by
 *           (-x * 0.26, +y * 0.16) world units and carrying 42% of that into
 *           the look-at (MengTo's split, so it pans more than it dollies).
 *           Mouse only, never touch (a finger on the page is a page turn);
 *           the target returns to 0 on pointerleave and blur; the amplitude
 *           drops to 30% while a focus pose is held; off in capture mode
 *           and under reduced motion.
 * Neither ever cuts, and neither changes what the ledger says the pose is,
 * which is what the ledger's poseError() measures against.
 */

import * as THREE from 'three';
import { vw, vh } from './viewport.js';

export const LOOK = new THREE.Vector3(0.02, 0.06, -0.04);
export const DIR_LANDSCAPE = new THREE.Vector3(0.36, 1.10, 1.00).normalize();
/* Steeper than landscape: on a phone the book's width is what binds the fit,
   and a higher camera foreshortens the pages less, so the same width buys a
   taller book. */
export const DIR_PORTRAIT = new THREE.Vector3(0.08, 1.95, 1.00).normalize();
export const FOV_LANDSCAPE = 38;
export const FOV_PORTRAIT = 44;
export const PORTRAIT_BELOW = 0.8;
export const MARGIN = 0.92;
/* Landscape keeps two bands of the frame free of the book: the top, so the
   desk beyond it (the lamp, the bear) is in the shot, and the right, where
   the reading panel lives (ui.css sizes it with the same numbers). The rest
   poses fit the book into what is left and pan so it sits lower-left. */
export const HEADROOM = 0.34;
export const PANEL = { min: 280, share: 0.30, max: 400, gap: 16 };
const GUTTER = { left: 0.04, foot: 0.05 };   // the book stays off the frame's left and bottom edges
export const panelWidth = (w = vw()) => Math.min(PANEL.max, Math.max(PANEL.min, PANEL.share * w));
export function landscapeClears(aspect, w = vw()) {
  if (aspect < PORTRAIT_BELOW) return { head: 0, foot: 0, left: 0, right: 0 };
  const px = Number.isFinite(w) && w > 0 ? w : 1280;
  return { head: HEADROOM, foot: GUTTER.foot, left: GUTTER.left, right: Math.min(0.42, (panelWidth(px) + 2 * PANEL.gap) / px) };
}
/* The share of the frame the book may fill on each axis once the clears are
   taken, and the pan that centres it in what is left. */
export const clearFitH = (lc) => 1 - (lc.left || 0) - (lc.right || 0);
export const clearFitV = (lc) => 1 - (lc.head || 0) - (lc.foot || 0);
/* Slide a fitted pose so the book sits in the free band: the camera and its
   look point move together, in the frame's own axes, by the band's offset
   from the frame's centre, measured as a share of the half-frame at the
   look distance (up for headroom, right for the panel). */
export function panClears(camV, lookV, fov, aspect, d, lc = {}, outPan = null) {
  const up = (lc.head || 0) - (lc.foot || 0);
  const side = (lc.right || 0) - (lc.left || 0);
  if (!up && !side) return;
  const basis = lookBasis(camV, lookV);
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  const dy = d * tanV * up;
  const dx = d * tanV * aspect * side;
  camV.addScaledVector(basis.up, dy).addScaledVector(basis.right, dx);
  lookV.addScaledVector(basis.up, dy).addScaledVector(basis.right, dx);
  /* the ledger records the shift so the reader's orbit and zoom can pivot
     on the book rather than on the frame's shifted centre */
  if (outPan) outPan.addScaledVector(basis.up, dy).addScaledVector(basis.right, dx);
}
const DRIFT_PERIOD = 20;
const DRIFT_AMP = 0.02;
const LEAN_ALPHA = 0.055;
const LEAN_X = 0.26;
const LEAN_Y = 0.16;
const LOOK_CARRY = 0.42;
const HELD_LEAN = 0.30;
const MAX_DT = 1 / 30;

/* The open book on the blanket plus a leaf standing at the gutter. */
export const BOOK_CORNERS = [];
for (const x of [-1.07, 1.07]) for (const z of [-0.68, 0.68]) BOOK_CORNERS.push(new THREE.Vector3(x, 0, z));
for (const z of [-0.66, 0.66]) BOOK_CORNERS.push(new THREE.Vector3(-0.08, 1.04, z));
/* Portrait frames the spread wider and accepts a tall back wall touching
   the top edge; fitting the full standing height there leaves the book a
   small tile in a sea of blanket. */
export const BOOK_CORNERS_PORTRAIT = BOOK_CORNERS.map((c) => (c.y > 0 ? new THREE.Vector3(c.x, 0.55, c.z) : c.clone()));

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* Camera basis for a pose: forward, right and up as unit vectors. */
export function lookBasis(from, to, out = { fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() }) {
  out.fwd.subVectors(to, from).normalize();
  out.right.crossVectors(out.fwd, WORLD_UP).normalize();
  out.up.crossVectors(out.right, out.fwd).normalize();
  return out;
}

export function createCamera({ reduced = false, live = true } = {}) {
  const cam = new THREE.PerspectiveCamera(FOV_LANDSCAPE, 16 / 9, 0.05, 40);
  /* `pan` is the frame shift a rest pose carries (headroom, the reading
     panel, the phone's card band) as [right, up] world units: the look point
     is the book's centre moved by that much, and the orbit undoes it first. */
  const pose = { cam: new THREE.Vector3(0.9, 2.7, 2.5), look: LOOK.clone(), fov: FOV_LANDSCAPE, held: 0, pan: [0, 0] };
  const look0 = new THREE.Vector3();
  const lookV = new THREE.Vector3();
  const shiftV = new THREE.Vector3();
  const target = new THREE.Vector2();
  const lean = new THREE.Vector2();
  const frame = { fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
  const offset = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let lastTime = 0;

  /* Distance along `dir` from `look` at which every corner projects inside
     marginH of the frustum's half-width and marginV of its half-height. A
     margin of 0.45 therefore fills 45% of the frame width. */
  function fitDistance(corners, dir, look, fov, aspect, marginH = MARGIN, marginV = marginH) {
    tmp.copy(look).add(dir);
    lookBasis(tmp, look, frame);
    const tanV = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const tanH = tanV * aspect;
    let d = 0.5;
    for (const c of corners) {
      offset.subVectors(c, look);
      const depth = offset.dot(frame.fwd);
      const x = Math.abs(offset.dot(frame.right));
      const y = Math.abs(offset.dot(frame.up));
      d = Math.max(d, x / (tanH * marginH) - depth, y / (tanV * marginV) - depth);
    }
    return d;
  }

  cam.homeFor = (aspect) => {
    const portrait = aspect < PORTRAIT_BELOW;
    const dir = portrait ? DIR_PORTRAIT : DIR_LANDSCAPE;
    const fov = portrait ? FOV_PORTRAIT : FOV_LANDSCAPE;
    const clears = landscapeClears(aspect);
    const d = fitDistance(portrait ? BOOK_CORNERS_PORTRAIT : BOOK_CORNERS, dir, LOOK, fov, aspect, MARGIN * clearFitH(clears), MARGIN * clearFitV(clears));
    const camV = LOOK.clone().addScaledVector(dir, d);
    const lookV = LOOK.clone();
    panClears(camV, lookV, fov, aspect, d, clears);
    return { cam: camV, look: lookV, fov, distance: d, portrait };
  };

  cam.setPose = ({ cam: c, look, fov, held }) => {
    if (c) pose.cam.copy(c);
    if (look) pose.look.copy(look);
    if (fov) pose.fov = fov;
    if (held !== undefined) pose.held = held;
  };

  /* The ledger hooks in here: `driver.poseAt(time, pose)` fills the base pose
     each frame, `onRefit(aspect)` rebuilds its rows for a new aspect. */
  cam.driver = null;
  cam.onRefit = null;

  cam.refit = (aspect = vw() / vh()) => {
    const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
    cam.aspect = a;
    /* Refresh now, not only when the fov changes in update(): the first cut
       skipped this and rendered every frame through the constructor's 16:9
       matrix, a 10% horizontal squash on a 1440x900 pane. */
    cam.updateProjectionMatrix();
    cam.home = cam.homeFor(a);
    if (cam.onRefit) cam.onRefit(a);
    else cam.setPose(cam.home);
    cam.update(0, lastTime);
  };

  cam.setPointer = (x, y) => { target.set(x, y); };

  /* The reader's own angle and distance, on top of whatever pose the ledger
     authored: drag on the table (anywhere off the book) to orbit, wheel or
     pinch to dolly. Targets are damped like the lean; settle and focus ease
     them back so authored shots land where they were composed. */
  const orbit = { yaw: 0, pitch: 0, zoom: 1, tYaw: 0, tPitch: 0, tZoom: 1 };
  const ORBIT_ALPHA = 0.14;
  const YAW_MAX = 1.05;
  const PITCH_MIN = -0.55;
  const PITCH_MAX = 0.62;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 1.9;
  const CAM_MIN_Y = 0.22;
  const orbVec = new THREE.Vector3();
  const orbRight = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  cam.orbit = orbit;
  cam.resetOrbit = () => { orbit.tYaw = 0; orbit.tPitch = 0; orbit.tZoom = 1; };
  cam.footprint = null;   // app.js sets this to book.footprint so a drag on the page stays a page turn

  cam.update = (dt, time) => {
    lastTime = time;
    if (live && !reduced && dt > 0) {
      const alpha = 1 - Math.pow(1 - LEAN_ALPHA, Math.min(dt, MAX_DT) * 60);
      lean.x += (target.x - lean.x) * alpha;
      lean.y += (target.y - lean.y) * alpha;
    }
    if (live && dt > 0) {
      const a = 1 - Math.pow(1 - ORBIT_ALPHA, Math.min(dt, MAX_DT) * 60);
      orbit.yaw += (orbit.tYaw - orbit.yaw) * a;
      orbit.pitch += (orbit.tPitch - orbit.pitch) * a;
      orbit.zoom += (orbit.tZoom - orbit.zoom) * a;
    }
    if (cam.driver) cam.driver.poseAt(time, pose);
    /* Orbit and zoom pivot on the book: strip the pose's frame shift, turn
       and scale the offset about the unshifted look point, then put the
       shift back in the new frame, scaled with the zoom so the book keeps
       its place in the frame as the reader dollies in. */
    const px = pose.pan ? pose.pan[0] : 0;
    const py = pose.pan ? pose.pan[1] : 0;
    if (px || py) {
      lookBasis(pose.cam, pose.look, frame);
      look0.copy(pose.look).addScaledVector(frame.right, -px).addScaledVector(frame.up, -py);
    } else {
      look0.copy(pose.look);
    }
    orbVec.subVectors(pose.cam, pose.look);
    if (orbit.yaw) orbVec.applyAxisAngle(WORLD_UP, orbit.yaw);
    if (orbit.pitch) {
      orbRight.crossVectors(WORLD_UP, orbVec).normalize();
      orbVec.applyAxisAngle(orbRight, -orbit.pitch);
    }
    orbVec.multiplyScalar(orbit.zoom);
    camPos.copy(look0).add(orbVec);
    if (camPos.y < CAM_MIN_Y) camPos.y = CAM_MIN_Y;
    const held = clamp01(pose.held || 0);
    lookBasis(camPos, look0, frame);
    lookV.copy(look0);
    if (px || py) {
      shiftV.copy(frame.right).multiplyScalar(px * orbit.zoom).addScaledVector(frame.up, py * orbit.zoom);
      camPos.add(shiftV);
      lookV.add(shiftV);
    }
    const homeDist = cam.home ? cam.home.distance : pose.cam.distanceTo(pose.look);
    const amp = reduced ? 0 : DRIFT_AMP * homeDist * (1 - held);
    const ph = (time / DRIFT_PERIOD) * Math.PI * 2;
    const leanAmp = 1 - (1 - HELD_LEAN) * held;
    const dx = Math.sin(ph) * amp - lean.x * LEAN_X * leanAmp;
    const dy = Math.sin(ph * 2) * amp * 0.5 + lean.y * LEAN_Y * leanAmp;
    offset.copy(frame.right).multiplyScalar(dx).addScaledVector(frame.up, dy);
    cam.position.copy(camPos).add(offset);
    lookAt.copy(lookV).addScaledVector(offset, LOOK_CARRY);
    cam.lookAt(lookAt);
    if (cam.fov !== pose.fov) {
      cam.fov = pose.fov;
      cam.updateProjectionMatrix();
    }
  };

  /* Is this pointer over the book? Same test as the page turn, so the two
     never fight: on the book you turn pages, off it you move the camera. */
  const pickRay = new THREE.Raycaster();
  const pickNdc = new THREE.Vector2();
  const pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pickHit = new THREE.Vector3();
  cam.isOnBook = (e) => {
    if (!cam.footprint) return false;
    const fp = cam.footprint();
    pickNdc.set((e.clientX / vw()) * 2 - 1, -((e.clientY / vh()) * 2 - 1));
    pickRay.setFromCamera(pickNdc, cam);
    pickPlane.constant = -fp.top;
    if (!pickRay.ray.intersectPlane(pickPlane, pickHit)) return false;
    return pickHit.x >= fp.xMin && pickHit.x <= fp.xMax && pickHit.z >= fp.zMin && pickHit.z <= fp.zMax;
  };

  /* Mouse lean, drag-to-orbit, wheel and pinch dolly. */
  cam.attach = (el) => {
    if (!live) return;
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    el.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.d0 > 0) orbit.tZoom = clamp(pinch.z0 * (pinch.d0 / Math.max(1, d)), ZOOM_MIN, ZOOM_MAX);
        return;
      }
      if (drag && e.pointerId === drag.id) {
        /* The hand pulls the scene: drag right and the book swings right
           (the camera orbits left), drag down and the far side comes down
           (the camera rises). Shaab found the eye-steering sense inverted. */
        orbit.tYaw = clamp(drag.yaw0 - ((e.clientX - drag.x) / vw()) * 2.4, -YAW_MAX, YAW_MAX);
        orbit.tPitch = clamp(drag.pitch0 + ((e.clientY - drag.y) / vh()) * 1.7, PITCH_MIN, PITCH_MAX);
        return;
      }
      if (e.pointerType === 'touch') return;
      target.set((e.clientX / vw()) * 2 - 1, -((e.clientY / vh()) * 2 - 1));
    }, { passive: true });
    el.addEventListener('pointerdown', (e) => {
      if (e.target !== el) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: orbit.tZoom };
        drag = null;
        return;
      }
      if (e.button === 0 && cam.isOnBook(e)) return;
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw0: orbit.tYaw, pitch0: orbit.tPitch };
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    });
    const release = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && e.pointerId === drag.id) drag = null;
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      orbit.tZoom = clamp(orbit.tZoom * Math.exp(e.deltaY * 0.0011), ZOOM_MIN, ZOOM_MAX);
    }, { passive: false });
    el.addEventListener('pointerleave', () => target.set(0, 0));
    window.addEventListener('blur', () => target.set(0, 0));
  };

  cam.pose = pose;
  cam.lean = lean;
  cam.pointer = target;
  cam.fitDistance = fitDistance;
  cam.refit(16 / 9);
  return cam;
}
