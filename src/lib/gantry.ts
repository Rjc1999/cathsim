/**
 * C-arm gantry kinematics. Pure, dependency-free math (no three.js) so it can be unit-checked in isolation.
 *
 * Patient space = LPS, millimetres, isocenter at the origin:
 *   +X = patient Left, +Y = Posterior, +Z = Head (cranial).
 *
 * Gantry angles (degrees), named by the DETECTOR position:
 *   alpha (primary)   : +LAO / -RAO, yaw about the patient long axis, clamped to ±90°
 *   beta  (secondary) : +CRA / -CAU, pitch, clamped to ±45°
 *   roll              : locked at 0° by construction (the up vector below has no free roll term)
 */

export type Vec3 = readonly [number, number, number]

export const ALPHA_LIMIT_DEG = 90
export const BETA_LIMIT_DEG = 45

/** Source-to-isocenter distance (mm). */
export const SOD_MM = 720
/** Source-to-image (detector) distance (mm). */
export const SID_MM = 1000
/** Detector field of view at the detector plane (mm); 24 cm cardiac mode (= 17.3 cm at the isocenter). */
export const DETECTOR_FOV_MM = 240

const DEG = Math.PI / 180

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const clampAlpha = (a: number) => clamp(a, -ALPHA_LIMIT_DEG, ALPHA_LIMIT_DEG)
export const clampBeta = (b: number) => clamp(b, -BETA_LIMIT_DEG, BETA_LIMIT_DEG)

/** Unit vector from isocenter towards the detector: d = (sinα cosβ, -cosα cosβ, sinβ). */
export function detectorDirection(alphaDeg: number, betaDeg: number): Vec3 {
  const a = alphaDeg * DEG
  const b = betaDeg * DEG
  return [Math.sin(a) * Math.cos(b), -Math.cos(a) * Math.cos(b), Math.sin(b)]
}

/** Detector "up" (image-vertical) vector: up = (-sinα sinβ, cosα sinβ, cosβ). Orthogonal to d for all α, β. */
export function detectorUp(alphaDeg: number, betaDeg: number): Vec3 {
  const a = alphaDeg * DEG
  const b = betaDeg * DEG
  return [-Math.sin(a) * Math.sin(b), Math.cos(a) * Math.sin(b), Math.cos(b)]
}

/** X-ray tube position: source = iso - d·SOD, with iso at the origin. */
export function sourcePosition(alphaDeg: number, betaDeg: number, sod = SOD_MM): Vec3 {
  const d = detectorDirection(alphaDeg, betaDeg)
  return [-d[0] * sod, -d[1] * sod, -d[2] * sod]
}

/**
 * Vertical FOV (deg) of a camera at the source that sees exactly the detector square.
 * The detector half-size is DETECTOR_FOV/2 at distance SID from the source.
 */
export function verticalFovDeg(detectorFovMm = DETECTOR_FOV_MM, sidMm = SID_MM): number {
  return (2 * Math.atan(detectorFovMm / 2 / sidMm)) / DEG
}

/**
 * True spatial angular distance (deg) between two gantry poses: Δθ = angle(d_u, d_t).
 * Uses atan2(|d_u × d_t|, d_u · d_t), which is numerically stable for tiny angles (unlike acos).
 * Deliberately NOT |Δα| + |Δβ|, which over-penalises near ±CRA/CAU extremes.
 */
export function angularErrorDeg(aUser: number, bUser: number, aTarget: number, bTarget: number): number {
  const u = detectorDirection(aUser, bUser)
  const t = detectorDirection(aTarget, bTarget)
  const dot = u[0] * t[0] + u[1] * t[1] + u[2] * t[2]
  const cx = u[1] * t[2] - u[2] * t[1]
  const cy = u[2] * t[0] - u[0] * t[2]
  const cz = u[0] * t[1] - u[1] * t[0]
  return Math.atan2(Math.hypot(cx, cy, cz), dot) / DEG
}

/** Clinical label for a gantry pose, e.g. "LAO 45° / CAU 30°" or "AP 0° / 0°". */
export function formatView(alphaDeg: number, betaDeg: number): string {
  const a = Math.round(alphaDeg)
  const b = Math.round(betaDeg)
  const primary = a === 0 ? 'AP 0°' : `${a > 0 ? 'LAO' : 'RAO'} ${Math.abs(a)}°`
  const secondary = b === 0 ? '0°' : `${b > 0 ? 'CRA' : 'CAU'} ${Math.abs(b)}°`
  return `${primary} / ${secondary}`
}
