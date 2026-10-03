import { useMemo } from 'react'
import { CatmullRomCurve3, Vector3 } from 'three'
import type { Vec3 } from './gantry'
import { useGantryStore } from '../store/useGantryStore'
import { getActiveCaseId, getHeartIndex, type BranchIndex, type VesselId } from './heartIndex'

export type { VesselId }

export interface TreeBranch {
  id: string
  label: string
  vessel: VesselId
  /** Arc-length fraction where the label pill and its leader line are anchored. */
  labelT: number
  /** Smooth curve through the main-path centerline (LPS mm), parameterised by arc length. */
  curve: CatmullRomCurve3
  /** True 3D centerline length (mm). */
  length: number
  /** Main-path samples (origin → distal) and the lumen radius at each, used by the view analysis. */
  samples: Vec3[]
  sampleRadii: number[]
  /** All skeleton points of the branch group (main path plus unnamed twigs), used for tap hit-testing. */
  hitSamples: Vec3[]
}

/** Keyed by `${caseId}:${vessel}`, so switching patients never serves another patient's centerlines. */
const cache = new Map<string, TreeBranch[]>()

function toBranch(b: BranchIndex): TreeBranch {
  const pts = b.centerline.map(([x, y, z]) => new Vector3(x, y, z))
  // A degenerate (e.g. 2-point) centerline still needs a valid curve.
  if (pts.length < 2) pts.push(pts[0].clone().add(new Vector3(0.01, 0, 0)))
  const curve = new CatmullRomCurve3(pts, false, 'centripetal')
  return {
    id: b.id,
    label: b.label,
    vessel: b.system,
    labelT: b.labelT,
    curve,
    length: b.lengthMm,
    samples: b.centerline.map(([x, y, z]) => [x, y, z] as Vec3),
    sampleRadii: b.centerline.map((p) => p[3]),
    hitSamples: b.hit as Vec3[],
  }
}

/** Named branches of one coronary system of the active case, in anatomical order (from the case's index file). */
export function getTree(vessel: VesselId): TreeBranch[] {
  const key = `${getActiveCaseId()}:${vessel}`
  let tree = cache.get(key)
  if (!tree) {
    tree = getHeartIndex()
      .branches.filter((b) => b.system === vessel)
      .map(toBranch)
    cache.set(key, tree)
  }
  return tree
}

export const ALL_VESSELS: readonly VesselId[] = ['LCA', 'RCA']

/** The active case's branches, recomputed when the vessel or the patient changes. */
export function useTree(vessel: VesselId): TreeBranch[] {
  const caseId = useGantryStore((s) => s.currentCaseId)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- getTree reads the active case, which the store switches together with currentCaseId
  return useMemo(() => getTree(vessel), [vessel, caseId])
}
