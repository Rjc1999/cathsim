import { detectorDirection, detectorUp, type Vec3 } from './gantry'
import type { VesselId } from './heartIndex'
import { getTree } from './tree'

/**
 * How well a gantry pose profiles ONE lesion (not a whole branch, as lib/viewMetrics.ts does): a 10 mm stenosis can sit on
 * a well-profiled branch and still be foreshortened or hidden behind another vessel. Two measures, both from the centerlines
 * (orthographic projection along the detector direction, the same approximation and thresholds as viewMetrics.ts):
 *  - foreshortening: projected / true length of the lesion segment (1 = seen in full profile);
 *  - clearance: image-plane gap (mm) between the lesion's lumen edge and the nearest OTHER vessel (negative = covered).
 */

/** Points closer than this in 3D to the lesion centre belong to its own junction / segment, not to a projected crossing (mm). */
const JUNCTION_MM = 10
/** Unnamed twigs carry no radius in the index; assume a thin lumen (mm). */
const TWIG_RADIUS_MM = 0.9
/** Twig skeleton points closer than this to an already kept blocker add nothing (mm). */
const DEDUPE_MM = 1.5
const WINDOW_POINTS = 5
const CLEARANCE_CAP_MM = 12

export const VIEW_GOOD = { foreshortening: 0.8, clearanceMm: 1.5 } as const
export const VIEW_POOR = { foreshortening: 0.6, clearanceMm: 0 } as const

export interface LesionSpec {
  system: VesselId
  branchId: string
  /** Arc-length fraction along the branch centerline (same convention as SyntheticLesion.normalizedPosition). */
  t: number
  lengthMm: number
}

export interface LesionContext {
  spec: LesionSpec
  /** Lesion centre and axis (unit tangent), LPS mm. */
  centre: Vec3
  axis: Vec3
  /** Points along the lesion segment, proximal to distal. */
  window: Vec3[]
  /** Normal lumen radius at the lesion (mm). */
  radius: number
  branchLengthMm: number
  /** Other vessels as flat arrays (x, y, z, radius) plus the owning branch id, for the clearance scan. */
  bx: Float64Array
  by: Float64Array
  bz: Float64Array
  br: Float64Array
  bid: string[]
}

export type ViewClass = 'good' | 'fair' | 'poor'

export interface LesionViewMetrics {
  /** Projected / true length of the lesion segment, 0..1. */
  foreshortening: number
  /** Gap to the nearest overlapping vessel (mm, image plane), capped at 12; negative = the lesion is covered. */
  clearanceMm: number
  /** Branch id of the nearest overlapping vessel (the lesion's own id when it folds over itself), or null when nothing is near. */
  blockerId: string | null
  /** Composite 0..1: 1 = fully profiled and clear. */
  score: number
  cls: ViewClass
}

export interface BestView {
  alpha: number
  beta: number
  metrics: LesionViewMetrics
  /** Fraction (0..1) of the searched poses that show this lesion clearly (score >= 0.7): a measure of how findable it is. */
  goodFraction: number
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function makeLesionContext(spec: LesionSpec): LesionContext {
  const tree = getTree(spec.system)
  const branch = tree.find((b) => b.id === spec.branchId)
  if (!branch) throw new Error(`Lesion branch ${spec.branchId} is not in the ${spec.system} tree`)
  const curveLen = branch.curve.getLength()
  const at = (u: number): Vec3 => {
    const p = branch.curve.getPointAt(Math.min(1, Math.max(0, u)))
    return [p.x, p.y, p.z]
  }
  const half = spec.lengthMm / curveLen / 2
  const window = Array.from({ length: WINDOW_POINTS }, (_, i) => at(spec.t - half + (2 * half * i) / (WINDOW_POINTS - 1)))
  const centre = at(spec.t)
  const tan = branch.curve.getTangentAt(Math.min(1, Math.max(0, spec.t)))
  const axis: Vec3 = [tan.x, tan.y, tan.z]
  const ri = Math.round(spec.t * (branch.sampleRadii.length - 1))
  const radius = branch.sampleRadii[Math.min(branch.sampleRadii.length - 1, Math.max(0, ri))]

  const pts: { p: Vec3; r: number; id: string }[] = []
  for (const b of tree) {
    b.samples.forEach((p, i) => {
      if (dist3(p, centre) >= JUNCTION_MM) pts.push({ p, r: b.sampleRadii[i], id: b.id })
    })
  }
  const mainCount = pts.length
  for (const b of tree) {
    for (const p of b.hitSamples) {
      if (dist3(p, centre) < JUNCTION_MM) continue
      let dup = false
      for (let i = 0; i < pts.length && !dup; i++) dup = dist3(p, pts[i].p) < DEDUPE_MM && (i < mainCount || pts[i].r === TWIG_RADIUS_MM)
      if (!dup) pts.push({ p, r: TWIG_RADIUS_MM, id: b.id })
    }
  }
  return {
    spec,
    centre,
    axis,
    window,
    radius,
    branchLengthMm: curveLen,
    bx: Float64Array.from(pts, (q) => q.p[0]),
    by: Float64Array.from(pts, (q) => q.p[1]),
    bz: Float64Array.from(pts, (q) => q.p[2]),
    br: Float64Array.from(pts, (q) => q.r),
    bid: pts.map((q) => q.id),
  }
}

const classify = (foreshortening: number, clearanceMm: number): ViewClass =>
  foreshortening >= VIEW_GOOD.foreshortening && clearanceMm >= VIEW_GOOD.clearanceMm
    ? 'good'
    : foreshortening < VIEW_POOR.foreshortening || clearanceMm < VIEW_POOR.clearanceMm
      ? 'poor'
      : 'fair'

/** Composite visibility: full marks at >= 85% length and >= 2 mm of clear background, falling to 0 at -1 mm (covered). */
const composite = (foreshortening: number, clearanceMm: number) => clamp01(foreshortening / 0.85) * clamp01((clearanceMm + 1) / 3)

export function evaluateView(ctx: LesionContext, alphaDeg: number, betaDeg: number): LesionViewMetrics {
  const d = detectorDirection(alphaDeg, betaDeg)
  const up = detectorUp(alphaDeg, betaDeg)
  const side = cross(d, up)
  const n = ctx.window.length
  const wu = new Float64Array(n)
  const ws = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    wu[i] = dot(ctx.window[i], up)
    ws[i] = dot(ctx.window[i], side)
  }

  let trueLen = 0
  let projLen = 0
  for (let i = 1; i < n; i++) {
    trueLen += dist3(ctx.window[i], ctx.window[i - 1])
    projLen += Math.hypot(wu[i] - wu[i - 1], ws[i] - ws[i - 1])
  }
  const foreshortening = trueLen > 0 ? Math.min(1, projLen / trueLen) : 1

  // gap(blocker) = min over window points of the 2D distance, minus both lumen radii: one sqrt per blocker.
  let clearance = CLEARANCE_CAP_MM
  let blocker = -1
  const { bx, by, bz, br } = ctx
  const [ux, uy, uz] = up
  const [sx, sy, sz] = side
  for (let k = 0; k < br.length; k++) {
    const bu = bx[k] * ux + by[k] * uy + bz[k] * uz
    const bs = bx[k] * sx + by[k] * sy + bz[k] * sz
    let m = Infinity
    for (let i = 0; i < n; i++) {
      const du = wu[i] - bu
      const ds = ws[i] - bs
      const q = du * du + ds * ds
      if (q < m) m = q
    }
    const gap = Math.sqrt(m) - ctx.radius - br[k]
    if (gap < clearance) {
      clearance = gap
      blocker = k
    }
  }
  return {
    foreshortening,
    clearanceMm: clearance,
    blockerId: blocker >= 0 ? ctx.bid[blocker] : null,
    score: composite(foreshortening, clearance),
    cls: classify(foreshortening, clearance),
  }
}

const ALPHAS = Array.from({ length: 15 }, (_, i) => -70 + 10 * i)
const BETAS = Array.from({ length: 9 }, (_, i) => -40 + 10 * i)

/**
 * Search the practical gantry range (RAO 70 .. LAO 70, CAU 40 .. CRA 40) on a 10° grid for the pose that profiles the lesion
 * best. The score is smoothed with its four neighbours so the answer is a forgiving region, not a one-degree needle, and ties
 * prefer smaller angles (what an operator would reach for first). Round-number angles also read like real console settings.
 */
export function findBestView(ctx: LesionContext): BestView {
  const na = ALPHAS.length
  const nb = BETAS.length
  const raw = new Float64Array(na * nb)
  for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) raw[i * nb + j] = evaluateView(ctx, ALPHAS[i], BETAS[j]).score
  let best = 0
  let bestVal = -Infinity
  let good = 0
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      const v = raw[i * nb + j]
      if (v >= 0.7) good++
      let sum = 2 * v
      let w = 2
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di
        const jj = j + dj
        if (ii >= 0 && ii < na && jj >= 0 && jj < nb) {
          sum += raw[ii * nb + jj]
          w++
        }
      }
      const val = sum / w - 0.0005 * Math.hypot(ALPHAS[i], BETAS[j])
      if (val > bestVal) {
        bestVal = val
        best = i * nb + j
      }
    }
  }
  const alpha = ALPHAS[Math.floor(best / nb)]
  const beta = BETAS[best % nb]
  return { alpha, beta, metrics: evaluateView(ctx, alpha, beta), goodFraction: good / (na * nb) }
}
