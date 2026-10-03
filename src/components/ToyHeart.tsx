import { useEffect, useMemo } from 'react'
import { Color, MeshStandardMaterial } from 'three'
import { useHeartParts } from '../lib/heartModel'
import { useGantryStore } from '../store/useGantryStore'

const LCA_COLOR = '#d31f3d' // crimson
const RCA_COLOR = '#ff7d1f' // vermilion / amber
const HIGHLIGHT_COLOR = '#00f0ff'
const DIM_COLOR = '#7a7a84'
/** Vessels are pushed out along their normals by this much (mm) so thin branches read at thumbnail size. */
const VESSEL_INFLATE_MM = 0.7

/** Soft matte "clay" shells. The myocardium carries per-vertex colour (terracotta ventricles, slate atria). */
const SILHOUETTE_LOOK: Record<string, { color: string; opacity: number }> = {
  // curated heart (heart.glb): Myocardium carries the terracotta ventricle / slate atrium vertex colours
  Myocardium: { color: '#ffffff', opacity: 0.5 },
  LeftAtrialAppendage: { color: '#8ea3bd', opacity: 0.6 },
  // multiplied by the per-chamber vertex colours baked into the CT case GLBs (terracotta ventricles, slate atria and great vessels)
  LV: { color: '#ffffff', opacity: 0.55 },
  RV: { color: '#ffffff', opacity: 0.5 },
  LA: { color: '#ffffff', opacity: 0.5 },
  RA: { color: '#ffffff', opacity: 0.5 },
  Aorta: { color: '#ffffff', opacity: 0.6 },
  PulmonaryTrunk: { color: '#ffffff', opacity: 0.55 },
}

/**
 * The lit "clay" teaching heart, built from the anatomical model: translucent chambers and great vessels, and the
 * fully shaded coronary branches. Vessels are opaque and drawn first; the translucent shells (front faces only, no
 * depth write) are drawn after, so a vessel behind the near wall shows through it tinted. That is the depth cue that
 * shows the RCA / LCx wrapping the AV groove to the back of the heart.
 */
export function ToyHeart() {
  const { silhouette, coronary } = useHeartParts()
  const highlightId = useGantryStore((s) => s.highlightId)

  const vesselMaterials = useMemo(
    () =>
      coronary.map((c) => {
        const base = new Color(c.system === 'LCA' ? LCA_COLOR : RCA_COLOR)
        let color = base
        let emissive = new Color('#000000')
        let glow = 0
        if (highlightId !== null) {
          if (c.id === highlightId) {
            color = new Color(HIGHLIGHT_COLOR)
            emissive = new Color(HIGHLIGHT_COLOR)
            glow = 0.85
          } else {
            color = base.clone().lerp(new Color(DIM_COLOR), 0.6)
          }
        }
        const m = new MeshStandardMaterial({ color, emissive, emissiveIntensity: glow, roughness: 0.55, metalness: 0.05 })
        m.onBeforeCompile = (shader) => {
          shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>\n  transformed += normal * ${VESSEL_INFLATE_MM.toFixed(2)};`,
          )
        }
        return m
      }),
    [coronary, highlightId],
  )
  useEffect(() => () => vesselMaterials.forEach((m) => m.dispose()), [vesselMaterials])

  return (
    // dispose={null}: geometries come from the shared, cached GLB and must outlive this component.
    <group dispose={null}>
      {coronary.map((c, i) => (
        <mesh key={`${c.system}_${c.id}`} geometry={c.geometry} material={vesselMaterials[i]} userData={{ branchId: c.id }} renderOrder={1} />
      ))}
      {silhouette.map((part) => {
        const look = SILHOUETTE_LOOK[part.id] ?? { color: '#a9b8cc', opacity: 0.6 }
        return (
          <mesh key={part.id} geometry={part.geometry} renderOrder={2}>
            <meshStandardMaterial
              color={part.hasColor ? look.color : '#8ea3bd'}
              vertexColors={part.hasColor}
              transparent
              opacity={look.opacity}
              depthWrite={false}
              roughness={0.92}
              metalness={0}
            />
          </mesh>
        )
      })}
    </group>
  )
}
