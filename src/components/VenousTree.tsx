import { Suspense, useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import type { ShaderMaterial } from 'three'
import { createAttenuatorMaterial, setAttenuatorLook } from '../lib/fluoroMaterial'
import { useVeinParts } from '../lib/veins'
import { useGantryStore, venousShown } from '../store/useGantryStore'

/**
 * Relative attenuation of the opacified venous return (1/mm). Lower than the arterial VESSEL_MU (0.6): the contrast has been diluted through
 * the capillary bed, so on a late-phase angiogram the coronary sinus and its tributaries read as a lighter grey than the arteries. Veins go
 * through exactly the same Beer-Lambert pass as the arteries (tube chord from the per-vertex radius and axis, multiplicative blend, no sorting).
 */
export const VEIN_MU = 0.3

function VenousMeshes() {
  const parts = useVeinParts()
  const materials = useMemo(() => {
    const m = new Map<string, ShaderMaterial>()
    for (const p of parts) m.set(p.id, createAttenuatorMaterial({ kind: 'tube', mu: VEIN_MU }))
    return m
  }, [parts])
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials])

  const highlightId = useGantryStore((s) => s.highlightId)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    for (const [id, mat] of materials) setAttenuatorLook(mat, !materials.has(highlightId ?? '') ? 'normal' : id === highlightId ? 'highlight' : 'dim')
    invalidate()
  }, [highlightId, materials, invalidate])

  // dispose={null}: geometries come from the shared, cached GLB and must outlive this component.
  return (
    <group dispose={null}>
      {parts.map((p) => (
        <mesh key={p.id} geometry={p.geometry} material={materials.get(p.id)} frustumCulled={false} />
      ))}
    </group>
  )
}

/**
 * The Explore-only coronary-sinus injection of the fluoro image (the arteries are not drawn then, see CoronaryTree). Mounted only while
 * `venousShown`, inside its own Suspense boundary so the model arriving never blanks the image.
 */
export function VenousTree() {
  const shown = useGantryStore(venousShown)
  if (!shown) return null
  return (
    <Suspense fallback={null}>
      <VenousMeshes />
    </Suspense>
  )
}
