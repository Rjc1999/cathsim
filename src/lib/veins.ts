import { useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import type { BufferGeometry } from 'three'
import { useGantryStore, venousShown } from '../store/useGantryStore'
import { caseVeinsGlbUrl } from './heartIndex'
import { toBranch, type TreeBranch } from './tree'
import { getVeinIndex } from './veinData'

/** Branches of the venous overlay for the picker / label code; keyed by case, converted once. */
const cache = new Map<string, TreeBranch[]>()

/** Venous branches of a case (empty until the layer has been loaded once). Safe to call from event handlers. */
export function getVeinTree(caseId: string): TreeBranch[] {
  let tree = cache.get(caseId)
  if (!tree) {
    const idx = getVeinIndex(caseId)
    if (!idx) return []
    tree = idx.branches.map(toBranch)
    cache.set(caseId, tree)
  }
  return tree
}

const NONE: TreeBranch[] = []

/** The venous branches to draw / label / pick right now: empty unless the Explore venous layer is on. */
export function useVenousBranches(): TreeBranch[] {
  const shown = useGantryStore(venousShown)
  const caseId = useGantryStore((s) => s.currentCaseId)
  return useMemo(() => (shown ? getVeinTree(caseId) : NONE), [shown, caseId])
}

export interface VeinPart {
  id: string
  label: string
  geometry: BufferGeometry
}

/**
 * The venous meshes (suspends until the GLB is parsed; the layer is only mounted after preloadVeins, so this is normally instant).
 * Same vertex attributes as the coronary tubes: `_radius` / `_axis` are exposed to the attenuation shader as aRadius / aTangent.
 */
export function useVeinParts(): VeinPart[] {
  const caseId = useGantryStore((s) => s.currentCaseId)
  const gltf = useGLTF(caseVeinsGlbUrl(caseId), false)
  return useMemo(() => {
    const parts: VeinPart[] = []
    gltf.scene.traverse((o) => {
      const mesh = o as unknown as { isMesh?: boolean; geometry: BufferGeometry; userData: Record<string, unknown> }
      if (!mesh.isMesh) return
      const { kind, id, label } = mesh.userData as { kind?: string; id?: string; label?: string }
      if (kind !== 'venous' || !id) return
      const g = mesh.geometry
      const radius = g.getAttribute('_radius')
      const axis = g.getAttribute('_axis')
      if (radius && !g.getAttribute('aRadius')) g.setAttribute('aRadius', radius)
      if (axis && !g.getAttribute('aTangent')) g.setAttribute('aTangent', axis)
      parts.push({ id, label: label ?? id, geometry: g })
    })
    return parts
  }, [gltf])
}
