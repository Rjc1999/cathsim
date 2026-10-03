import { useMemo } from 'react'
import { Vector3 } from 'three'
import { useGantryStore } from '../store/useGantryStore'
import { useLesionStore } from '../store/useLesionStore'
import type { SyntheticLesion } from '../types/lesion'
import type { LesionShaderParams } from './fluoroMaterial'
import { getTree } from './tree'

/** Direction the plaque of an eccentric lesion faces: patient left, so it reads as a one-sided notch in the AP view. */
const PLAQUE_SIDE = new Vector3(1, 0, 0)
const PLAQUE_SIDE_FALLBACK = new Vector3(0, -1, 0)

/**
 * Resolve a lesion on the ACTIVE case: the centre is the branch centerline at arc-length fraction t (LPS mm), the axis the
 * centerline tangent there. Returns null when this case has no such branch.
 */
export function resolveLesion(lesion: SyntheticLesion): LesionShaderParams | null {
  const branch = [...getTree('LCA'), ...getTree('RCA')].find((b) => b.id === lesion.branchName)
  if (!branch) return null
  const t = Math.min(1, Math.max(0, lesion.normalizedPosition))
  const pos = branch.curve.getPointAt(t)
  const axis = branch.curve.getTangentAt(t).normalize()
  // plaque side = the preferred direction with its component along the vessel removed
  let dir = PLAQUE_SIDE.clone().addScaledVector(axis, -PLAQUE_SIDE.dot(axis))
  if (dir.lengthSq() < 1e-3) dir = PLAQUE_SIDE_FALLBACK.clone().addScaledVector(axis, -PLAQUE_SIDE_FALLBACK.dot(axis))
  dir.normalize()
  return { pos, axis, dir, lengthMm: lesion.lengthMm, severity: lesion.severity, eccentric: lesion.morphology === 'eccentric' }
}

/** The active lesion resolved against the current case (recomputed when the lesion or the patient changes). */
export function useResolvedLesion(): { lesion: SyntheticLesion | null; params: LesionShaderParams | null } {
  const lesion = useLesionStore((s) => s.activeLesion)
  const caseId = useGantryStore((s) => s.currentCaseId)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveLesion reads the active case, which switches with currentCaseId
  const params = useMemo(() => (lesion && lesion.isActive ? resolveLesion(lesion) : null), [lesion, caseId])
  return { lesion, params }
}
