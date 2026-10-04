import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import type { ShaderMaterial } from 'three'
import { createAttenuatorMaterial, setAttenuatorLook, setLesionUniforms } from '../lib/fluoroMaterial'
import { useResolvedLesion } from '../lib/lesion'
import { useHeartParts } from '../lib/heartModel'
import type { VesselId } from '../lib/heartIndex'
import { useGantryStore, venousShown } from '../store/useGantryStore'

/**
 * Relative attenuation coefficient of iodinated contrast (1/mm). Tuned visually: 0.36 read too pale, 0.6 gives
 * the charcoal cine look while thin distal branches (r ≈ 0.5 mm) stay light. See lib/fluoroMaterial.ts.
 */
export const VESSEL_MU = 0.6

/**
 * The opacified coronary tree of the injected vessel, from the anatomical model. Only the selected system is drawn
 * (the other is unopacified, i.e. invisible); the myocardial silhouette is drawn separately and stays visible in both.
 * One material per branch so the highlighted branch can be tinted independently while the rest are dimmed.
 */
export function CoronaryTree({ vessel }: { vessel: VesselId }) {
  const { coronary } = useHeartParts()
  const branches = useMemo(() => coronary.filter((c) => c.system === vessel), [coronary, vessel])
  const materials = useMemo(() => {
    const m = new Map<string, ShaderMaterial>()
    for (const b of branches) m.set(b.id, createAttenuatorMaterial({ kind: 'tube', mu: VESSEL_MU }))
    return m
  }, [branches])
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials])

  const highlightId = useGantryStore((s) => s.highlightId)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const anyHighlight = highlightId !== null && materials.has(highlightId)
    for (const [id, mat] of materials) {
      setAttenuatorLook(mat, !anyHighlight ? 'normal' : id === highlightId ? 'highlight' : 'dim')
    }
    invalidate()
  }, [highlightId, materials, invalidate])

  // Synthetic stenosis (runtime only): the branch it sits on gets the lesion uniforms, every other branch is untouched.
  const { lesion, params } = useResolvedLesion()
  useEffect(() => {
    for (const [id, mat] of materials) setLesionUniforms(mat, lesion && id === lesion.branchName ? params : null)
    invalidate()
  }, [lesion, params, materials, invalidate])

  // Explore coronary-sinus injection: only the veins are opacified, the LCA / RCA tree is not drawn at all.
  const venous = useGantryStore(venousShown)
  if (venous) return null

  // dispose={null}: geometries come from the shared, cached GLB and must outlive this component.
  return (
    <group dispose={null}>
      {branches.map((b) => (
        <mesh key={b.id} geometry={b.geometry} material={materials.get(b.id)} frustumCulled={false} />
      ))}
    </group>
  )
}
