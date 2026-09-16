/* leaf.js — one leaf of the book: a pivot at the spine, two faces, one bend.
 *
 * A leaf is a pivot group whose rotation about the spine axis (world Z) is
 * PI * a, with a = 0 lying on the right and a = 1 lying on the left. Inside it
 * a `tilt` group lays MengTo's XY page plane flat on the blanket, so the bend
 * code below is his `updateFlexiblePage` verbatim in its own frame: base
 * coordinates (x, y) in -0.5..0.5, u = 0 at the spine, 1 at the free edge,
 * and z the displacement off the sheet.
 *
 * Two meshes back to back rather than one DoubleSide sheet: each face carries
 * its own page image and its own outward normal, so lighting reads correctly
 * on both sides and the far face is always right, with no texture swap at
 * the half-turn. The back face is rotated PI about Y, which mirrors its x; the
 * `direction` argument to bend() undoes that (mappedU = 1 - u, z negated) so
 * both faces displace identically in the tilt frame and stay 0.00044 apart.
 *
 * Geometry is shared: every resting face uses one flat plane, and the single
 * turning leaf borrows the two bendable planes. Resting leaves are therefore
 * flat by construction, which is what the probe page asserts.
 */

import * as THREE from 'three';

export const PAGE_W = 1.0;            // 22 cm
export const PAGE_H = 1.27;           // 28 cm
export const LEAF_COUNT = 17;
export const CREAM = 0xF6EFE0;
const SEG_X = 18;
const SEG_Y = 8;
const FACE_GAP = 0.00022;
const CURVE_MAX = 0.19;

function makePlane() {
  return new THREE.PlaneGeometry(1, 1, SEG_X, SEG_Y);
}

const flatGeometry = makePlane();
const bendFront = makePlane();
const bendBack = makePlane();
const base = Float32Array.from(flatGeometry.attributes.position.array);

/* MengTo's bend, complete-shelf updateFlexiblePage, applied to one face. */
export function bend(geometry, direction, curve, twist) {
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const o = i * 3;
    const x = base[o];
    const y = base[o + 1];
    const u = x + 0.5;
    const mappedU = direction > 0 ? u : 1 - u;
    const arch = Math.sin(Math.PI * mappedU);
    const freeEdgeLift = mappedU * mappedU * 0.16;
    const shape = arch * 0.84 + freeEdgeLift;
    const diagonalTwist = twist * y * Math.pow(mappedU, 1.35);
    const softRipple = twist
      * Math.sin(mappedU * Math.PI * 2)
      * (1 - Math.min(1, Math.abs(y) * 1.65))
      * 0.09;
    const z = (curve * shape * (1 + y * 0.14) + diagonalTwist + softRipple) * direction;
    position.setXYZ(i, x, y, z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

/* Turn progress a in [0, 1] maps to the pivot angle and the curl amplitude:
   flat at both ends, fullest at the vertical. `sign` is +1 turning forward
   (the sheet bows toward the left page) and -1 turning back. */
export const curveFor = (a, sign) => CURVE_MAX * Math.sin(Math.PI * a) * sign;

function faceMaterial() {
  return new THREE.MeshStandardMaterial({
    color: CREAM,
    roughness: 0.9,
    metalness: 0,
    side: THREE.FrontSide,
    depthWrite: true,
    transparent: false,
  });
}

export function createLeaf(index) {
  const pivot = new THREE.Group();
  pivot.name = `leaf-${index}`;
  const tilt = new THREE.Group();
  tilt.rotation.x = -Math.PI / 2;
  pivot.add(tilt);

  const front = new THREE.Mesh(flatGeometry, faceMaterial());
  front.position.set(PAGE_W / 2, 0, FACE_GAP);
  front.scale.set(PAGE_W, PAGE_H, 1);
  front.name = `leaf-${index}-front`;

  const back = new THREE.Mesh(flatGeometry, faceMaterial());
  back.position.set(PAGE_W / 2, 0, -FACE_GAP);
  back.rotation.y = Math.PI;
  back.scale.set(PAGE_W, PAGE_H, 1);
  back.name = `leaf-${index}-back`;

  tilt.add(front, back);

  let bent = false;

  function setMap(mesh, texture) {
    const m = mesh.material;
    const had = !!m.map;
    m.map = texture || null;
    m.color.set(texture ? 0xFFFFFF : CREAM);
    if (had !== !!texture) m.needsUpdate = true;
  }

  return {
    index,
    pivot,
    front,
    back,
    get bent() { return bent; },

    setFront(texture) { setMap(front, texture); },
    setBack(texture) { setMap(back, texture); },

    /* Lie flat on one side at a given height. */
    rest(side, y) {
      pivot.rotation.z = side === 'left' ? Math.PI : 0;
      pivot.position.y = y;
      if (bent) {
        front.geometry = flatGeometry;
        back.geometry = flatGeometry;
        bent = false;
      }
    },

    /* Mid-turn pose: angle fraction a, curl sign, twist, pivot height. */
    setTurn(a, sign, twist, y) {
      pivot.rotation.z = Math.PI * a;
      pivot.position.y = y;
      if (!bent) {
        front.geometry = bendFront;
        back.geometry = bendBack;
        bent = true;
      }
      const curve = curveFor(a, sign);
      bend(bendFront, 1, curve, twist);
      bend(bendBack, -1, curve, twist);
    },
  };
}
