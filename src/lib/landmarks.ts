import { CatmullRomCurve3, SphereGeometry, Vector3, type BufferGeometry } from 'three'
import { buildTube, withAttenuatorAttributes } from './tube'

/**
 * Orienting landmarks, in LPS mm around the isocenter. Both are rendered through the same Beer–Lambert
 * multiplicative pass as the vessels, with far lower attenuation, so they read as faint shadows that never
 * occlude contrast-filled vessels (a thick vessel multiplies ~0.05 onto whatever is behind it).
 *
 * Positions come from the patient CT (public/models/<case>.index.json → landmarks): the spine centre is the vertebral
 * column detected behind the descending aorta, the diaphragm dome apex sits just under the heart's lowest point. When the
 * CT does not show the spine credibly, the defaults below (typical adult, relative to a centred heart) are used.
 */

/**
 * Relative attenuation coefficients (1/mm); vessels use 0.6 (iodinated contrast). The brief suggested ~0.05, but a
 * 26 mm-wide column at 0.05 (optical density ~1.3 through the centre) read as dark as a thin vessel, so the landmark
 * coefficients were tuned down (0.02 first, then 0.012 / 0.015 once the cardiac soft-tissue shadow stacked in front of the
 * spine): OD ~0.3 through the spine, i.e. a faint translucent gray that stays readable behind the heart.
 */
export const SPINE_MU = 0.012
export const DIAPHRAGM_MU = 0.015
/** Equivalent tissue thickness of the diaphragm membrane (mm) at normal incidence. */
export const DIAPHRAGM_THICKNESS_MM = 8

/** Vertebral column: a gently kyphotic centerline running along Z, ~27 mm vertebra pitch. */
export interface SpineData {
  centres: [number, number, number][]
  radius_mm: number
}
const DEFAULT_SPINE_XY: [number, number] = [-9, 62]
const DEFAULT_SPINE_RADIUS_MM = 12
const VERTEBRA_PITCH_MM = 27

export function buildSpineGeometry(spine?: SpineData | null): BufferGeometry {
  // Centre line: the CT-detected (x, y), extended over z ±260 mm with a gentle thoracic kyphosis (posterior at mid level).
  const n = spine?.centres.length ?? 0
  const [x0, y0] = n ? [spine!.centres.reduce((s, c) => s + c[0], 0) / n, spine!.centres.reduce((s, c) => s + c[1], 0) / n] : DEFAULT_SPINE_XY
  const SPINE_RADIUS_MM = Math.min(16, Math.max(11, spine?.radius_mm ?? DEFAULT_SPINE_RADIUS_MM))
  const pts: Vector3[] = []
  for (let z = 260; z >= -260; z -= 65) pts.push(new Vector3(x0, y0 + 8 * (1 - (z / 260) ** 2), z))
  const curve = new CatmullRomCurve3(pts, false, 'centripetal')
  const length = curve.getLength()
  // Scalloped profile: full-width vertebral bodies (frac ≈ 0.5) narrowing to the intervertebral discs (frac ≈ 0 or 1).
  const radiusAt = (t: number) => {
    const frac = ((t * length) / VERTEBRA_PITCH_MM) % 1
    return SPINE_RADIUS_MM * (0.76 + 0.24 * Math.sqrt(Math.sin(Math.PI * frac)))
  }
  return buildTube(curve, radiusAt, 20, 2)
}

/**
 * Diaphragm dome: the upper half of an ellipsoid (convex towards the head), built around +Z.
 * Asymmetric: a short anterior slope and a long posterior slope (the diaphragm falls away steeply behind the heart).
 * The apex sits at the heart's lowest point (CT), the rim 45 mm lower. Projected vertical position of a point is
 * v = y·sinβ + z·cosβ, so cranial tilt (β > 0) lifts the deep posterior dome into the field while caudal tilt drops it
 * out of the image: "high diaphragm ⇒ cranial tilt, absent diaphragm ⇒ caudal tilt".
 */
export const DIAPHRAGM_RX = 100
export const DIAPHRAGM_RY_ANTERIOR = 45
export const DIAPHRAGM_RY_POSTERIOR = 100
export const DIAPHRAGM_RZ = 45

export function buildDiaphragmGeometry(apex: [number, number, number] = [0, 0, -40]): BufferGeometry {
  const DIAPHRAGM_CENTER: [number, number, number] = [apex[0] + 5, apex[1] + 8, apex[2] - DIAPHRAGM_RZ]
  // three's sphere is Y-up; rotate the upper hemisphere so its pole points along +Z (head), then scale piecewise in Y.
  const g = new SphereGeometry(1, 56, 28, 0, Math.PI * 2, 0, Math.PI / 2)
  g.rotateX(Math.PI / 2)
  const pos = g.getAttribute('position')
  const nor = g.getAttribute('normal')
  const [cx, cy, cz] = DIAPHRAGM_CENTER
  const n = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    const ux = pos.getX(i)
    const uy = pos.getY(i)
    const uz = pos.getZ(i)
    const ry = uy < 0 ? DIAPHRAGM_RY_ANTERIOR : DIAPHRAGM_RY_POSTERIOR
    pos.setXYZ(i, cx + ux * DIAPHRAGM_RX, cy + uy * ry, cz + uz * DIAPHRAGM_RZ)
    // Ellipsoid gradient (continuous across y = 0 because the unit-sphere normal has no kink there).
    n.set(ux / DIAPHRAGM_RX, uy / ry, uz / DIAPHRAGM_RZ).normalize()
    nor.setXYZ(i, n.x, n.y, n.z)
  }
  return withAttenuatorAttributes(g)
}
