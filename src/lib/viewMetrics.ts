import type { Vec3 } from './gantry'
import { detectorDirection, detectorUp } from './gantry'
import type { TreeBranch } from './tree'

/**
 * Diagnostics for a locked projection, computed from the centerline samples (no rendering involved).
 * Projection is orthographic along the detector direction: at a 720 mm source distance the perspective
 * correction over a ~120 mm heart is a few percent, well below the thresholds used for the feedback.
 */

export type ForeshorteningClass = 'open' | 'moderate' | 'foreshortened'
export type OverlapClass = 'partial' | 'overlapped'

export interface BranchForeshortening {
  id: string
  label: string
  /** Projected length / true length, 0..1 (1 = seen fully in profile). */
  ratio: number
  cls: ForeshorteningClass
}

export interface BranchOverlap {
  a: string
  b: string
  /** Fraction (0..1) of the shorter branch hidden behind the other in the projection. */
  fraction: number
  cls: OverlapClass
}

export interface ViewAnalysis {
  foreshortening: BranchForeshortening[]
  overlaps: BranchOverlap[]
}

export const FORESHORTENING_OPEN = 0.85
export const FORESHORTENING_MODERATE = 0.65
export const OVERLAP_REPORT_MIN = 0.15
export const OVERLAP_HEAVY = 0.4
/** Points closer than this in 3D belong to the same junction, not to a projected crossing (mm). */
const JUNCTION_MM = 10
/** Extra clearance added to the summed lumen radii when deciding two vessels visually overlap (mm). */
const OVERLAP_MARGIN_MM = 0.5

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function polylineLength(points: readonly (readonly number[])[]): number {
  let len = 0
  for (let i = 1; i < points.length; i++) {
    let s = 0
    for (let k = 0; k < points[i].length; k++) s += (points[i][k] - points[i - 1][k]) ** 2
    len += Math.sqrt(s)
  }
  return len
}

const classifyForeshortening = (r: number): ForeshorteningClass =>
  r >= FORESHORTENING_OPEN ? 'open' : r >= FORESHORTENING_MODERATE ? 'moderate' : 'foreshortened'

/** Fraction of `a`'s samples that lie within lumen distance of some sample of `b` in the image plane. */
function coveredFraction(
  a: { pts3: Vec3[]; pts2: [number, number][]; radii: number[] },
  b: { pts3: Vec3[]; pts2: [number, number][]; radii: number[] },
): number {
  let hit = 0
  for (let i = 0; i < a.pts2.length; i++) {
    for (let j = 0; j < b.pts2.length; j++) {
      const reach = a.radii[i] + b.radii[j] + OVERLAP_MARGIN_MM
      const dx = a.pts2[i][0] - b.pts2[j][0]
      const dy = a.pts2[i][1] - b.pts2[j][1]
      if (dx * dx + dy * dy < reach * reach && dist3(a.pts3[i], b.pts3[j]) > JUNCTION_MM) {
        hit++
        break
      }
    }
  }
  return hit / a.pts2.length
}

export function analyzeView(branches: readonly TreeBranch[], alphaDeg: number, betaDeg: number): ViewAnalysis {
  const d = detectorDirection(alphaDeg, betaDeg)
  const up = detectorUp(alphaDeg, betaDeg)
  const side = cross(d, up) // image-plane axes: (up, side) ⟂ d

  const projected = branches.map((b) => {
    const pts2 = b.samples.map((p): [number, number] => [dot(p, up), dot(p, side)])
    return { branch: b, pts3: b.samples, pts2, radii: b.sampleRadii }
  })

  const foreshortening: BranchForeshortening[] = projected.map(({ branch, pts3, pts2 }) => {
    const ratio = Math.min(1, polylineLength(pts2) / polylineLength(pts3))
    return { id: branch.id, label: branch.label, ratio, cls: classifyForeshortening(ratio) }
  })

  const overlaps: BranchOverlap[] = []
  for (let i = 0; i < projected.length; i++) {
    for (let j = i + 1; j < projected.length; j++) {
      const A = projected[i]
      const B = projected[j]
      const fraction = Math.max(coveredFraction(A, B), coveredFraction(B, A))
      if (fraction >= OVERLAP_REPORT_MIN) {
        overlaps.push({ a: A.branch.id, b: B.branch.id, fraction, cls: fraction >= OVERLAP_HEAVY ? 'overlapped' : 'partial' })
      }
    }
  }
  overlaps.sort((x, y) => y.fraction - x.fraction)

  return { foreshortening, overlaps }
}
