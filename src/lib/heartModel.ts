import { useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import type { BufferGeometry } from 'three'
import { useGantryStore } from '../store/useGantryStore'
import { caseGlbUrl, type VesselId } from './heartIndex'

export interface SilhouettePart {
  id: string
  geometry: BufferGeometry
  /** Whether the geometry carries per-vertex colours (atrial / ventricular split). */
  hasColor: boolean
}

export interface CoronaryPart {
  id: string
  system: VesselId
  geometry: BufferGeometry
}

export interface HeartParts {
  /** The individual translucent anatomical parts (toy twin). Their surfaces are hollow: chambers are empty inside the walls. */
  silhouette: SilhouettePart[]
  /** Watertight FILLED union of the silhouette parts, used for the fluoro soft-tissue shadow. */
  shadow: BufferGeometry
  coronary: CoronaryPart[]
}

/**
 * The current patient case (public/models/<case>.glb, from a contrast CT) split into its parts. The GLB is already in patient LPS millimetres
 * with the isocenter at the origin, so no transform is applied anywhere. Geometries are shared by every canvas (fluoro,
 * target preview, 3D twin); a Three object can only live in one scene, so each canvas builds its own meshes from them.
 *
 * Coronary meshes carry per-vertex `_radius` (local lumen radius, mm) and `_axis` (unit vessel direction), exposed to
 * the attenuation shader as `aRadius` / `aTangent`.
 */
export function useHeartParts(): HeartParts {
  // Draco off (we use meshopt, which drei's loader supports by default), so no decoder is fetched from a CDN.
  const caseId = useGantryStore((s) => s.currentCaseId)
  const gltf = useGLTF(caseGlbUrl(caseId), false)
  return useMemo(() => {
    const silhouette: SilhouettePart[] = []
    const coronary: CoronaryPart[] = []
    let shadow: BufferGeometry | null = null
    gltf.scene.traverse((o) => {
      const mesh = o as unknown as { isMesh?: boolean; geometry: BufferGeometry; userData: Record<string, unknown> }
      if (!mesh.isMesh) return
      const { kind, id, system } = mesh.userData as { kind?: string; id?: string; system?: VesselId }
      if (!kind || !id) return
      const g = mesh.geometry
      if (kind === 'coronary' && system) {
        const radius = g.getAttribute('_radius')
        const axis = g.getAttribute('_axis')
        if (radius && !g.getAttribute('aRadius')) g.setAttribute('aRadius', radius)
        if (axis && !g.getAttribute('aTangent')) g.setAttribute('aTangent', axis)
        coronary.push({ id, system, geometry: g })
      } else if (kind === 'shadow') {
        shadow = g
      } else if (kind === 'silhouette') {
        silhouette.push({ id, geometry: g, hasColor: !!g.getAttribute('color') })
      }
    })
    if (!shadow) throw new Error('the case GLB has no SoftTissueEnvelope node')
    return { silhouette, shadow, coronary }
  }, [gltf])
}
